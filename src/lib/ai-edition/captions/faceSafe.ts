// A caption never sits on the mouth.
//
// Captions are fixed to the frame and a zoom moves the face under them: at a strong zoom the chin
// comes down past where a caption was placed. So each phrase checks where the face will be during
// it, and comes down below the chin. Only down, and never into the bottom of the frame where Reels
// and TikTok draw their own text. Where there is no room left, it gets smaller rather than cover
// the mouth.

import { mainTakeIsCamera } from "../document/cameraTake";
import type { AxcutDocument, AxcutZoomRegion } from "../schema";
import { faceAt } from "../timeline/faceTrack";
import { coverAxis, faceUnderPlayhead } from "../timeline/yapping";
import { effectiveZoomScale } from "../timeline/zoom-scale";

/** The lowest a caption goes, % up from the bottom. Below this is the platforms' own text. */
export const CAPTION_FLOOR_INSET = 11;
const MARGIN = 1.5;
/** From the eye line to the chin and the lower lip, in face heights. Measured on a `--eyes` frame. */
const EYES_TO_CHIN = 0.7;
const EYES_TO_MOUTH = 0.52;
/** A take found before the face's height was measured. */
const USUAL_FACE_HEIGHT = 0.3;
const SMALLEST = 0.72;

export interface CaptionPlace {
	insetY: number;
	/** Multiplies the font size. */
	scale: number;
}

/** Pure: where a caption of this height goes for a face at this place in the frame. */
export function placeUnderChin(
	insetY: number,
	blockPct: number,
	chinPct: number,
	mouthPct: number,
): CaptionPlace {
	if (100 - insetY - blockPct >= chinPct + MARGIN) return { insetY, scale: 1 };
	const under = 100 - chinPct - MARGIN - blockPct;
	if (under >= CAPTION_FLOOR_INSET) return { insetY: Math.min(insetY, under), scale: 1 };
	const floor = Math.min(insetY, CAPTION_FLOOR_INSET);
	const room = 100 - floor - mouthPct - MARGIN;
	return {
		insetY: floor,
		scale: room >= blockPct ? 1 : Math.max(SMALLEST, room / blockPct),
	};
}

/**
 * The answer for each phrase of this document, or null when no phrase needs asking: a face only
 * moves under a caption when the footage fills the frame.
 *
 * A talking head's zooms are the camera lane's (its picture is the camera), yapping's punch-ins
 * included, so over one both lanes are read. A camera zoom on Auto follows the face: it is centred
 * on where the face is during the phrase (the face track, else the take's one face), and the face
 * sits there, not on the zoom's stored point.
 */
export function captionFaceGuard(
	document: AxcutDocument,
	frameAspect: number,
): ((startMs: number, endMs: number, insetY: number, blockPct: number) => CaptionPlace) | null {
	if (!document.assets.some((asset) => asset.face)) return null;
	return (startMs, endMs, insetY, blockPct) => {
		const sec = (startMs + endMs) / 2000;
		const face = faceUnderPlayhead(document, sec);
		if (!face) return { insetY, scale: 1 };
		const clip = document.timeline.clips.find(
			(c) => c.timelineStartSec <= sec && sec < c.timelineEndSec,
		);
		const asset = document.assets.find((a) => a.face === face);
		const video = asset?.video;
		const sourceAspect = video && video.height > 0 ? video.width / video.height : frameAspect;
		// How much of the source's height the frame shows before any zoom.
		const shown = coverAxis(sourceAspect, frameAspect) === "y" ? sourceAspect / frameAspect : 1;
		const talkingHead = mainTakeIsCamera(asset);
		// Where the face is at the phrase's middle: the track, read at the take's own second.
		const tracked =
			talkingHead && clip && asset?.faceTrack?.length
				? faceAt(asset.faceTrack, clip.sourceStartSec + (sec - clip.timelineStartSec))
				: null;
		const facedY = tracked?.y ?? face.y;
		const overlaps = (region: AxcutZoomRegion) => region.startMs < endMs && region.endMs > startMs;
		const zoom = [
			...(document.zoomRanges ?? []).filter(overlaps).map((region) => ({
				scale: effectiveZoomScale(region),
				cy: region.focus.cy,
				followsFace: false,
			})),
			...(talkingHead ? (document.cameraZoomRanges ?? []) : []).filter(overlaps).map((region) => {
				const followsFace = region.focusMode === "auto";
				return {
					scale: effectiveZoomScale(region),
					cy: followsFace ? facedY : region.focus.cy,
					followsFace,
				};
			}),
		].reduce((a, b) => (b.scale > a.scale ? b : a), { scale: 1, cy: face.y, followsFace: false });
		const faceY = zoom.followsFace ? facedY : face.y;
		const height = shown / zoom.scale;
		const centre = Math.min(1 - height / 2, Math.max(height / 2, zoom.cy));
		const inFrame = (y: number) => ((y - (centre - height / 2)) / height) * 100;
		const faceHeight = (zoom.followsFace ? tracked?.h : undefined) ?? face.h ?? USUAL_FACE_HEIGHT;
		return placeUnderChin(
			insetY,
			blockPct,
			inFrame(faceY + faceHeight * EYES_TO_CHIN),
			inFrame(faceY + faceHeight * EYES_TO_MOUTH),
		);
	};
}
