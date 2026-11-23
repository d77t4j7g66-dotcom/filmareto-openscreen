// @vitest-environment jsdom
// The Media tab's two ways out: "Remove from project" (one undo step, the file stays) and
// "Delete from disk" (confirmed by name, the file and its sidecars go to the Trash through main).

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: "en", setLocale: vi.fn() }),
	useScopedT: () => (key: string, vars?: Record<string, unknown>) =>
		vars ? `${key} ${JSON.stringify(vars)}` : key,
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// The save goes through main in the app; here it hands the document back.
vi.mock("@/native/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/native/client")>();
	return {
		...actual,
		nativeBridgeClient: {
			...actual.nativeBridgeClient,
			aiEdition: {
				...actual.nativeBridgeClient.aiEdition,
				save: vi.fn(async (document: unknown) => ({ success: true, document })),
			},
		},
	};
});

import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assetSchema, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { clearHistory, undo } from "@/lib/ai-edition/store/undo";
import { MediaStage } from "./MediaStage";

class StubResizeObserver {
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
}

const prepareMediaTrash = vi.fn();
const cancelMediaTrash = vi.fn(async () => undefined);
const commitMediaTrash = vi.fn();

function seed() {
	const base = createEmptyDocument({ projectId: "p", title: "t" });
	const assets = [
		assetSchema.parse({ id: "a1", label: "take", originalPath: "/rec/recording-1.mp4" }),
		assetSchema.parse({ id: "a2", label: "other", originalPath: "/rec/recording-2.mp4" }),
	];
	const clip = (id: string, assetId: string, at: number) => ({
		id,
		assetId,
		sourceStartSec: 0,
		sourceEndSec: 5,
		timelineStartSec: at,
		timelineEndSec: at + 5,
		origin: "user" as const,
	});
	useProjectStore.setState({
		projectId: "p",
		document: {
			...base,
			assets,
			timeline: {
				...base.timeline,
				clips: [clip("c1", "a1", 0), clip("c2", "a2", 5), clip("c3", "a1", 10)],
				trimRanges: [
					{
						id: "t1",
						assetId: "a1",
						clipId: "c1",
						startSec: 1,
						endSec: 2,
						origin: "user",
						reason: "",
					},
				],
			},
			zoomRanges: [
				{
					id: "z1",
					startMs: 10000,
					endMs: 12000,
					clipId: "c3",
					depth: 2,
					focus: { cx: 0.5, cy: 0.5 },
				},
			],
		} as unknown as typeof base,
	});
}

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	prepareMediaTrash.mockReset();
	cancelMediaTrash.mockClear();
	commitMediaTrash.mockReset();
	vi.mocked(toast.success).mockClear();
	vi.mocked(toast.info).mockClear();
	vi.mocked(toast.warning).mockClear();
	vi.mocked(toast.error).mockClear();
	window.electronAPI = {
		...window.electronAPI,
		prepareMediaTrash,
		cancelMediaTrash,
		commitMediaTrash,
	} as typeof window.electronAPI;
	clearHistory();
	seed();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	useProjectStore.setState({ document: null });
});

function renderStage() {
	return render(
		<TooltipProvider>
			<MediaStage onAddToTimeline={vi.fn(async () => undefined)} />
		</TooltipProvider>,
	);
}

/** The "⋯" of the item labelled `label`, opened, and its menu. */
function openMenu(label: string) {
	const card = screen.getByRole("button", { name: new RegExp(label) }).parentElement as HTMLElement;
	fireEvent.click(within(card).getByRole("button", { name: "mediaStage.moreActions" }));
	return screen.getByRole("menu");
}

const doc = () => useProjectStore.getState().document;

describe("MediaStage removing media", () => {
	it("removes the asset and every clip that uses it as one undo step, and leaves the file", async () => {
		renderStage();
		fireEvent.click(
			within(openMenu("take")).getByRole("menuitem", { name: "mediaStage.removeFromProject" }),
		);

		await waitFor(() => expect(doc()?.assets.map((a) => a.id)).toEqual(["a2"]));
		expect(doc()?.timeline.clips.map((c) => c.assetId)).toEqual(["a2"]);
		expect(prepareMediaTrash).not.toHaveBeenCalled();

		// One Cmd+Z brings the asset, both its clips (at their places), its trim and its zoom back.
		expect(undo()).toBe(true);
		expect(
			doc()
				?.assets.map((a) => a.id)
				.sort(),
		).toEqual(["a1", "a2"]);
		expect(doc()?.timeline.clips.map((c) => [c.id, c.timelineStartSec, c.timelineEndSec])).toEqual([
			["c1", 0, 5],
			["c2", 5, 10],
			["c3", 10, 15],
		]);
		expect(doc()?.timeline.trimRanges.map((t) => t.id)).toEqual(["t1"]);
		expect(doc()?.zoomRanges.map((z) => z.id)).toEqual(["z1"]);
	});

	it("asks by name, then removes the asset and sends it to main to be trashed", async () => {
		prepareMediaTrash.mockResolvedValue({
			token: "tok",
			files: ["/rec/recording-1.mp4", "/rec/recording-1.session.json"],
		});
		commitMediaTrash.mockResolvedValue({
			trashed: ["/rec/recording-1.mp4", "/rec/recording-1.session.json"],
			kept: [],
			shared: false,
			failedClosed: false,
		});
		renderStage();
		fireEvent.click(
			within(openMenu("take")).getByRole("menuitem", { name: "mediaStage.deleteFromDisk" }),
		);

		const dialog = await screen.findByRole("dialog");
		// The dialog lists every file that will go, as main resolved them from ids alone.
		expect(prepareMediaTrash).toHaveBeenCalledWith("p", "a1");
		expect(dialog.textContent).toContain("recording-1.mp4");
		expect(dialog.textContent).toContain("recording-1.session.json");
		// Nothing has happened before the confirmation.
		expect(doc()?.assets).toHaveLength(2);
		expect(commitMediaTrash).not.toHaveBeenCalled();

		fireEvent.click(within(dialog).getByRole("button", { name: "mediaStage.deleteDialogConfirm" }));

		await waitFor(() => expect(commitMediaTrash).toHaveBeenCalledWith("tok"));
		expect(doc()?.assets.map((a) => a.id)).toEqual(["a2"]);
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(
				expect.stringContaining("mediaStage.movedToTrash"),
			),
		);
	});

	it("says so, and trashes nothing, when a project still uses the file", async () => {
		prepareMediaTrash.mockResolvedValue({ token: "tok", files: ["/rec/recording-1.mp4"] });
		commitMediaTrash.mockResolvedValue({
			trashed: [],
			kept: [],
			shared: true,
			failedClosed: false,
		});
		renderStage();
		fireEvent.click(
			within(openMenu("take")).getByRole("menuitem", { name: "mediaStage.deleteFromDisk" }),
		);
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "mediaStage.deleteDialogConfirm" }));

		await waitFor(() =>
			expect(toast.info).toHaveBeenCalledWith(
				expect.stringContaining("mediaStage.removedStillUsed"),
			),
		);
		expect(toast.success).not.toHaveBeenCalled();
		// Still out of this project.
		expect(doc()?.assets.map((a) => a.id)).toEqual(["a2"]);
	});

	it("cancelling the dialog changes nothing", async () => {
		prepareMediaTrash.mockResolvedValue({ token: "tok", files: ["/rec/recording-1.mp4"] });
		renderStage();
		fireEvent.click(
			within(openMenu("take")).getByRole("menuitem", { name: "mediaStage.deleteFromDisk" }),
		);
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "actions.cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(doc()?.assets).toHaveLength(2);
		expect(cancelMediaTrash).toHaveBeenCalledWith("tok");
		expect(commitMediaTrash).not.toHaveBeenCalled();
	});

	it("shows no dialog and changes nothing when main will not delete the file", async () => {
		prepareMediaTrash.mockResolvedValue(null);
		renderStage();
		fireEvent.click(
			within(openMenu("take")).getByRole("menuitem", { name: "mediaStage.deleteFromDisk" }),
		);
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(doc()?.assets).toHaveLength(2);
	});
});
