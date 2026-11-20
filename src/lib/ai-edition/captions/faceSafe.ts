// A caption never sits on the mouth.
//
// Captions are fixed to the frame and a zoom moves the face under them: at a strong zoom the chin
// comes down past where a caption was placed. So each phrase checks where the face will be during
// it, and comes down below the chin. Only down, and never into the bottom of the frame where Reels
// and TikTok draw their own text. Where there is no room left, it gets smaller rather than cover
// the mouth.

import type { AxcutDocument } from "../schema";
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
 */
export function captionFaceGuard(
	document: AxcutDocument,
	frameAspect: number,
): ((startMs: number, endMs: number, insetY: number, blockPct: number) => CaptionPlace) | null {
	if (!document.assets.some((asset) => asset.face)) return null;
	return (startMs, endMs, insetY, blockPct) => {
		const face = faceUnderPlayhead(document, (startMs + endMs) / 2000);
		if (!face) return { insetY, scale: 1 };
		const asset = document.assets.find((a) => a.face === face);
		const video = asset?.video;
		const sourceAspect = video && video.height > 0 ? video.width / video.height : frameAspect;
		// How much of the source's height the frame shows before any zoom.
		const shown = coverAxis(sourceAspect, frameAspect) === "y" ? sourceAspect / frameAspect : 1;
		const zoom = (document.zoomRanges ?? [])
			.filter((region) => region.startMs < endMs && region.endMs > startMs)
			.map((region) => ({ scale: effectiveZoomScale(region), cy: region.focus.cy }))
			.reduce((a, b) => (b.scale > a.scale ? b : a), { scale: 1, cy: face.y });
		const height = shown / zoom.scale;
		const centre = Math.min(1 - height / 2, Math.max(height / 2, zoom.cy));
		const inFrame = (y: number) => ((y - (centre - height / 2)) / height) * 100;
		const faceHeight = face.h ?? USUAL_FACE_HEIGHT;
		return placeUnderChin(
			insetY,
			blockPct,
			inFrame(face.y + faceHeight * EYES_TO_CHIN),
			inFrame(face.y + faceHeight * EYES_TO_MOUTH),
		);
	};
}
