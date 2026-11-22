import { useCallback, useEffect, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { PackageDialogState } from "./EditorPackageDialog";

type OpenResult = Awaited<ReturnType<Window["electronAPI"]["openEditorPackage"]>>;

interface Options {
	/** Saves the open project. Resolves false when nothing was written. */
	save: () => Promise<boolean>;
	/** Reads a project back from disk into the editor. */
	loadProject: (id: string) => Promise<void>;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** "Package for Editing" and "Open Package": the calls into the main process, and the state of
 *  the dialog that reports on them. Kept out of the shell, which only renders what this returns. */
export function useEditorPackage({ save, loadProject }: Options) {
	const t = useScopedT("editor");
	const [dialog, setDialog] = useState<PackageDialogState | null>(null);
	// The package a name clash was found in, handed back with the mode the user picks.
	const pendingSource = useRef<string | null>(null);
	const busy = useRef(false);

	useEffect(
		() =>
			window.electronAPI?.onEditorPackageProgress?.((progress) =>
				setDialog((prev) => (prev?.kind === "packing" ? { kind: "packing", progress } : prev)),
			),
		[],
	);

	const packageForEditing = useCallback(async () => {
		const api = window.electronAPI;
		const projectId = useProjectStore.getState().projectId;
		if (!api || !projectId || busy.current) return;
		busy.current = true;
		try {
			// A package of what is on disk: a failed save would hand the editor a stale project.
			if (!(await save())) return;
			setDialog({ kind: "packing", progress: { copiedBytes: 0, totalBytes: 0 } });
			const result = await api.packageProjectForEditor(projectId);
			if (result.ok) setDialog({ kind: "packed", zipPath: result.zipPath });
			else if (result.reason === "missing-files")
				setDialog({ kind: "missing", files: result.missing });
			else if (result.reason === "unsafe-path")
				setDialog({
					kind: "error",
					reason: `${t("editorPackage.unsafePath")} ${result.paths.join(", ")}`,
				});
			else if (result.reason === "not-found")
				setDialog({ kind: "error", reason: t("editorPackage.notFound") });
			else setDialog({ kind: "error", reason: result.message });
		} catch (error) {
			setDialog({ kind: "error", reason: messageOf(error) });
		} finally {
			busy.current = false;
		}
	}, [save, t]);

	const report = useCallback(
		async (result: OpenResult) => {
			if (result.ok) {
				// Always from disk: the editor's copy of this project (when it is the one open, or
				// was just replaced) is stale, and its next save would overwrite the import.
				await loadProject(result.projectId);
				// `loadProject` reports failure through the store, not by throwing.
				const after = useProjectStore.getState();
				if (after.status !== "ready" || after.projectId !== result.projectId) {
					const reason = after.error ?? t("editorPackage.reloadFailed");
					// The editor's copy is the stale one: nothing may save it over the import.
					useProjectStore.getState().clear();
					setDialog({ kind: "error", reason });
					return;
				}
				setDialog({ kind: "opened", title: result.title });
			} else if (result.reason === "exists") {
				pendingSource.current = result.source;
				setDialog({ kind: "conflict", title: result.title });
			} else if (result.reason === "cancelled") {
				setDialog(null);
			} else if (result.reason === "error") {
				setDialog({ kind: "error", reason: result.message });
			} else {
				const message =
					result.reason === "not-a-package"
						? t("editorPackage.notAPackage")
						: result.reason === "damaged"
							? t("editorPackage.damaged")
							: t("editorPackage.missingNoDetail");
				const detail = result.detail?.length ? ` ${result.detail.join(", ")}` : "";
				setDialog({ kind: "error", reason: `${message}${detail}` });
			}
		},
		[loadProject, t],
	);

	const run = useCallback(
		async (opts: { source?: string; mode?: "replace" | "copy" }) => {
			const api = window.electronAPI;
			if (!api || busy.current) return;
			busy.current = true;
			try {
				await report(await api.openEditorPackage(opts));
			} catch (error) {
				setDialog({ kind: "error", reason: messageOf(error) });
			} finally {
				busy.current = false;
			}
		},
		[report],
	);

	const openPackage = useCallback(() => run({}), [run]);

	const choose = useCallback(
		(mode: "replace" | "copy") => {
			const source = pendingSource.current;
			if (!source) return;
			pendingSource.current = null;
			setDialog(null);
			void run({ source, mode });
		},
		[run],
	);

	const reveal = useCallback(() => {
		if (dialog?.kind === "packed") void window.electronAPI?.revealInFolder?.(dialog.zipPath);
	}, [dialog]);

	// A pack in flight is not dismissed; everything else is.
	const close = useCallback(() => {
		setDialog((prev) => (prev?.kind === "packing" ? prev : null));
	}, []);

	useEffect(() => {
		const api = window.electronAPI;
		if (!api) return;
		const unsubscribers = [
			api.onMenuPackageForEditor?.(() => void packageForEditing()),
			api.onMenuOpenEditorPackage?.(() => void openPackage()),
		];
		return () => {
			for (const unsub of unsubscribers) unsub?.();
		};
	}, [packageForEditing, openPackage]);

	return { dialog, packageForEditing, openPackage, choose, reveal, close };
}
