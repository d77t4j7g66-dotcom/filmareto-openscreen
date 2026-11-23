// The IPC handler for "Export for Resolve", as a plain function with its dependencies passed in,
// so it runs without Electron. `ipc/handlers.ts` supplies the real ones.

import path from "node:path";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import { DocumentNotFoundError } from "../ai-edition/document-service";
import type {
	BuildResolveExportDeps,
	BuildResolveExportInput,
	BuildResolveExportResult,
	ResolveExportProgress,
} from "./build";

export type ResolveExportIpcResult =
	| Extract<BuildResolveExportResult, { ok: true }>
	| { ok: false; reason: "no-clips"; message: string }
	| { ok: false; reason: "error"; message: string }
	| { ok: false; reason: "not-found" }
	| { ok: false; reason: "disabled" }
	| { ok: false; reason: "no-ffmpeg" };

export interface ResolveExportIpcDeps {
	/** The `resolveExportEnabled` setting. */
	isEnabled: () => boolean;
	recordingsDir: string;
	resolveDir: string;
	resolveUserDir: string;
	ffmpegPath: () => string | null;
	getProject: (id: string) => Promise<AxcutDocument>;
	showItemInFolder: (fullPath: string) => void;
	sendProgress: (progress: ResolveExportProgress) => void;
	buildDeps: BuildResolveExportDeps;
	build: (input: BuildResolveExportInput) => Promise<BuildResolveExportResult>;
}

export async function handleExportForResolve(
	deps: ResolveExportIpcDeps,
	projectId: string,
): Promise<ResolveExportIpcResult> {
	// The renderer hides the menu items while the setting is off; this is the guard behind them.
	if (!deps.isEnabled()) return { ok: false, reason: "disabled" };
	try {
		let doc: AxcutDocument;
		try {
			doc = await deps.getProject(projectId);
		} catch (error) {
			if (error instanceof DocumentNotFoundError) return { ok: false, reason: "not-found" };
			throw error;
		}
		const ffmpegPath = deps.ffmpegPath();
		if (!ffmpegPath) return { ok: false, reason: "no-ffmpeg" };
		const result = await deps.build({
			doc,
			outRoot: path.join(deps.recordingsDir, "Resolve"),
			ffmpegPath,
			resolveDir: deps.resolveDir,
			resolveUserDir: deps.resolveUserDir,
			deps: deps.buildDeps,
			onProgress: deps.sendProgress,
		});
		if (result.ok) deps.showItemInFolder(result.folder);
		return result;
	} catch (error) {
		console.error("Failed to export for Resolve:", error);
		return {
			ok: false,
			reason: "error",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}
