import { frameFootprint, frameUnit } from "@/lib/frameFootprint";
import {
	DEFAULT_WEBCAM_ROUNDNESS,
	type RecordingFrame,
	WEBCAM_SIZE_MAX,
	WEBCAM_SIZE_MIN,
	type WebcamAnchor,
	webcamAnchorFractions,
} from "@/lib/projectDefaults";
import { parseAspectRatio } from "@/utils/aspectRatioUtils";
import { clamp01 } from "@/utils/math";

export interface RenderRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface StyledRenderRect extends RenderRect {
	borderRadius: number;
	maskShape?: import("@/components/video-editor/types").WebcamMaskShape;
}

/**
 * The camera's rect during a "Full Camera" region: its layout rect at `progress` 0,
 * the WHOLE frame at 1.
 *
 * Full Camera is not a zoom of the picture-in-picture bubble — it is the camera taking
 * the frame. The endpoint is exactly `[0, 0, canvasWidth, canvasHeight]`: no margin, no
 * padding, no corner rounding, and nothing of the composition (wallpaper, screen,
 * shadow) left showing behind it. The box may change aspect ratio on its way there
 * because every renderer cover-crops the camera into whatever box it is handed, so the
 * image is never stretched by the animation.
 *
 * The mask shape degenerates to a plain rounded rectangle whose radius eases to 0, which
 * is what makes the morph continuous instead of a pop: `computeCompositeLayout` already
 * gives a circle mask a radius of half its (square) box, and a rounded rect at that
 * radius IS that circle — so one lerp carries every shape out of existence with no
 * per-shape branch.
 *
 * Pure, and shared by the preview, both exporters and the native compositor, so all four
 * animate to the identical rect.
 */
export function computeCameraFullscreenRect(
	base: StyledRenderRect,
	canvasSize: Size,
	progress: number,
): StyledRenderRect {
	const t = Math.max(0, Math.min(1, progress));
	const lerp = (from: number, to: number) => from + (to - from) * t;
	return {
		x: lerp(base.x, 0),
		y: lerp(base.y, 0),
		width: lerp(base.width, canvasSize.width),
		height: lerp(base.height, canvasSize.height),
		borderRadius: lerp(base.borderRadius, 0),
		maskShape: "rectangle",
	};
}

export interface Size {
	width: number;
	height: number;
}

export type WebcamLayoutPreset =
	| "picture-in-picture"
	| "vertical-stack"
	| "dual-frame"
	| "cutout-stack"
	| "free-layout"
	| "no-webcam";
/** Webcam size as a percentage of the canvas reference dimension (15–50). */
export type WebcamSizePreset = number;

export interface WebcamLayoutShadow {
	color: string;
	blur: number;
	offsetX: number;
	offsetY: number;
}

interface BorderRadiusRule {
	max: number;
	min: number;
	fraction: number;
}

interface OverlayTransform {
	type: "overlay";
	marginFraction: number;
	minMargin: number;
	minSize: number;
}

/**
 * Screen + camera welded into one solid block that keeps the screen capture's own
 * aspect ratio, then contain-fits into the (padded) scene — see the design notes in
 * `computeCompositeLayout`. Used by both "Side by side" and "Top / bottom".
 */
interface BlockTransform {
	type: "block";
	/** Where the camera sits relative to the screen: beside it, or under it. */
	direction: "row" | "column";
	/** Gap between screen and camera, as a fraction of the screen's own width. */
	gapFraction: number;
}

export interface WebcamLayoutPresetDefinition {
	label: string;
	transform: OverlayTransform | BlockTransform;
	borderRadius: BorderRadiusRule;
	shadow: WebcamLayoutShadow | null;
}

/**
 * Presets whose camera box is welded to the screen. Their geometry is fully derived
 * from the screen capture's aspect ratio, so the webcam-size slider, the mask-shape
 * picker and the reactive "shrink on zoom" scaling have nothing to act on there.
 */
export function isWebcamBlockLayout(preset: WebcamLayoutPreset = "picture-in-picture"): boolean {
	return preset === "dual-frame" || preset === "vertical-stack";
}

/**
 * Whether "shrink on zoom" (the reactive webcam scaling) applies to a preset. Only the
 * free-floating picture-in-picture bubble can shrink: the block layouts size their
 * camera off the screen box, so shrinking it would break the "same width / same height
 * as the screen capture" contract and tear a hole in the block. Single rule shared by
 * the UI (which hides the toggle), the preview, both exporters and the native scene.
 */
export function supportsWebcamReactiveZoom(
	preset: WebcamLayoutPreset = "picture-in-picture",
): boolean {
	return preset === "picture-in-picture";
}

/** Effective reactive-zoom flag: the stored setting, gated by the active preset. */
export function resolveWebcamReactiveZoom(
	preset: WebcamLayoutPreset | undefined,
	enabled: boolean | undefined,
): boolean {
	return Boolean(enabled) && supportsWebcamReactiveZoom(preset);
}

/**
 * Effective layout preset: the stored setting, gated by whether there is a camera to lay
 * out at all. Without one the answer is `no-webcam` whatever the panel holds — hiding
 * just the webcam slot is not enough, because the block presets size the SCREEN off the
 * block and would leave it squeezed into half an empty canvas. One rule shared by the
 * settings panel, the preview and the native scene, so the three cannot drift.
 *
 * `hasCamera` is the caller's question to answer, and they do not all ask it the same
 * way on purpose: the preview and the scene resolve it per clip, while the settings
 * panel asks whether the project has any camera at all.
 */
export function resolveWebcamLayoutPreset(
	preset: WebcamLayoutPreset | undefined,
	hasCamera: boolean,
): WebcamLayoutPreset {
	return hasCamera ? (preset ?? "picture-in-picture") : "no-webcam";
}

export interface WebcamCompositeLayout {
	screenRect: RenderRect;
	webcamRect: StyledRenderRect | null;
	screenBorderRadius?: number;
	/**
	 * When true, the video should be scaled to cover screenRect (cropping overflow), and
	 * screenRect masks it: a zoom or a 3D tilt stays inside instead of growing past it.
	 */
	screenCover?: boolean;
	/**
	 * "Camera over screen": the y, in px, where the camera's own background starts to show. Above
	 * it the camera is cut out; between the screen and this line sits the gap to the screen.
	 */
	cutoutLineY?: number;
}

/** Convert a webcam size percentage (15–50) to a fraction (0..1) of the reference dimension. */
export function webcamSizeToFraction(percent: number): number {
	const safe = Number.isFinite(percent) ? percent : 25;
	const clamped = Math.max(WEBCAM_SIZE_MIN, Math.min(WEBCAM_SIZE_MAX, safe));
	return clamped / 100;
}

const MARGIN_FRACTION = 0.02;
const MAX_BORDER_RADIUS = 24;
/** Picture-in-picture rounds by the user's `webcamRoundness`, and no-webcam draws no camera. */
const NO_PRESET_ROUNDING = { max: 0, min: 0, fraction: 0 };
/**
 * Breathing room between the screen box and the camera box inside a block layout,
 * as a fraction of the screen's own width. Expressed against the screen (not the
 * canvas) so it scales with the block itself: the same value reads as the same
 * visual gap whether the block is width- or height-constrained by the scene.
 */
const BLOCK_GAP_FRACTION = 0.02;
/**
 * How far the camera box may drift from square, as a maximum aspect ratio (its
 * reciprocal is the minimum). The camera's free side is chosen to make the whole
 * block match the SCENE's aspect ratio — perfect contain-fit, no bars — but the
 * result is then held within `[1/T, T]` of square, so the camera never becomes an
 * extreme slice. This single knob is the whole of "the camera tends toward square,
 * going only slightly rectangular when filling the scene asks it to". `1.25` keeps
 * it between 4:5 and 5:4.
 */
const BLOCK_CAMERA_ASPECT_TOLERANCE = 1.25;
const WEBCAM_LAYOUT_PRESET_MAP: Record<WebcamLayoutPreset, WebcamLayoutPresetDefinition> = {
	"picture-in-picture": {
		label: "Picture in Picture",
		transform: {
			type: "overlay",
			marginFraction: MARGIN_FRACTION,
			minMargin: 0,
			minSize: 0,
		},
		borderRadius: NO_PRESET_ROUNDING,
		shadow: {
			color: "rgba(0,0,0,0.35)",
			blur: 24,
			offsetX: 0,
			offsetY: 10,
		},
	},
	"vertical-stack": {
		label: "Top / bottom",
		transform: {
			type: "block",
			direction: "column",
			gapFraction: BLOCK_GAP_FRACTION,
		},
		borderRadius: {
			max: 24,
			min: 8,
			fraction: 0.06,
		},
		shadow: null,
	},
	"dual-frame": {
		label: "Side by side",
		transform: {
			type: "block",
			direction: "row",
			gapFraction: BLOCK_GAP_FRACTION,
		},
		borderRadius: {
			max: MAX_BORDER_RADIUS,
			min: 12,
			fraction: 0.06,
		},
		shadow: null,
	},
	// A portrait stack where the camera is not boxed: with its background cut out, the speaker
	// stands at the bottom and overlaps the screen above. See `cutoutStackLayout`.
	"cutout-stack": {
		label: "Cutout over screen",
		transform: {
			type: "overlay",
			marginFraction: 0,
			minMargin: 0,
			minSize: 0,
		},
		borderRadius: NO_PRESET_ROUNDING,
		shadow: null,
	},
	// Both boxes placed by hand: see `freeFormLayout`.
	"free-layout": {
		label: "Free layout",
		transform: {
			type: "overlay",
			marginFraction: 0,
			minMargin: 0,
			minSize: 0,
		},
		borderRadius: NO_PRESET_ROUNDING,
		shadow: {
			color: "rgba(0,0,0,0.35)",
			blur: 24,
			offsetX: 0,
			offsetY: 10,
		},
	},
	"no-webcam": {
		label: "No Webcam",
		transform: {
			type: "overlay",
			marginFraction: 0,
			minMargin: 0,
			minSize: 0,
		},
		borderRadius: NO_PRESET_ROUNDING,
		shadow: null,
	},
};

export const WEBCAM_LAYOUT_PRESETS = Object.entries(WEBCAM_LAYOUT_PRESET_MAP).map(
	([value, preset]) => ({
		value: value as WebcamLayoutPreset,
		label: preset.label,
	}),
);

export function getWebcamLayoutPresetDefinition(
	preset: WebcamLayoutPreset = "picture-in-picture",
): WebcamLayoutPresetDefinition {
	return WEBCAM_LAYOUT_PRESET_MAP[preset];
}

export function getWebcamLayoutCssBoxShadow(
	preset: WebcamLayoutPreset = "picture-in-picture",
): string {
	const shadow = getWebcamLayoutPresetDefinition(preset).shadow;
	return shadow
		? `${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${shadow.color}`
		: "none";
}

/**
 * A block's footprint in UNIT space, where the screen is exactly 1 wide: the screen's element
 * (the screen, or the frame around it), the gap, and a camera `cameraAlong` long on the split
 * axis. One definition for the layout below and for the resting shape Auto frames, so the two
 * cannot disagree on it.
 */
function blockUnitSize(element: Size, block: BlockTransform, cameraAlong: number): Size {
	return block.direction === "row"
		? { width: element.width + block.gapFraction + cameraAlong, height: element.height }
		: { width: element.width, height: element.height + block.gapFraction + cameraAlong };
}

/**
 * The screen and its frame at rest, in UNIT space where the screen is exactly 1 wide: the
 * frame's body, everything it draws, and the box of the whole (`element`). The frame's thickness
 * follows the scene it is drawn in (`frameUnit`), of which only the shape counts. Without a
 * frame every inset is 0 and the element is the screen.
 */
function framedScreen(screenAspect: number, canvas: Size, frame: RecordingFrame) {
	const screen = { width: 1, height: 1 / screenAspect };
	const { body, outer } = frameFootprint(frame, screen, frameUnit(screen, canvas));
	const element = {
		width: outer[0] + screen.width + outer[2],
		height: outer[1] + screen.height + outer[3],
	};
	return { screen, body, outer, element };
}

/**
 * The composition's own shape (width / height) before any frame constrains it — what the
 * Auto format frames. Nothing is bent to fit: the screen keeps its ratio, and a block
 * layout's camera takes its resting shape, square, beside or under it. A picture-in-picture
 * bubble floats over the screen, so the composition is the screen alone.
 *
 * The screen wears its device frame: every layout measures the padding from what that frame
 * draws, so it is part of the shape. Its thickness follows the scene's shape, `canvas`, which
 * `autoFormatAspect` settles.
 */
export function restingCompositionAspect(
	screenSize: Size,
	preset: WebcamLayoutPreset,
	frame: RecordingFrame = "none",
	canvas: Size = screenSize,
): number {
	const { screen, body, element } = framedScreen(
		screenSize.width / screenSize.height,
		canvas,
		frame,
	);
	const transform = getWebcamLayoutPresetDefinition(preset).transform;
	if (transform.type !== "block") return element.width / element.height;
	// Square, lined up with the frame's body, as `computeCompositeLayout` lays it at rest.
	const cameraCross =
		transform.direction === "row"
			? body[1] + screen.height + body[3]
			: body[0] + screen.width + body[2];
	const block = blockUnitSize(element, transform, cameraCross);
	return block.width / block.height;
}

/** The share of the frame the composition keeps at `padding` (0–100): 1 at 0%, 0.6 at 100%. */
export function paddingFit(padding: number): number {
	return 1 - (Math.min(100, Math.max(0, padding)) / 100) * 0.4;
}

/**
 * The box the composition is contain-fitted into: the frame minus its padding.
 *
 * A fixed format keeps `paddingFit` of each axis. An Auto frame (`evenBorder`) is shaped
 * around the composition instead, so its padding is a border of one thickness on all four
 * sides — `(1 - fit) / 2` of the short side, which is what a fixed format leaves on the
 * short axis too. The two agree on a square frame, and on the short axis of any frame.
 */
export function paddedContentSize(canvas: Size, padding: number, evenBorder: boolean): Size {
	const fit = paddingFit(padding);
	if (!evenBorder) {
		return { width: Math.round(canvas.width * fit), height: Math.round(canvas.height * fit) };
	}
	const border = ((1 - fit) / 2) * Math.min(canvas.width, canvas.height);
	return {
		width: Math.round(canvas.width - 2 * border),
		height: Math.round(canvas.height - 2 * border),
	};
}

/**
 * The Auto frame's shape: the composition's resting shape plus an even padding border.
 *
 * With `paddedContentSize`'s border, the frame's elongation (long side / short side) is
 * `fit · e + (1 − fit)` for a composition of elongation `e`: the composition's own at 0%
 * padding, pulled toward square as the border grows. Orientation never flips.
 */
export function autoFrameAspect(compositionAspect: number, padding: number): number {
	const fit = paddingFit(padding);
	const elongation = Math.max(compositionAspect, 1 / compositionAspect);
	const framed = fit * elongation + (1 - fit);
	return compositionAspect >= 1 ? framed : 1 / framed;
}

/**
 * What the Auto format resolves to: `autoFrameAspect` over `restingCompositionAspect`.
 *
 * Under a device frame the two depend on each other: the device's thickness follows the shape of
 * the scene it is drawn in (`frameUnit`), and Auto shapes that scene around the device. Each pass
 * lays the device out in the scene the previous one gave. A device is thin next to its screen, so
 * each pass moves the shape by a small fraction of the one before, and a few leave nothing a pixel
 * could show.
 */
export function autoFormatAspect(
	screenSize: Size,
	preset: WebcamLayoutPreset,
	frame: RecordingFrame,
	padding: number,
): number {
	let aspect = autoFrameAspect(restingCompositionAspect(screenSize, preset), padding);
	if (frame === "none") return aspect;
	for (let pass = 0; pass < 8; pass++) {
		const canvas = { width: aspect, height: 1 };
		aspect = autoFrameAspect(restingCompositionAspect(screenSize, preset, frame, canvas), padding);
	}
	return aspect;
}

/**
 * "Free layout": the screen and the camera are two boxes the user places by hand, each by its
 * centre and width (percent of the frame). A box keeps the shape it is given (the recording's own,
 * or the one picked) and is shrunk, never stretched, to stay inside the frame. The camera is drawn
 * over the screen.
 */
export function freeFormLayout(params: {
	canvasSize: Size;
	screenSize: Size;
	webcamSize: Size | null;
	free: {
		screen: { x: number; y: number; width: number };
		camera: { x: number; y: number; width: number };
	};
	maskShape: import("@/components/video-editor/types").WebcamMaskShape;
	roundness: number;
}): WebcamCompositeLayout {
	const { canvasSize, screenSize, webcamSize, free, maskShape, roundness } = params;
	const place = (aspect: number, box: { x: number; y: number; width: number }) => {
		let width = (canvasSize.width * box.width) / 100;
		let height = width / aspect;
		if (height > canvasSize.height) {
			height = canvasSize.height;
			width = height * aspect;
		}
		width = Math.max(2, Math.round(width));
		height = Math.max(2, Math.round(height));
		const x = Math.round(
			Math.min(canvasSize.width - width, Math.max(0, (canvasSize.width * box.x) / 100 - width / 2)),
		);
		const y = Math.round(
			Math.min(
				canvasSize.height - height,
				Math.max(0, (canvasSize.height * box.y) / 100 - height / 2),
			),
		);
		return { x, y, width, height };
	};
	const screenRect = place(screenSize.width / screenSize.height, free.screen);
	if (!webcamSize || webcamSize.width <= 0 || webcamSize.height <= 0) {
		return { screenRect, webcamRect: null, screenCover: true };
	}
	const square = maskShape === "square" || maskShape === "circle";
	const aspect = square ? 1 : webcamSize.width / webcamSize.height;
	const cam = place(aspect, free.camera);
	return {
		screenRect,
		screenCover: true,
		webcamRect: {
			...cam,
			borderRadius: Math.round((clamp01(roundness) * Math.min(cam.width, cam.height)) / 2),
			maskShape,
		},
	};
}

export function computeCompositeLayout(params: {
	canvasSize: Size;
	maxContentSize?: Size;
	screenSize: Size;
	webcamSize?: Size | null;
	layoutPreset?: WebcamLayoutPreset;
	webcamSizePreset?: WebcamSizePreset;
	/** Picture-in-picture only: where the camera sits. The block layouts place their own. */
	webcamAnchor?: WebcamAnchor;
	/** The camera's own shape, width over height, in picture-in-picture and camera over screen. */
	webcamAspect?: number | null;
	webcamMaskShape?: import("@/components/video-editor/types").WebcamMaskShape;
	/** Picture-in-picture only: 0 square corners to 1 fully round. */
	webcamRoundness?: number;
	/**
	 * Percent of the camera that reaches into the screen: its height in "Camera over screen", and
	 * in picture-in-picture its size along the edges the anchor touches (0 beside the screen,
	 * 100 inside it). Picture-in-picture without it keeps the camera at the frame's border.
	 */
	webcamOverlap?: number;
	/** "Camera over screen" only: the camera's width in percent of the frame's width. */
	webcamStackSize?: number;
	/** Picture-in-picture only: the camera's distance from the border, percent of the short side. */
	webcamMargin?: number;
	/**
	 * "Camera over screen" only: the shape (width over height) the screen box takes. The screen and
	 * camera are then kept together and pinned to the bottom; left out, the screen fills the box
	 * down to the camera.
	 */
	screenAspect?: number | null;
	/**
	 * "Free layout" only: where the two boxes sit. x and y are the box's centre and width its width,
	 * all in percent of the frame; the height follows from the box's shape.
	 */
	freeLayout?: {
		screen: { x: number; y: number; width: number };
		camera: { x: number; y: number; width: number };
	};
	/** "Camera over screen" only: the camera's own padding (percent of the frame's width). */
	webcamPad?: { left: number; right: number; bottom: number; top?: number; matchScreen: boolean };
	/**
	 * "Camera over screen" only: the screen fills its box and is cropped to it (the format follows
	 * the cursor). Off, the whole screen is shown, fitted inside the box ("Whole").
	 */
	screenFill?: boolean;
	/**
	 * The frame around the screen. Every layout makes room for everything it draws: the padding
	 * is measured from its outer edge. In the block layouts it is also the screen's fixed
	 * container, and the camera lines up with its body.
	 */
	frame?: RecordingFrame;
}): WebcamCompositeLayout | null {
	const {
		canvasSize,
		maxContentSize = canvasSize,
		screenSize,
		webcamSize,
		layoutPreset = "picture-in-picture",
		webcamSizePreset = 40,
		webcamAnchor = "bottom-right",
		webcamAspect = null,
		webcamMaskShape = "rectangle",
		webcamOverlap,
		webcamStackSize,
		webcamMargin,
		screenAspect = null,
		webcamPad,
		freeLayout,
		screenFill = true,
		webcamRoundness = DEFAULT_WEBCAM_ROUNDNESS[
			webcamMaskShape === "square" || webcamMaskShape === "circle" ? "square" : "rectangle"
		],
		frame = "none",
	} = params;
	const { width: canvasWidth, height: canvasHeight } = canvasSize;
	const { width: screenWidth, height: screenHeight } = screenSize;

	// no-webcam: hide the webcam, screen fills the canvas normally.
	if (layoutPreset === "no-webcam") {
		const screenRect = centerScreen(canvasSize, screenSize, maxContentSize, frame);
		return { screenRect, webcamRect: null };
	}

	// A shape of its own for the camera: the box takes it and the picture is cut to fit.
	const ownShape =
		webcamAspect && webcamAspect > 0 && webcamSize && webcamSize.width > 0
			? { width: webcamAspect * 1000, height: 1000 }
			: null;
	const shapedWebcam =
		ownShape &&
		(layoutPreset === "picture-in-picture" ||
			layoutPreset === "cutout-stack" ||
			layoutPreset === "free-layout")
			? ownShape
			: webcamSize;
	const webcamWidth = shapedWebcam?.width;
	const webcamHeight = shapedWebcam?.height;
	const preset = getWebcamLayoutPresetDefinition(layoutPreset);

	const MAX_STAGE_FRACTION = webcamSizeToFraction(webcamSizePreset);

	if (canvasWidth <= 0 || canvasHeight <= 0 || screenWidth <= 0 || screenHeight <= 0) {
		return null;
	}

	if (layoutPreset === "free-layout") {
		return freeFormLayout({
			canvasSize,
			screenSize,
			webcamSize: webcamWidth && webcamHeight ? { width: webcamWidth, height: webcamHeight } : null,
			free: freeLayout ?? {
				screen: { x: 50, y: 50, width: 70 },
				camera: { x: 85, y: 80, width: 20 },
			},
			maskShape: webcamMaskShape,
			roundness: webcamRoundness,
		});
	}

	if (preset.transform.type === "block") {
		const block = preset.transform;

		if (!webcamWidth || !webcamHeight || webcamWidth <= 0 || webcamHeight <= 0) {
			// No camera on this clip: the block degenerates to the screen alone, which
			// contain-fits the padded area like every other preset does.
			return {
				screenRect: centerScreen(canvasSize, screenSize, maxContentSize, frame),
				webcamRect: null,
			};
		}

		// The block is laid out in UNIT space first, where the screen is exactly
		// 1 wide and `h = 1 / screenAspect` tall. The gap and the camera are
		// expressed against that same unit, so a single contain-fit at the end
		// scales screen, gap and camera together.
		//
		// The camera's SOURCE aspect ratio plays no part: the box is a mask cut
		// from the block's geometry, and the camera video is cover-cropped into it
		// downstream (`screenCover` for the screen, the renderers' cover crop for
		// the camera).
		const screenAspect = screenWidth / screenHeight;
		const unitScreenHeight = 1 / screenAspect; // h
		const gap = block.gapFraction;
		const isRow = block.direction === "row";

		// The frame, at rest, in the same unit space. Here it is the screen's container: it
		// neither zooms nor tilts (the footage does, inside it), so the block lays it out like
		// the screen itself. Its BODY is what the camera lines up with; what sticks out of the
		// body (a laptop's deck, a monitor's stand) keeps the gap to the camera. Without a frame
		// every inset is 0 and the arithmetic below is the frameless one, term for term.
		const { body, outer, element } = framedScreen(screenAspect, canvasSize, frame);

		// The camera shares the screen's cross-edge (same height beside it, same
		// width under it — the aligned edge that makes them one solid block), so its
		// size ALONG the split axis is the one free dimension. Under a frame, the cross-edge
		// is the frame's body. Three constraints fix it, in order:
		//   1. screen keeps its own aspect ratio      → screen is 1 × h, untouched;
		//   2. the block contain-fits the padded area → pick `along` so the block's
		//      aspect equals that area's (fills it, no bars) — see `alongForFill`;
		//   3. the camera tends toward square          → but clamp `along` so the
		//      camera stays within `[1/T, T]` of square, so filling the scene only
		//      nudges it slightly rectangular, never into a slice.
		// Square is `along === cameraCross`; the clamp is symmetric in both layouts.
		//
		// The target is the PADDED area, not the canvas: the block is fitted into the
		// former, so that is the shape it has to match. The two only differ under an
		// Auto frame's even border (`paddedContentSize`), which is exactly the shape of
		// the block at rest, so the camera comes out square there by construction.
		const contentWidth = Math.min(canvasWidth, Math.max(1, maxContentSize.width));
		const contentHeight = Math.min(canvasHeight, Math.max(1, maxContentSize.height));
		const cameraCross = isRow ? body[1] + unitScreenHeight + body[3] : body[0] + 1 + body[2];
		const contentAspect = contentWidth / contentHeight;
		const alongForFill = isRow
			? contentAspect * element.height - element.width - gap // block width  = w + gap + along
			: element.width / contentAspect - element.height - gap; // block height = h + gap + along
		const cameraAlong = Math.min(
			cameraCross * BLOCK_CAMERA_ASPECT_TOLERANCE,
			Math.max(cameraCross / BLOCK_CAMERA_ASPECT_TOLERANCE, alongForFill),
		);

		const unitCameraWidth = isRow ? cameraAlong : cameraCross;
		const unitCameraHeight = isRow ? cameraCross : cameraAlong;
		const { width: blockWidth, height: blockHeight } = blockUnitSize(element, block, cameraAlong);

		// Contain-fit the whole block into the padded content area, so padding
		// shrinks the BLOCK (not just the screen) and padding 0 leaves it flush
		// against the two scene edges its own ratio makes it touch — bottom/top for a
		// column, left/right for a row.
		const scale = Math.min(contentWidth / blockWidth, contentHeight / blockHeight);

		const originX = (canvasWidth - blockWidth * scale) / 2;
		const originY = (canvasHeight - blockHeight * scale) / 2;

		const screenRect = snapRect(
			originX + outer[0] * scale,
			originY + outer[1] * scale,
			scale,
			unitScreenHeight * scale,
		);
		// Beside or under the whole frame, lined up with its body.
		const cameraRect = snapRect(
			isRow ? originX + (element.width + gap) * scale : originX + (outer[0] - body[0]) * scale,
			isRow ? originY + (outer[1] - body[1]) * scale : originY + (element.height + gap) * scale,
			unitCameraWidth * scale,
			unitCameraHeight * scale,
		);

		const webcamBorderRadius = Math.min(
			preset.borderRadius.max,
			Math.max(
				preset.borderRadius.min,
				Math.round(Math.min(cameraRect.width, cameraRect.height) * preset.borderRadius.fraction),
			),
		);

		return {
			screenRect,
			// Both halves of the block are framed alike, so the screen picks up the
			// camera's corner rounding instead of the free-standing Roundness slider.
			screenBorderRadius: webcamBorderRadius,
			webcamRect: {
				...cameraRect,
				borderRadius: webcamBorderRadius,
				maskShape: "rectangle",
			},
			// The screen box already carries the capture's exact aspect ratio, so
			// cover and contain agree here; cover just absorbs the ±1px rounding
			// above instead of letterboxing a hairline of wallpaper into the frame.
			screenCover: true,
		};
	}

	if (layoutPreset === "cutout-stack") {
		return cutoutStackLayout({
			canvasSize,
			maxContentSize,
			screenSize,
			webcamSize: webcamWidth && webcamHeight ? { width: webcamWidth, height: webcamHeight } : null,
			widthFraction: (webcamStackSize ?? 94) / 100,
			overlap: (webcamOverlap ?? 35) / 100,
			fill: screenFill,
			screenAspect,
			cameraPad: {
				left: (webcamPad?.left ?? 0) / 100,
				right: (webcamPad?.right ?? 0) / 100,
				bottom: (webcamPad?.bottom ?? 0) / 100,
				top: (webcamPad?.top ?? 3) / 100,
			},
			matchScreenPad: webcamPad?.matchScreen ?? false,
			roundness: webcamRoundness,
			frame,
		});
	}

	const transform = preset.transform;
	const screenRect = centerScreen(canvasSize, screenSize, maxContentSize, frame);

	if (!webcamWidth || !webcamHeight || webcamWidth <= 0 || webcamHeight <= 0) {
		return { screenRect, webcamRect: null };
	}

	// Picture-in-picture lets the user set the distance from the border; the other layouts keep
	// the preset's own margin (0 for the blocks).
	const margin =
		webcamMargin !== undefined && transform.marginFraction > 0
			? Math.max(0, Math.round((Math.min(canvasWidth, canvasHeight) * webcamMargin) / 100))
			: Math.max(
					transform.minMargin,
					Math.round(Math.min(canvasWidth, canvasHeight) * transform.marginFraction),
				);
	// The SHORT axis, not the geometric mean: sqrt(w*h) sits close to the diagonal, so at an
	// extreme aspect ratio (e.g. 9:16) it barely shrinks even though the actual narrow axis is
	// much smaller — the webcam box then ends up a large fraction of that narrow axis, eating
	// most of the room there is to drag it around (reported: dragging the webcam PiP felt stuck
	// in a wide "dead band" near each edge — confirmed via logging: a 230px-wide 9:16 frame at a
	// modest 34% size preset produced a 104px-wide box, 45% of the frame's own width). Using the
	// short axis directly still keeps the box the same size when width/height are swapped
	// (min(a,b) is symmetric, same as sqrt(a*b) was), but it now actually shrinks with whichever
	// axis is the tight constraint, instead of only reacting to the frame's overall area.
	const referenceDim = Math.min(canvasWidth, canvasHeight);
	const maxWidth = Math.max(transform.minSize, referenceDim * MAX_STAGE_FRACTION);
	const maxHeight = Math.max(transform.minSize, referenceDim * MAX_STAGE_FRACTION);
	const scale = Math.min(maxWidth / webcamWidth, maxHeight / webcamHeight);
	let width = Math.round(webcamWidth * scale);
	let height = Math.round(webcamHeight * scale);

	// Shape-specific dimension adjustments
	if (webcamMaskShape === "circle" || webcamMaskShape === "square") {
		const side = Math.min(width, height);
		width = side;
		height = side;
	}

	// The anchor's corner or edge middle, the same margin from the border whatever the
	// camera's size: the camera takes 0, a half or all of the room it leaves on each axis.
	const [fx, fy] = webcamAnchorFractions(webcamAnchor);
	let webcamX = Math.max(0, Math.round(margin + fx * (canvasWidth - 2 * margin - width)));
	let webcamY = Math.max(0, Math.round(margin + fy * (canvasHeight - 2 * margin - height)));
	let pipScreenRect = screenRect;

	if (webcamOverlap !== undefined && layoutPreset === "picture-in-picture") {
		// The camera sits on the screen's own edge at `webcamAnchor`: 0 puts it wholly beside the
		// screen, on the background, 1 wholly inside it, and `margin` is the gap either way. The
		// screen gives way on that side, so the camera never leaves the frame.
		const o = clamp01(webcamOverlap / 100);
		const reach = (extent: number) => o * (extent + 2 * margin);
		let left = (canvasWidth - maxContentSize.width) / 2;
		let right = left + maxContentSize.width;
		let top = (canvasHeight - maxContentSize.height) / 2;
		let bottom = top + maxContentSize.height;
		if (fx === 1) right = Math.min(right, canvasWidth - 2 * margin - width + reach(width));
		if (fx === 0) left = Math.max(left, 2 * margin + width - reach(width));
		if (fy === 1) bottom = Math.min(bottom, canvasHeight - 2 * margin - height + reach(height));
		if (fy === 0) top = Math.max(top, 2 * margin + height - reach(height));
		// The screen gives way on both sides alike, so it stays centred in the frame and only the
		// side with the camera is crowded.
		const inX = Math.max(
			0,
			left - (canvasWidth - maxContentSize.width) / 2,
			canvasWidth - (canvasWidth - maxContentSize.width) / 2 - right,
		);
		const inY = Math.max(
			0,
			top - (canvasHeight - maxContentSize.height) / 2,
			canvasHeight - (canvasHeight - maxContentSize.height) / 2 - bottom,
		);
		left = (canvasWidth - maxContentSize.width) / 2 + inX;
		right = canvasWidth - left;
		top = (canvasHeight - maxContentSize.height) / 2 + inY;
		bottom = canvasHeight - top;
		const areaWidth = Math.max(canvasWidth * 0.2, right - left);
		const areaHeight = Math.max(canvasHeight * 0.2, bottom - top);
		const area = { width: areaWidth, height: areaHeight };
		const inArea = centerScreen(area, screenSize, area, frame);
		pipScreenRect = { ...inArea, x: inArea.x + Math.round(left), y: inArea.y + Math.round(top) };
		const sr = pipScreenRect;
		if (fx === 1) webcamX = sr.x + sr.width + margin - reach(width);
		else if (fx === 0) webcamX = sr.x - margin - width + reach(width);
		else webcamX = sr.x + (sr.width - width) / 2;
		if (fy === 1) webcamY = sr.y + sr.height + margin - reach(height);
		else if (fy === 0) webcamY = sr.y - margin - height + reach(height);
		else webcamY = sr.y + (sr.height - height) / 2;
		webcamX = Math.round(Math.min(canvasWidth - width, Math.max(0, webcamX)));
		webcamY = Math.round(Math.min(canvasHeight - height, Math.max(0, webcamY)));
	}

	// A fraction of half the short side, so the shape holds at any size and resolution:
	// at 1 a square camera is a circle, a rectangular one a pill.
	const borderRadius = Math.round((clamp01(webcamRoundness) * Math.min(width, height)) / 2);

	return {
		screenRect: pipScreenRect,
		webcamRect: {
			x: webcamX,
			y: webcamY,
			width,
			height,
			borderRadius,
			maskShape: webcamMaskShape,
		},
	};
}

/**
 * Where a picture-in-picture camera steps aside to when the pointer nears its place: mirrored
 * across the screen's centre, on the other side (or above/below it for a camera centred on an
 * edge), and kept inside the frame.
 */
export function dodgeWebcamRect(
	layout: { screenRect: RenderRect; webcamRect: RenderRect | null },
	canvasSize: Size,
	anchor: WebcamAnchor,
): RenderRect | null {
	const cam = layout.webcamRect;
	if (!cam) return null;
	const [fx] = webcamAnchorFractions(anchor);
	const s = layout.screenRect;
	let { x, y } = cam;
	if (fx === 0.5) y = 2 * (s.y + s.height / 2) - (cam.y + cam.height);
	else x = 2 * (s.x + s.width / 2) - (cam.x + cam.width);
	x = Math.round(Math.min(canvasSize.width - cam.width, Math.max(0, x)));
	y = Math.round(Math.min(canvasSize.height - cam.height, Math.max(0, y)));
	return { ...cam, x, y };
}

/**
 * "Camera over screen". The padding is a safe zone: the screen keeps the same distance from the
 * left, right and top edges. The camera is a rounded video in its own aspect, pinned to the
 * bottom, with a padding of its own on the left, right and bottom (0 puts it flush with the
 * edge), and it reaches up into the screen, over the screen's padding, by `overlap` of its own
 * height. The camera's width is `widthFraction` of the frame, within its own padding.
 *
 * The screen is centred in the room above the camera, so the gap over it and the gap under it
 * match (the padding, at least); the overlap lowers the line the camera cuts through. Filled, the
 * screen takes the chosen shape (or the room there is) and the footage is cut to it. Whole, the
 * box takes the recording's own shape.
 */
function cutoutStackLayout(params: {
	canvasSize: Size;
	maxContentSize: Size;
	screenSize: Size;
	webcamSize: Size | null;
	/** The camera's width over the frame's width, 0..1. */
	widthFraction: number;
	/** 0..1, the part of the camera's height that overlaps the screen. */
	overlap: number;
	/** The camera's padding, in fractions of the frame's width. */
	cameraPad: { left: number; right: number; bottom: number; top: number };
	/** The camera's padding is the screen's, in pixels. */
	matchScreenPad: boolean;
	/** The screen fills its box and is cropped; off, it is fitted whole inside it. */
	fill: boolean;
	/** A fixed shape for the screen box (width over height), or null to fill down to the camera. */
	screenAspect: number | null;
	/** 0 square corners to 1 fully round. */
	roundness: number;
	frame: RecordingFrame;
}): WebcamCompositeLayout {
	const { canvasSize, maxContentSize, screenSize, webcamSize, widthFraction, frame } = params;
	if (!webcamSize || webcamSize.width <= 0 || webcamSize.height <= 0) {
		return {
			screenRect: centerScreen(canvasSize, screenSize, maxContentSize, frame),
			webcamRect: null,
		};
	}
	const { width: canvasWidth, height: canvasHeight } = canvasSize;
	// One padding for the screen, the same on the left, right and top.
	const contentWidth = Math.min(canvasWidth, Math.max(1, maxContentSize.width));
	const pad = Math.max(0, Math.round((canvasWidth - contentWidth) / 2));
	const boxWidth = Math.max(1, canvasWidth - 2 * pad);

	const camPx = (fraction: number) =>
		params.matchScreenPad ? pad : Math.round(canvasWidth * Math.max(0, fraction));
	const padLeft = camPx(params.cameraPad.left);
	const padRight = camPx(params.cameraPad.right);
	const padBottom = camPx(params.cameraPad.bottom);
	// The gap between the screen and the camera, which the overlap then eats into.
	const gap = camPx(params.cameraPad.top);
	const room = Math.max(2, canvasWidth - padLeft - padRight);
	// An even width, so the camera stays exactly centred in its room.
	const cameraWidth = Math.max(
		2,
		Math.min(
			2 * Math.floor(room / 2),
			2 * Math.round((canvasWidth * Math.min(1, Math.max(0.05, widthFraction))) / 2),
		),
	);
	const cameraHeight = Math.max(
		1,
		Math.round((cameraWidth * webcamSize.height) / webcamSize.width),
	);
	const cameraX = padLeft + Math.round((room - cameraWidth) / 2);
	const cameraBottom = canvasHeight - padBottom;
	const overlap = Math.min(0.9, Math.max(0, params.overlap));
	const overlapPx = Math.round(cameraHeight * overlap);

	// The camera sits at `cameraTop`; the overlap pulls the line the screen ends at down by that
	// much. The screen starts one padding from the top, like on its other sides, and ends one
	// padding above that line, so at no overlap the gap to the camera is the padding, and the
	// overlap then covers that gap first and the screen after.
	const cameraTop = cameraBottom - cameraHeight;
	const lineY = cameraTop + overlapPx;
	const roomHeight = Math.max(1, lineY - pad - gap);
	let boxLeft = pad;
	let boxW = boxWidth;
	let boxHeight = roomHeight;
	let boxTop = pad;
	// Filled, the screen is cut to the room there is, whatever shape was asked for: a shape never
	// leaves room above or below it, and never narrows it, so the padding is the same on every side.
	if (!params.fill && screenSize.width > 0 && screenSize.height > 0) {
		// Whole: the box takes the recording's own shape, centred in the room.
		const aspect = screenSize.width / screenSize.height;
		const wanted = Math.max(1, Math.round(boxWidth / aspect));
		if (wanted <= roomHeight) {
			boxHeight = wanted;
			boxTop = pad + Math.round((roomHeight - wanted) / 2);
		} else {
			boxW = Math.max(1, Math.round(roomHeight * aspect));
			boxLeft = pad + Math.round((boxWidth - boxW) / 2);
		}
	}
	const screenRect = snapRect(boxLeft, boxTop, boxW, boxHeight);

	return {
		screenRect,
		webcamRect: {
			x: cameraX,
			y: cameraTop,
			width: cameraWidth,
			height: cameraHeight,
			borderRadius: Math.round(
				(Math.min(1, Math.max(0, params.roundness)) * Math.min(cameraWidth, cameraHeight)) / 2,
			),
			maskShape: "rectangle",
		},
		// Filled, the footage is cut to the box; whole, the box is the footage's own shape.
		screenCover: params.fill,
		cutoutLineY: screenRect.y + screenRect.height + gap,
	};
}

/**
 * Rounds a float rect to whole pixels by rounding its EDGES rather than its origin
 * and size independently. Adjacent boxes computed from the same float grid then keep
 * a consistent gap, and the block's outer edges land exactly where the contain-fit
 * put them, instead of drifting by a pixel per box.
 */
function snapRect(x: number, y: number, width: number, height: number): RenderRect {
	const left = Math.round(x);
	const top = Math.round(y);
	return {
		x: left,
		y: top,
		width: Math.max(1, Math.round(x + width) - left),
		height: Math.max(1, Math.round(y + height) - top),
	};
}

/**
 * The screen with nothing welded to it, contain-fitted into the padded area and centred.
 *
 * Under a frame, what fits and centres is everything the frame draws: a window's bar, a laptop's
 * deck, a monitor's stand. The padding is measured from the frame's outer edge, so at 0% the frame
 * touches the scene and never goes past it, and a lopsided frame sits in the middle as a whole.
 * The screen pays for it: it is smaller under a frame than without one.
 */
function centerScreen(
	canvasSize: Size,
	screenSize: Size,
	maxContentSize: Size,
	frame: RecordingFrame,
): RenderRect {
	if (frame === "none") {
		return centerRect({ canvasSize, size: screenSize, maxSize: maxContentSize });
	}
	const { screen, outer, element } = framedScreen(
		screenSize.width / screenSize.height,
		canvasSize,
		frame,
	);
	const scale = Math.min(
		maxContentSize.width / element.width,
		maxContentSize.height / element.height,
	);
	const originX = (canvasSize.width - element.width * scale) / 2;
	const originY = (canvasSize.height - element.height * scale) / 2;
	return snapRect(
		originX + outer[0] * scale,
		originY + outer[1] * scale,
		scale,
		screen.height * scale,
	);
}

function centerRect(params: { canvasSize: Size; size: Size; maxSize: Size }): RenderRect {
	const { canvasSize, size, maxSize } = params;
	return centerRectInBounds({
		bounds: { x: 0, y: 0, width: canvasSize.width, height: canvasSize.height },
		size,
		maxSize,
	});
}

function centerRectInBounds(params: { bounds: RenderRect; size: Size; maxSize: Size }): RenderRect {
	const { bounds, size, maxSize } = params;
	const { x: boundsX, y: boundsY, width: boundsWidth, height: boundsHeight } = bounds;
	const { width, height } = size;
	const { width: maxWidth, height: maxHeight } = maxSize;
	const scale = Math.min(maxWidth / width, maxHeight / height);
	const resolvedWidth = Math.round(width * scale);
	const resolvedHeight = Math.round(height * scale);

	if (
		maxWidth >= boundsWidth &&
		maxHeight >= boundsHeight &&
		Math.abs(boundsWidth - resolvedWidth) <= 4 &&
		Math.abs(boundsHeight - resolvedHeight) <= 4
	) {
		return {
			x: boundsX,
			y: boundsY,
			width: boundsWidth,
			height: boundsHeight,
		};
	}

	return {
		x: boundsX + Math.max(0, Math.floor((boundsWidth - resolvedWidth) / 2)),
		y: boundsY + Math.max(0, Math.floor((boundsHeight - resolvedHeight) / 2)),
		width: resolvedWidth,
		height: resolvedHeight,
	};
}

/**
 * The shape (width over height) the user gave the screen inside the frame, or null to leave it as
 * the recording's own. The block layouts (a device frame, side by side) size the screen
 * themselves, so they do not take one.
 */
/** The camera's own shape as width over height, or null to keep the camera's. */
export function webcamShapeAspect(webcamAspect: string | undefined): number | null {
	if (!webcamAspect || webcamAspect === "auto") return null;
	const parsed = parseAspectRatio(webcamAspect);
	return parsed && parsed.width > 0 && parsed.height > 0 ? parsed.width / parsed.height : null;
}

export function shapedScreenAspect(
	screenAspect: string | undefined,
	layoutPreset: WebcamLayoutPreset,
): number | null {
	if (!screenAspect || screenAspect === "auto" || screenAspect === "native") return null;
	if (isWebcamBlockLayout(layoutPreset)) return null;
	const parsed = parseAspectRatio(screenAspect);
	return parsed && parsed.width > 0 && parsed.height > 0 ? parsed.width / parsed.height : null;
}
