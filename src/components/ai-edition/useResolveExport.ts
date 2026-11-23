import { useCallback, useEffect, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { ResolveExportDialogState } from "./ResolveExportDialog";

interface Options {
	/** Saves the open project. Resolves false when nothing was written. */
	save: () => Promise<boolean>;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** "Export for Resolve": the call into the main process, the `resolveExportEnabled` setting, and
 *  the state of the dialog that reports on it. */
export function useResolveExport({ save }: Options) {
	const t = useScopedT("editor");
	const [dialog, setDialog] = useState<ResolveExportDialogState | null>(null);
	const [enabled, setEnabled] = useState(false);
	const busy = useRef(false);
	const folder = useRef<string | null>(null);

	useEffect(() => {
		const api = window.electronAPI;
		if (!api) return;
		void api
			.getResolveExportEnabled?.()
			.then(setEnabled)
			.catch(() => undefined);
		return api.onResolveExportEnabledChanged?.(setEnabled);
	}, []);

	useEffect(
		() =>
			window.electronAPI?.onResolveExportProgress?.((progress) =>
				setDialog((prev) => (prev?.kind === "running" ? { kind: "running", progress } : prev)),
			),
		[],
	);

	const exportForResolve = useCallback(async () => {
		const api = window.electronAPI;
		const projectId = useProjectStore.getState().projectId;
		if (!api?.exportForResolve || !projectId || busy.current) return;
		busy.current = true;
		try {
			// The export reads the project from disk: a failed save would export a stale one.
			if (!(await save())) return;
			setDialog({ kind: "running", progress: { step: "start", done: 0, total: 0 } });
			const result = await api.exportForResolve(projectId);
			if (result.ok) {
				folder.current = result.folder;
				setDialog({
					kind: "done",
					folder: result.folder,
					warnings: result.warnings,
					restartNeeded: result.restartNeeded,
				});
			} else if (result.reason === "not-found") {
				setDialog({ kind: "error", reason: t("resolveExport.notFound") });
			} else if (result.reason === "disabled") {
				setDialog({ kind: "error", reason: t("resolveExport.disabled") });
			} else if (result.reason === "no-ffmpeg") {
				setDialog({ kind: "error", reason: t("resolveExport.noFfmpeg") });
			} else if (result.reason === "no-clips") {
				setDialog({ kind: "error", reason: t("resolveExport.noClips") });
			} else {
				setDialog({ kind: "error", reason: result.message });
			}
		} catch (error) {
			setDialog({ kind: "error", reason: messageOf(error) });
		} finally {
			busy.current = false;
		}
	}, [save, t]);

	const reveal = useCallback(() => {
		if (folder.current) void window.electronAPI?.revealInFolder?.(folder.current);
	}, []);

	// An export in flight is not dismissed; everything else is.
	const close = useCallback(() => {
		setDialog((prev) => (prev?.kind === "running" ? prev : null));
	}, []);

	useEffect(
		() => window.electronAPI?.onMenuExportForResolve?.(() => void exportForResolve()),
		[exportForResolve],
	);

	return { dialog, enabled, exportForResolve, reveal, close };
}
