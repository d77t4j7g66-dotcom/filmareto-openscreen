import type { AxcutDocument } from "../schema";

/**
 * The assets a document uses: what a clip shows, the other attempts kept on a clip, and the
 * audio tracks. The recordings cleanup (`electron/media-cleanup`) asks the same question, so
 * both read it here.
 */
export function usedAssetIds(doc: AxcutDocument): Set<string> {
	const used = new Set<string>();
	for (const clip of doc.timeline.clips) {
		used.add(clip.assetId);
		for (const alternate of clip.alternates ?? []) used.add(alternate.assetId ?? clip.assetId);
	}
	for (const track of doc.audioTracks ?? []) used.add(track.assetId);
	return used;
}

/**
 * `after` with every asset that `before` used and `after` no longer does marked as discarded:
 * the user deleted the last clip of that take. Marked in the same document change as the
 * delete, so Undo takes the mark back with the clip. Only a marked take ever leaves the disk,
 * never one that simply waits in the media library or a take whose import was cut short.
 */
export function markDiscardedTakes(
	before: AxcutDocument,
	after: AxcutDocument,
	at: string,
): AxcutDocument {
	const was = usedAssetIds(before);
	const is = usedAssetIds(after);
	if (![...was].some((id) => !is.has(id))) return after;
	return {
		...after,
		assets: after.assets.map((asset) =>
			was.has(asset.id) && !is.has(asset.id) ? { ...asset, discardedAt: at } : asset,
		),
	};
}
