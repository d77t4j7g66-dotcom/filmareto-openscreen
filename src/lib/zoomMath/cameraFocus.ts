/**
 * Where a point picked on the camera's box lies in the camera picture.
 *
 * A camera zoom's focus is 0..1 of the whole camera picture, un-mirrored: the source frame before
 * any crop, in file orientation. The box shows less than that: the crop, then the cover cut for
 * the box's shape (placed by Frame position when the crop is the whole picture), mirrored last.
 * This inverts exactly that, the 1x cut, which is what the box shows when nothing is zoomed.
 * It mirrors `webcam_source_rect_zoomed` in `crates/compositor/src/frame_geometry.rs`.
 */

export interface CameraCrop {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CameraPan {
	x: number;
	y: number;
}

type Rect = [number, number, number, number];

const unit = (v: number, fallback: number) =>
	Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;

/** The crop as `[x0, y0, x1, y1]` in 0..1; the whole picture when it is not a usable rect. */
function cropRect(crop: CameraCrop | null | undefined): Rect {
	if (
		!crop ||
		![crop.x, crop.y, crop.width, crop.height].every((n) => Number.isFinite(n)) ||
		crop.width <= 0 ||
		crop.height <= 0
	) {
		return [0, 0, 1, 1];
	}
	const x0 = unit(crop.x, 0);
	const y0 = unit(crop.y, 0);
	const x1 = Math.min(1, Math.max(x0, crop.x + crop.width));
	const y1 = Math.min(1, Math.max(y0, crop.y + crop.height));
	return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : [0, 0, 1, 1];
}

/** `cover_uv_rect`: `uv` shrunk about its centre to the box's shape, in picture pixels. */
function coverRect(uv: Rect, boxAspect: number, cameraAspect: number): Rect {
	const wUv = Math.max(uv[2] - uv[0], 1e-6);
	const hUv = Math.max(uv[3] - uv[1], 1e-6);
	const wPx = wUv * cameraAspect;
	const hPx = hUv;
	const currentAspect = wPx / hPx;
	const box = Number.isFinite(boxAspect) && boxAspect > 0 ? boxAspect : currentAspect;
	const [newWPx, newHPx] = box >= currentAspect ? [wPx, wPx / box] : [hPx * box, hPx];
	const newW = newWPx / cameraAspect;
	const newH = newHPx;
	const cx = uv[0] + wUv / 2;
	const cy = uv[1] + hUv / 2;
	return [cx - newW / 2, cy - newH / 2, cx + newW / 2, cy + newH / 2];
}

/** The part of the picture the box shows at 1x, `[x0, y0, x1, y1]` in the picture's 0..1. */
export function cameraCutAtOneX(
	crop: CameraCrop | null | undefined,
	pan: CameraPan | null | undefined,
	boxAspect: number,
	cameraAspect: number,
): Rect {
	const aspect = Number.isFinite(cameraAspect) && cameraAspect > 0 ? cameraAspect : 1;
	const uv = cropRect(crop);
	const cover = coverRect(uv, boxAspect, aspect);
	// A crop that is the whole picture has no room to pan in, so Frame position places the cover
	// window; a smaller crop is already placed by its own offset. A centred pan is the plain cover.
	const whole = uv[2] - uv[0] >= 0.999 && uv[3] - uv[1] >= 0.999;
	if (!pan || !whole || (pan.x === 0.5 && pan.y === 0.5)) return cover;
	const px = unit(pan.x, 0.5);
	const py = unit(pan.y, 0.5);
	const roomX = Math.max(uv[2] - uv[0] - (cover[2] - cover[0]), 0);
	const roomY = Math.max(uv[3] - uv[1] - (cover[3] - cover[1]), 0);
	const x0 = uv[0] + px * roomX;
	const y0 = uv[1] + py * roomY;
	return [x0, y0, x0 + (cover[2] - cover[0]), y0 + (cover[3] - cover[1])];
}

/**
 * @param point where the pointer is in the box, 0..1 of the box, as it is drawn (mirrored or not)
 * @param boxAspect the box's width over its height
 * @param cameraAspect the camera picture's width over its height, before any crop
 * @returns the point in the camera picture's 0..1, un-mirrored: what a camera zoom's focus stores
 */
export function boxPointToCameraPicture(
	point: { x: number; y: number },
	crop: CameraCrop | null | undefined,
	pan: CameraPan | null | undefined,
	boxAspect: number,
	cameraAspect: number,
	mirrored: boolean,
): { x: number; y: number } {
	const [x0, y0, x1, y1] = cameraCutAtOneX(crop, pan, boxAspect, cameraAspect);
	const bx = unit(point.x, 0.5);
	const by = unit(point.y, 0.5);
	// The compositor mirrors after the cut, so the box's x is flipped back before it is mapped.
	const ux = mirrored ? 1 - bx : bx;
	return {
		x: Math.min(1, Math.max(0, x0 + ux * (x1 - x0))),
		y: Math.min(1, Math.max(0, y0 + by * (y1 - y0))),
	};
}

/**
 * The inverse of {@link boxPointToCameraPicture}: where in the box a focus of the camera picture
 * is drawn. A focus the 1x cut does not show lands on the box's nearest edge, which is also where
 * the compositor frames it.
 */
export function cameraPictureToBoxPoint(
	focus: { x: number; y: number },
	crop: CameraCrop | null | undefined,
	pan: CameraPan | null | undefined,
	boxAspect: number,
	cameraAspect: number,
	mirrored: boolean,
): { x: number; y: number } {
	const [x0, y0, x1, y1] = cameraCutAtOneX(crop, pan, boxAspect, cameraAspect);
	const share = (v: number, lo: number, hi: number) =>
		hi - lo > 1e-9 ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 0.5;
	const ux = share(unit(focus.x, 0.5), x0, x1);
	return { x: mirrored ? 1 - ux : ux, y: share(unit(focus.y, 0.5), y0, y1) };
}
