// @vitest-environment jsdom
// "Import media" on the Media tab. With no project open it used to be a dead button (disabled
// without looking it); it now starts a project, as the empty state's "Import video" does.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: "en", setLocale: vi.fn() }),
	useScopedT: () => (key: string, vars?: Record<string, unknown>) =>
		vars ? `${key} ${JSON.stringify(vars)}` : key,
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { MediaStage } from "./MediaStage";

class StubResizeObserver {
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
}

const order: string[] = [];
const addAsset = vi.fn(async (_path: string, _label?: string) => {
	order.push("addAsset");
	return null;
});
const createProject = vi.fn(async (title?: string) => {
	order.push("createProject");
	const document = createEmptyDocument({ projectId: "new", title: title ?? "t" });
	useProjectStore.setState({ projectId: "new", document });
	return document;
});
const openVideoFilePicker = vi.fn();

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	order.length = 0;
	addAsset.mockClear();
	createProject.mockClear();
	openVideoFilePicker.mockReset();
	vi.mocked(toast.error).mockClear();
	vi.mocked(toast.success).mockClear();
	window.electronAPI = { ...window.electronAPI, openVideoFilePicker } as typeof window.electronAPI;
	useProjectStore.setState({ projectId: null, document: null, addAsset, createProject });
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	useProjectStore.setState({ projectId: null, document: null });
});

function renderStage() {
	return render(
		<TooltipProvider>
			<MediaStage onAddToTimeline={vi.fn(async () => undefined)} />
		</TooltipProvider>,
	);
}

const importButton = () => screen.getByRole("button", { name: "mediaStage.importMedia" });

describe("Import media", () => {
	it("starts a project when none is open, then adds the picked video to it", async () => {
		openVideoFilePicker.mockResolvedValue({
			success: true,
			path: "/rec/clip.mov",
			name: "clip.mov",
		});
		renderStage();
		expect(importButton()).toBeEnabled();
		fireEvent.click(importButton());
		await waitFor(() => expect(addAsset).toHaveBeenCalledWith("/rec/clip.mov", "clip.mov"));
		expect(createProject).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["createProject", "addAsset"]);
	});

	it("keeps the open project instead of starting another", async () => {
		const document = createEmptyDocument({ projectId: "p", title: "t" });
		useProjectStore.setState({ projectId: "p", document });
		openVideoFilePicker.mockResolvedValue({
			success: true,
			path: "/rec/clip.mov",
			name: "clip.mov",
		});
		renderStage();
		fireEvent.click(importButton());
		await waitFor(() => expect(addAsset).toHaveBeenCalled());
		expect(createProject).not.toHaveBeenCalled();
	});

	it("says why when the picked file is refused, and stays quiet when cancelled", async () => {
		openVideoFilePicker.mockResolvedValue({
			success: false,
			message: "Selected file is not a supported readable video file",
		});
		renderStage();
		fireEvent.click(importButton());
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(addAsset).not.toHaveBeenCalled();
		expect(createProject).not.toHaveBeenCalled();

		vi.mocked(toast.error).mockClear();
		openVideoFilePicker.mockResolvedValue({ success: false, canceled: true });
		fireEvent.click(importButton());
		await waitFor(() => expect(openVideoFilePicker).toHaveBeenCalledTimes(2));
		expect(toast.error).not.toHaveBeenCalled();
	});
});
