// The area a PiP replays, edited with a rectangle dragged over a still of the recording. All maths
// is in fractions of the source frame, so it does not care how big the picture is on screen.

export interface CropRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type CropCorner = "nw" | "ne" | "sw" | "se";

/** The smallest side a crop can be shrunk to, as a fraction of the frame. */
export const MIN_CROP = 0.04;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The rectangle moved by (dx, dy), stopped at the frame's edges. */
export function moveCrop(rect: CropRect, dx: number, dy: number): CropRect {
	return {
		...rect,
		x: clamp(rect.x + dx, 0, 1 - rect.width),
		y: clamp(rect.y + dy, 0, 1 - rect.height),
	};
}

/**
 * The rectangle with one corner dragged by (dx, dy); the opposite corner stays put.
 *
 * `aspect` is the shape the replayed picture must have in PIXELS (width over height) when the PiP
 * keeps its box's aspect, and `sourceAspect` the frame's own: together they give the fraction
 * ratio `aspect / sourceAspect` the sides must keep. `aspect` null = free.
 */
export function resizeCrop(
	rect: CropRect,
	corner: CropCorner,
	dx: number,
	dy: number,
	options: { aspect: number | null; sourceAspect: number },
): CropRect {
	const west = corner === "nw" || corner === "sw";
	const north = corner === "nw" || corner === "ne";
	const anchorX = west ? rect.x + rect.width : rect.x;
	const anchorY = north ? rect.y + rect.height : rect.y;
	// How far the dragged corner is from the anchor, along each axis, in the dragged direction.
	let width = clamp(rect.width + (west ? -dx : dx), MIN_CROP, west ? anchorX : 1 - anchorX);
	let height = clamp(rect.height + (north ? -dy : dy), MIN_CROP, north ? anchorY : 1 - anchorY);
	if (options.aspect && options.aspect > 0 && options.sourceAspect > 0) {
		// width / height (as fractions) must equal aspect / sourceAspect.
		const ratio = options.aspect / options.sourceAspect;
		// Follow whichever axis the drag moved more, then pull the other onto the ratio.
		const widthMoved = Math.abs(width - rect.width);
		const heightMoved = Math.abs(height - rect.height) * ratio;
		if (widthMoved >= heightMoved) height = width / ratio;
		else width = height * ratio;
		// Back inside the room the anchor leaves, keeping the ratio.
		const roomX = west ? anchorX : 1 - anchorX;
		const roomY = north ? anchorY : 1 - anchorY;
		const scale = Math.min(1, roomX / width, roomY / height);
		width *= scale;
		height *= scale;
	}
	return {
		x: west ? anchorX - width : anchorX,
		y: north ? anchorY - height : anchorY,
		width,
		height,
	};
}
