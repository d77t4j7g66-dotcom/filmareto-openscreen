import type { AxcutDocument } from "../schema";
import { removeClip } from "./timeline";

/** `doc` without the asset, its clips, trims and audio tracks. */
export function documentWithoutAsset(doc: AxcutDocument, assetId: string): AxcutDocument {
	const assets = doc.assets.filter((a) => a.id !== assetId);
	// Primary is the thing the timeline is built around, so it must fall to the
	// next VIDEO asset — never an audio overlay (issue #350), which can't be
	// primary (see addAsset). Falling back to `assets[0]` would hand primary to
	// an audio asset when the removed one was the last video.
	const primaryAssetId =
		doc.project.primaryAssetId === assetId
			? (assets.find((a) => a.kind !== "audio")?.id ?? undefined)
			: doc.project.primaryAssetId;
	const withoutAssetClips = doc.timeline.clips
		.filter((clip) => clip.assetId === assetId)
		.reduce((current, clip) => removeClip(current, clip.id), doc);
	return {
		...withoutAssetClips,
		assets,
		// Drop imported audio tracks that referenced the removed asset — they
		// would otherwise dangle, pointing at an asset the document no longer has.
		audioTracks: withoutAssetClips.audioTracks.filter((t) => t.assetId !== assetId),
		timeline: {
			...withoutAssetClips.timeline,
			trimRanges: withoutAssetClips.timeline.trimRanges.filter((r) => r.assetId !== assetId),
		},
		project: {
			...withoutAssetClips.project,
			primaryAssetId,
			updatedAt: new Date().toISOString(),
		},
	};
}
