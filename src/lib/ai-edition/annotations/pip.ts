import type { PipData } from "@/components/video-editor/types";

type Source = PipData["source"];

const MIN_SIDE = 0.01;

/**
 * The source rect a locked PiP actually replays: `source.x`, `source.y` and `source.width` as the
 * user set them, with the height derived so the picture keeps the box's pixel aspect and is never
 * stretched. Because it is derived from the box, resizing the box in the preview re-fits the
 * source and the other way round, with nothing stored twice.
 *
 * `box` is the annotation's size in percent of the output frame; `frameAspect` and `sourceAspect`
 * are width over height of the output frame and of the footage. A rect that would run off the
 * footage is shrunk to fit, keeping the aspect.
 */
export function lockPipSource(
	source: Source,
	box: { width: number; height: number },
	frameAspect: number,
	sourceAspect: number,
): Source {
	if (!(box.width > 0 && box.height > 0 && frameAspect > 0 && sourceAspect > 0)) return source;
	// Pixel width over height of the box, and what `width / height` of the source rect must equal
	// once the footage's own aspect is folded in.
	const boxRatio = (box.width / box.height) * frameAspect;
	let width = Math.max(MIN_SIDE, source.width);
	let height = (width * sourceAspect) / boxRatio;
	if (source.y + height > 1) {
		height = Math.max(MIN_SIDE, 1 - source.y);
		width = (height * boxRatio) / sourceAspect;
	}
	if (source.x + width > 1) {
		width = Math.max(MIN_SIDE, 1 - source.x);
		height = (width * sourceAspect) / boxRatio;
	}
	return { x: source.x, y: source.y, width, height: Math.max(MIN_SIDE, height) };
}
