/** Kept apart from `framePosition` so the schema can use it without that module's imports. */

import type { AxcutAsset } from "../schema";

/**
 * The take's own picture is a camera: there is no camera beside it and no pointer in it.
 *
 * The document says so in two places. `cameraTrack` is a screen take's camera, recorded beside
 * the screen. `face` is only ever written for a take with no camera of its own and no recorded
 * pointer (`useTimeline` looks for the face once per such take), so a take with a value there,
 * `null` included (looked, no face found, or no helper to look with), has no pointer to follow.
 * Absent means a take with a recorded pointer, or one not looked at yet: a screen.
 *
 * ponytail: a screen take recorded with the system cursor (no pointer file) is looked at too and
 * counts as a camera take here. Nothing in the document tells it from a talking head; a marker
 * written at recording time would.
 */
export function mainTakeIsCamera(asset: AxcutAsset | null | undefined): boolean {
	return (
		!!asset &&
		asset.kind === "video" &&
		!asset.cameraTrack &&
		(asset.face !== undefined || NATIVE_CAMERA_TAKE.test(asset.originalPath))
	);
}

/** The clip a region sits on: the one its anchor names, else the one under its start. */
export function clipOfRegion<
	C extends { id: string; timelineStartSec: number; timelineEndSec: number },
>(clips: readonly C[], region: { clipId?: string | null; startMs: number }): C | undefined {
	if (typeof region.clipId === "string") {
		const anchored = clips.find((clip) => clip.id === region.clipId);
		if (anchored) return anchored;
	}
	const sec = region.startMs / 1000;
	return clips.find((clip) => clip.timelineStartSec <= sec && sec < clip.timelineEndSec);
}

/** The region sits on a talking head (`clipOfRegion`, `mainTakeIsCamera`). */
export function regionOnTalkingHead(
	document: {
		assets: readonly AxcutAsset[];
		timeline: {
			clips: readonly {
				id: string;
				assetId: string;
				timelineStartSec: number;
				timelineEndSec: number;
			}[];
		};
	},
	region: { clipId?: string | null; startMs: number },
): boolean {
	const clip = clipOfRegion(document.timeline.clips, region);
	return !!clip && mainTakeIsCamera(document.assets.find((asset) => asset.id === clip.assetId));
}

/**
 * A talking head recorded by the helper (1.2.0) is `recording-<id>.mov` (a screen take is
 * `recording-<id>.mp4`, its camera `-webcam.mov` beside it): known from the first moment, before
 * its face has been looked for, and even if it never is.
 */
const NATIVE_CAMERA_TAKE = /(^|[\\/])recording-\d+\.mov$/;
