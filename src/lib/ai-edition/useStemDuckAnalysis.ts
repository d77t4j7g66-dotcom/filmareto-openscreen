import { useEffect } from "react";
import type { DuckRegion } from "./recordingDuck";
import { useProjectStore } from "./store/projectStore";
import { applySettingsPatch } from "./store/settingsPatch";

/**
 * Writes, once, where the voice of a take with separate tracks speaks, so the system audio can
 * dip under it (see `recordingDuck.ts`). Runs when the take is open and has no stretches yet
 * (`regions === null`). The write is part of opening the take, not an edit: it is not an undo
 * step, or undoing it would only trigger the analysis again.
 */
export function useStemDuckAnalysis(
	hasStems: boolean,
	filePath: string | null | undefined,
	regions: DuckRegion[] | null,
): void {
	useEffect(() => {
		if (!hasStems || !filePath || regions !== null) return;
		let cancelled = false;
		void window.electronAPI
			?.analyseVoiceRegions?.(filePath)
			.then((result) => {
				if (cancelled || !result?.success || !result.regions) return;
				const store = useProjectStore.getState();
				const document = store.document;
				if (!document) return;
				const next = applySettingsPatch(document, { recordingDuckRegions: result.regions });
				store.setDocument(next, { history: false });
				void store.saveDocument(next, { history: false });
			})
			.catch(() => {
				// No analysis: the take plays and exports as recorded.
			});
		return () => {
			cancelled = true;
		};
	}, [hasStems, filePath, regions]);
}
