// What Claude read in the captions: which word of a phrase matters, and which phrases earn an emoji.
//
// Kept beside the caption settings, in `legacyEditor`, for the same reason they live there: it round
// trips through save, load and undo. Words are named by when they are said, in milliseconds of their
// own recording, so nothing here copies the transcript or goes stale when a word's text is corrected.
// Re-transcribing moves the times, and a pick that no longer lands on a word simply does nothing.

import type { AxcutDocument } from "../schema";

export interface AssetCaptionInsights {
	keys: number[];
	emoji: Record<number, string>;
}

export type CaptionInsights = Record<string, AssetCaptionInsights>;

export function insightKey(startSec: number): number {
	return Math.round(startSec * 1000);
}

export function getCaptionInsights(document: AxcutDocument | null | undefined): CaptionInsights {
	const legacy = document?.legacyEditor as { captionInsights?: unknown } | null | undefined;
	const stored = legacy?.captionInsights;
	return stored && typeof stored === "object" ? (stored as CaptionInsights) : {};
}

export function withCaptionInsights(
	document: AxcutDocument,
	assetId: string,
	insights: AssetCaptionInsights,
): AxcutDocument {
	return {
		...document,
		legacyEditor: {
			...((document.legacyEditor as Record<string, unknown> | null) ?? {}),
			captionInsights: { ...getCaptionInsights(document), [assetId]: insights },
		} as Record<string, unknown>,
	};
}
