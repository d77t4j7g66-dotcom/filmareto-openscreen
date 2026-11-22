// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useEditorPackage } from "./useEditorPackage";

const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider>{children}</I18nProvider>;

const api = {
	packageProjectForEditor: vi.fn(),
	openEditorPackage: vi.fn(),
	onEditorPackageProgress: vi.fn(() => () => undefined),
	onMenuPackageForEditor: vi.fn(() => () => undefined),
	onMenuOpenEditorPackage: vi.fn(() => () => undefined),
	revealInFolder: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
	useProjectStore.setState({ projectId: "p1", status: "ready", error: null });
});
afterEach(() => {
	useProjectStore.setState({ projectId: null });
});

describe("useEditorPackage", () => {
	it("does nothing without a current project", async () => {
		useProjectStore.setState({ projectId: null });
		const save = vi.fn(async () => true);
		const { result } = renderHook(() => useEditorPackage({ save, loadProject: vi.fn() }), {
			wrapper,
		});
		await act(() => result.current.packageForEditing());
		expect(save).not.toHaveBeenCalled();
		expect(api.packageProjectForEditor).not.toHaveBeenCalled();
		expect(result.current.dialog).toBeNull();
	});

	it("packs only after a successful save", async () => {
		const save = vi.fn(async () => false);
		const { result } = renderHook(() => useEditorPackage({ save, loadProject: vi.fn() }), {
			wrapper,
		});
		await act(() => result.current.packageForEditing());
		expect(api.packageProjectForEditor).not.toHaveBeenCalled();

		save.mockResolvedValue(true);
		api.packageProjectForEditor.mockResolvedValue({
			ok: true,
			zipPath: "/z.zip",
			folderPath: "/f",
			totalBytes: 1,
		});
		await act(() => result.current.packageForEditing());
		expect(api.packageProjectForEditor).toHaveBeenCalledWith("p1");
		expect(result.current.dialog).toEqual({ kind: "packed", zipPath: "/z.zip" });
	});

	it("re-opens a clashing package from the same source with the chosen mode, then reloads from disk", async () => {
		const loadProject = vi.fn(async () => undefined);
		api.openEditorPackage
			.mockResolvedValueOnce({
				ok: false,
				reason: "exists",
				projectId: "p1",
				title: "Film",
				source: "/in.zip",
			})
			.mockResolvedValueOnce({ ok: true, projectId: "p1", title: "Film" });
		const { result } = renderHook(() => useEditorPackage({ save: vi.fn(), loadProject }), {
			wrapper,
		});
		await act(() => result.current.openPackage());
		expect(result.current.dialog).toEqual({ kind: "conflict", title: "Film" });
		expect(loadProject).not.toHaveBeenCalled();

		act(() => result.current.choose("replace"));
		await waitFor(() => expect(result.current.dialog).toEqual({ kind: "opened", title: "Film" }));
		expect(api.openEditorPackage).toHaveBeenLastCalledWith({ source: "/in.zip", mode: "replace" });
		expect(loadProject).toHaveBeenCalledWith("p1");
	});

	it("reports a reload that left the store in error instead of success", async () => {
		const loadProject = vi.fn(async () => {
			useProjectStore.setState({ status: "error", error: "Failed to load project" });
		});
		api.openEditorPackage.mockResolvedValueOnce({ ok: true, projectId: "p1", title: "Film" });
		const { result } = renderHook(() => useEditorPackage({ save: vi.fn(), loadProject }), {
			wrapper,
		});
		await act(() => result.current.openPackage());
		expect(result.current.dialog).toEqual({ kind: "error", reason: "Failed to load project" });
	});

	it("drops the stale document after a failed reload so nothing can save it", async () => {
		useProjectStore.setState({
			projectId: "p1",
			document: { project: { id: "p1" } } as never,
			status: "ready",
			dirty: true,
		});
		const loadProject = vi.fn(async () => {
			useProjectStore.setState({ status: "error", error: "Failed to load project" });
		});
		api.openEditorPackage.mockResolvedValueOnce({ ok: true, projectId: "p1", title: "Film" });
		const { result } = renderHook(() => useEditorPackage({ save: vi.fn(), loadProject }), {
			wrapper,
		});
		await act(() => result.current.openPackage());
		const state = useProjectStore.getState();
		expect(state.document).toBeNull();
		expect(state.projectId).toBeNull();
		expect(result.current.dialog).toEqual({ kind: "error", reason: "Failed to load project" });
	});

	it("words a package with missing files as an open error listing the names", async () => {
		api.openEditorPackage.mockResolvedValueOnce({
			ok: false,
			reason: "missing-files",
			detail: ["a.mp4", "b.wav"],
		});
		const { result } = renderHook(() => useEditorPackage({ save: vi.fn(), loadProject: vi.fn() }), {
			wrapper,
		});
		await act(() => result.current.openPackage());
		const d = result.current.dialog;
		expect(d?.kind).toBe("error");
		expect(d?.kind === "error" && d.reason).toContain("a.mp4, b.wav");
		expect(d?.kind === "error" && d.reason).not.toMatch(/not created/i);
	});

	it("lists the names a damaged package reports and stays quiet on cancel", async () => {
		api.openEditorPackage.mockResolvedValueOnce({
			ok: false,
			reason: "damaged",
			detail: ["a.mp4"],
		});
		const { result } = renderHook(() => useEditorPackage({ save: vi.fn(), loadProject: vi.fn() }), {
			wrapper,
		});
		await act(() => result.current.openPackage());
		expect(result.current.dialog).toMatchObject({
			kind: "error",
			reason: expect.stringContaining("a.mp4"),
		});

		api.openEditorPackage.mockResolvedValueOnce({ ok: false, reason: "cancelled" });
		await act(() => result.current.openPackage());
		expect(result.current.dialog).toBeNull();
	});
});
