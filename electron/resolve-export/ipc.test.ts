import { describe, expect, it, vi } from "vitest";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import { DocumentNotFoundError } from "../ai-edition/document-service";
import { handleExportForResolve, type ResolveExportIpcDeps } from "./ipc";

function makeDeps(over: Partial<ResolveExportIpcDeps> = {}): ResolveExportIpcDeps {
	return {
		isEnabled: () => true,
		recordingsDir: "/rec",
		resolveDir: "/res",
		resolveUserDir: "/user",
		ffmpegPath: () => "/ffmpeg",
		getProject: vi.fn(async () => ({ project: { id: "p" } }) as unknown as AxcutDocument),
		showItemInFolder: vi.fn(),
		sendProgress: vi.fn(),
		buildDeps: {} as ResolveExportIpcDeps["buildDeps"],
		build: vi.fn(async () => ({
			ok: true as const,
			folder: "/rec/Resolve/x",
			restartNeeded: false,
			warnings: [],
		})),
		...over,
	};
}

describe("handleExportForResolve", () => {
	it("refuses while the setting is off, without reading the project", async () => {
		const deps = makeDeps({ isEnabled: () => false });
		expect(await handleExportForResolve(deps, "p")).toEqual({ ok: false, reason: "disabled" });
		expect(deps.getProject).not.toHaveBeenCalled();
		expect(deps.build).not.toHaveBeenCalled();
	});

	it("reports a missing project", async () => {
		const deps = makeDeps({
			getProject: async () => {
				throw new DocumentNotFoundError("p");
			},
		});
		expect(await handleExportForResolve(deps, "p")).toEqual({ ok: false, reason: "not-found" });
	});

	it("builds into <recordings>/Resolve and reveals the folder", async () => {
		const deps = makeDeps();
		const result = await handleExportForResolve(deps, "p");
		expect(result).toMatchObject({ ok: true, folder: "/rec/Resolve/x" });
		expect(deps.build).toHaveBeenCalledWith(
			expect.objectContaining({
				outRoot: "/rec/Resolve",
				ffmpegPath: "/ffmpeg",
				resolveDir: "/res",
				resolveUserDir: "/user",
			}),
		);
		expect(deps.showItemInFolder).toHaveBeenCalledWith("/rec/Resolve/x");
	});

	it("turns a throw into an error result and does not reveal anything", async () => {
		const deps = makeDeps({
			build: async () => {
				throw new Error("boom");
			},
		});
		expect(await handleExportForResolve(deps, "p")).toEqual({
			ok: false,
			reason: "error",
			message: "boom",
		});
		expect(deps.showItemInFolder).not.toHaveBeenCalled();
	});
});
