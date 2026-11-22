import { describe, expect, it, vi } from "vitest";
import { DocumentNotFoundError } from "../ai-edition/document-service";
import { handleOpenEditorPackage, handlePackageProject, type PackageIpcDeps } from "./ipc";

const doc = { project: { id: "p1", title: "Demo" } } as never;

function deps(over: Partial<PackageIpcDeps> = {}): PackageIpcDeps {
	return {
		recordingsDir: "/rec",
		registryDir: "/default-rec",
		userDataDir: "/ud",
		appVersion: "9.9.9",
		listProjects: vi.fn(async () => [{ id: "a" }, { id: "b" }]),
		getProject: vi.fn(async () => doc),
		saveProject: vi.fn(async (d) => d),
		showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["/x/pkg.zip"] })),
		showItemInFolder: vi.fn(),
		sendProgress: vi.fn(),
		build: vi.fn(),
		open: vi.fn(),
		...over,
	};
}

describe("handlePackageProject", () => {
	it("builds with the configured roots, forwards progress, and reveals the zip", async () => {
		const build = vi.fn(async (input: { onProgress?: (p: unknown) => void }) => {
			input.onProgress?.({ copiedBytes: 1, totalBytes: 2 });
			return { ok: true as const, folderPath: "/f", zipPath: "/f.zip", totalBytes: 2 };
		});
		const d = deps({ build: build as never });
		const res = await handlePackageProject(d, "p1");
		expect(res).toMatchObject({ ok: true, zipPath: "/f.zip" });
		expect(d.getProject).toHaveBeenCalledWith("p1");
		expect(build).toHaveBeenCalledWith(
			expect.objectContaining({
				doc,
				outRoot: "/rec/Πακέτα",
				appVersion: "9.9.9",
			}),
		);
		expect(d.sendProgress).toHaveBeenCalledWith({ copiedBytes: 1, totalBytes: 2 });
		expect(d.showItemInFolder).toHaveBeenCalledWith("/f.zip");
	});

	it("does not reveal anything when the build fails", async () => {
		const d = deps({
			build: vi.fn(async () => ({ ok: false, reason: "missing-files", missing: ["a"] })) as never,
		});
		expect(await handlePackageProject(d, "p1")).toEqual({
			ok: false,
			reason: "missing-files",
			missing: ["a"],
		});
		expect(d.showItemInFolder).not.toHaveBeenCalled();
	});

	it("returns not-found for an unknown project", async () => {
		const d = deps({
			getProject: vi.fn(async () => {
				throw new DocumentNotFoundError("nope");
			}),
		});
		expect(await handlePackageProject(d, "nope")).toEqual({ ok: false, reason: "not-found" });
		expect(d.build).not.toHaveBeenCalled();
	});

	it("returns an error result when the build throws", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const d = deps({ build: vi.fn(async () => Promise.reject(new Error("disk full"))) as never });
		expect(await handlePackageProject(d, "p1")).toEqual({
			ok: false,
			reason: "error",
			message: "disk full",
		});
		expect(err).toHaveBeenCalled();
		err.mockRestore();
	});
});

describe("handleOpenEditorPackage", () => {
	it("returns cancelled when the dialog is cancelled", async () => {
		const d = deps({ showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) });
		expect(await handleOpenEditorPackage(d, {})).toEqual({ ok: false, reason: "cancelled" });
		expect(d.open).not.toHaveBeenCalled();
		expect(d.saveProject).not.toHaveBeenCalled();
	});

	it("shows the dialog without a source, opens with the roots, and saves once on ok", async () => {
		const open = vi.fn(async () => ({ ok: true as const, doc, folderPath: "/r/p" }));
		const d = deps({ open: open as never });
		const res = await handleOpenEditorPackage(d, {});
		expect(d.showOpenDialog).toHaveBeenCalledWith({
			properties: ["openFile", "openDirectory"],
			filters: [{ name: "Zip", extensions: ["zip"] }],
		});
		expect(open).toHaveBeenCalledWith({
			source: "/x/pkg.zip",
			receiveRoot: "/rec/Παραλαβές",
			graphicsCacheRoot: "/ud/graphics-cache",
			registryDir: "/default-rec",
			existingProjectIds: new Set(["a", "b"]),
			mode: undefined,
		});
		expect(d.saveProject).toHaveBeenCalledTimes(1);
		expect(d.saveProject).toHaveBeenCalledWith(doc);
		expect(res).toEqual({ ok: true, projectId: "p1", title: "Demo" });
	});

	it("reuses the source passed back with a mode, skipping the dialog", async () => {
		const open = vi.fn(async () => ({ ok: true as const, doc, folderPath: "/r/p" }));
		const d = deps({ open: open as never });
		await handleOpenEditorPackage(d, { source: "/y.zip", mode: "copy" });
		expect(d.showOpenDialog).not.toHaveBeenCalled();
		expect(open).toHaveBeenCalledWith(expect.objectContaining({ source: "/y.zip", mode: "copy" }));
	});

	it("passes a failure through without saving", async () => {
		const failure = {
			ok: false as const,
			reason: "exists" as const,
			projectId: "p1",
			title: "Demo",
		};
		const d = deps({ open: vi.fn(async () => failure) as never });
		// The picked file rides along, so the renderer can re-open it with a mode.
		expect(await handleOpenEditorPackage(d, {})).toEqual({ ...failure, source: "/x/pkg.zip" });
		expect(d.saveProject).not.toHaveBeenCalled();
	});

	it("passes other failures through unchanged", async () => {
		const failure = { ok: false as const, reason: "damaged" as const, detail: ["a"] };
		const d = deps({ open: vi.fn(async () => failure) as never });
		expect(await handleOpenEditorPackage(d, {})).toEqual(failure);
	});

	it("returns an error result when opening throws", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const d = deps({ open: vi.fn(async () => Promise.reject(new Error("EIO"))) as never });
		expect(await handleOpenEditorPackage(d, {})).toEqual({
			ok: false,
			reason: "error",
			message: "EIO",
		});
		err.mockRestore();
	});
});
