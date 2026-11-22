// The IPC handlers for editor packages, as plain functions with their dependencies passed in, so
// they run without Electron. `ipc/handlers.ts` supplies the real ones.

import path from "node:path";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import { DocumentNotFoundError } from "../ai-edition/document-service";
import type { BuildPackageInput, BuildPackageResult, PackageProgress } from "./buildPackage";
import type { OpenPackageInput, OpenPackageResult } from "./openPackage";

export type PackageIpcResult =
	| BuildPackageResult
	| { ok: false; reason: "not-found" }
	| { ok: false; reason: "error"; message: string };

export type OpenPackageIpcResult =
	| { ok: true; projectId: string; title: string }
	| Exclude<OpenPackageResult, { ok: true } | { ok: false; reason: "exists" }>
	// Carries the source that was opened, so the renderer can send it back with the chosen mode
	// instead of showing the file dialog again.
	| { ok: false; reason: "exists"; projectId: string; title: string; source: string }
	| { ok: false; reason: "cancelled" }
	| { ok: false; reason: "error"; message: string };

export interface PackageIpcDeps {
	/** The recordings folder: packages go to `Πακέτα/`, received ones to `Παραλαβές/`. */
	recordingsDir: string;
	/** Where the media-links registry lives (the default recordings folder). */
	registryDir: string;
	userDataDir: string;
	appVersion: string;
	listProjects: () => Promise<Array<{ id: string }>>;
	getProject: (id: string) => Promise<AxcutDocument>;
	saveProject: (doc: AxcutDocument) => Promise<unknown>;
	showOpenDialog: (options: {
		properties: Array<"openFile" | "openDirectory">;
		filters: Array<{ name: string; extensions: string[] }>;
	}) => Promise<{ canceled: boolean; filePaths: string[] }>;
	showItemInFolder: (fullPath: string) => void;
	sendProgress: (progress: PackageProgress) => void;
	build: (input: BuildPackageInput) => Promise<BuildPackageResult>;
	open: (input: OpenPackageInput) => Promise<OpenPackageResult>;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function handlePackageProject(
	deps: PackageIpcDeps,
	projectId: string,
): Promise<PackageIpcResult> {
	try {
		let doc: AxcutDocument;
		try {
			doc = await deps.getProject(projectId);
		} catch (error) {
			if (error instanceof DocumentNotFoundError) return { ok: false, reason: "not-found" };
			throw error;
		}
		const result = await deps.build({
			doc,
			outRoot: path.join(deps.recordingsDir, "Πακέτα"),
			appVersion: deps.appVersion,
			onProgress: deps.sendProgress,
		});
		if (result.ok) deps.showItemInFolder(result.zipPath);
		return result;
	} catch (error) {
		console.error("Failed to package project for editing:", error);
		return { ok: false, reason: "error", message: messageOf(error) };
	}
}

export async function handleOpenEditorPackage(
	deps: PackageIpcDeps,
	opts: { source?: string; mode?: "replace" | "copy" },
): Promise<OpenPackageIpcResult> {
	try {
		let source = opts.source;
		if (!source) {
			const picked = await deps.showOpenDialog({
				properties: ["openFile", "openDirectory"],
				filters: [{ name: "Zip", extensions: ["zip"] }],
			});
			if (picked.canceled || picked.filePaths.length === 0) {
				return { ok: false, reason: "cancelled" };
			}
			source = picked.filePaths[0];
		}
		const result = await deps.open({
			source,
			receiveRoot: path.join(deps.recordingsDir, "Παραλαβές"),
			graphicsCacheRoot: path.join(deps.userDataDir, "graphics-cache"),
			registryDir: deps.registryDir,
			existingProjectIds: new Set((await deps.listProjects()).map((p) => p.id)),
			mode: opts.mode,
		});
		if (!result.ok) return result.reason === "exists" ? { ...result, source } : result;
		await deps.saveProject(result.doc);
		return { ok: true, projectId: result.doc.project.id, title: result.doc.project.title };
	} catch (error) {
		console.error("Failed to open editor package:", error);
		return { ok: false, reason: "error", message: messageOf(error) };
	}
}
