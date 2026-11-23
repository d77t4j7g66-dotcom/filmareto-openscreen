import { clipOfRegion, mainTakeIsCamera } from "@/lib/ai-edition/document/cameraTake";
import type { AxcutAsset } from "@/lib/ai-edition/schema";

/**
 * Where a selected camera-lane zoom's manual focus is picked, and what must stay out of the way.
 * Auto follows the face: nothing is picked, so no overlay and no handle is removed. An unset mode
 * is Manual, as the scene reads it.
 */
export function cameraZoomPicking<T extends { focusMode?: "manual" | "auto" }>(
	region: T | null,
	onMainPicture: boolean,
): { onScreen: T | null; onCamera: T | null; blocksLayoutHandles: boolean } {
	if (!region || region.focusMode === "auto") {
		return { onScreen: null, onCamera: null, blocksLayoutHandles: false };
	}
	return onMainPicture
		? { onScreen: region, onCamera: null, blocksLayoutHandles: false }
		: { onScreen: null, onCamera: region, blocksLayoutHandles: true };
}

/**
 * The selected camera zoom zooms the main picture (its clip is a talking head, whose picture is
 * the camera) rather than the camera box. Judged on the zoom's own clip, its anchor else the clip
 * at its start, the way the scene routes it, not on the clip under the playhead; that one decides
 * only when the zoom's clip is not found.
 */
export function cameraZoomOnMainPicture(
	assets: readonly AxcutAsset[],
	clips: readonly {
		id: string;
		assetId: string;
		timelineStartSec: number;
		timelineEndSec: number;
	}[],
	region: { clipId?: string | null; startMs: number } | null,
	playheadClip: { assetId: string } | null,
): boolean {
	const clip = (region ? clipOfRegion(clips, region) : undefined) ?? playheadClip;
	return !!clip && mainTakeIsCamera(assets.find((asset) => asset.id === clip.assetId));
}
