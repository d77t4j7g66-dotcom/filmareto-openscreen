/**
 * "Frame position": where the cut of a picture that does not fit the format sits, placed by hand.
 *
 * It frames the CAMERA, whatever the take (1.2.0 Beta feedback). It used to place the cut of the
 * main take, which in a screen recording is the screen: with the camera full screen in 9:16 it
 * moved the screen under it, and the person stayed out of frame. So:
 *
 * - a talking head's take IS the camera, and the control places its own cut (`fillPosition`,
 *   the project's or the clip's look), as it always did;
 * - in a screen take it places the camera's cut, wherever the camera is cut to fit its box: the
 *   whole frame while the camera fills it, or a slot of a vertical layout. That is
 *   `webcamCoverPan` while the camera crop is the whole picture, and the crop's own pan
 *   (`webcamCropPan`) once it is zoomed, since the compositor centres the cover inside a zoomed
 *   crop (`webcam_source_rect_zoomed`);
 * - the screen's own cut is Auto only, following the pointer or the face. A fixed position a
 *   screen take still carries from before is not drawn (`fillPositionApplies`), so nothing on
 *   screen is left placed by a control that is no longer there.
 *
 * Pure, so the camera pane and the scene decide from the same rules.
 */

import type { AxcutAsset, AxcutClip, AxcutDocument } from "../schema";
import {
	type CropPan,
	type EditorSettingsPatch,
	type EditorSettingsSnapshot,
	getClipEditorSettings,
	getEditorSettings,
} from "../store/editorSettings";
import { assetCameraSource } from "../timeline/camera";
import { mainTakeIsCamera } from "./cameraTake";
import {
	type Dims,
	type FillTravel,
	fillCentreAt,
	fillCutAxes,
	fillShareOf,
	fillTravel,
	isFormatFillActive,
	resolveAspectRatioValue,
} from "./outputFormat";

export { mainTakeIsCamera } from "./cameraTake";

/**
 * Whether a fixed `fillPosition` places this take's cut. Only a camera take's: a screen's cut
 * follows the pointer or the face, and a position stored on one before the control moved to the
 * camera is ignored rather than drawn with nothing left to reset it.
 */
export function fillPositionApplies(asset: AxcutAsset | null | undefined): boolean {
	return mainTakeIsCamera(asset);
}

/** The setting the control writes, by what it places. */
export type FramePositionKey = "fillPosition" | "webcamCoverPan" | "webcamCropPan";

export interface FramePositionTarget {
	/** "take": the talking head's own picture. "camera": the camera beside a screen. */
	kind: "take" | "camera";
	key: FramePositionKey;
	/** The axes the cut can move on, one slider each. */
	axes: { horizontal: boolean; vertical: boolean };
	/** Whether the control has an Auto: off a zoomed crop, which is always placed somewhere. */
	auto: boolean;
	/** `fillPosition` stores a centre inside this travel; the pans store a share of the room. */
	travel: FillTravel | null;
	/**
	 * The camera is drawn mirrored (`webcamMirrored`, the clip's own look included): the pans are
	 * in the camera's own picture, so "Left to right" runs the other way across it, to follow the
	 * picture as it is seen.
	 */
	mirrored: boolean;
}

/** A camera's shape when its file never said: the layout's own fallback. */
const FALLBACK_CAMERA: Dims = { width: 1280, height: 720 };

/** The frame is narrower than the camera, so the camera is cut to it as it fills the frame. */
function cameraCutNarrower(document: AxcutDocument, asset: AxcutAsset, dims: Record<string, Dims>) {
	const frame = resolveAspectRatioValue(document, getEditorSettings(document).aspectRatio, dims);
	const { width, height } =
		asset.cameraTrack?.width && asset.cameraTrack.height
			? { width: asset.cameraTrack.width, height: asset.cameraTrack.height }
			: FALLBACK_CAMERA;
	// Any format narrower than the camera cuts it, a square one included.
	return width / height > frame * 1.01;
}

/**
 * What "Frame position" places for `clip`, or `null` when there is nothing to place.
 *
 * - A camera take: its own cut, while the format is filled (as before the move).
 * - A screen take with a visible camera: the camera's cut, while the output is vertical and the
 *   camera wider than it, so the camera filling the frame is cut narrower than it was filmed.
 * - Anything else (a screen with no camera, a hidden camera, a landscape output): nothing.
 */
export function framePositionTarget(
	document: AxcutDocument,
	clip: AxcutClip | null | undefined,
	probedAssetDims: Record<string, Dims> = {},
): FramePositionTarget | null {
	if (!clip) return null;
	const asset = document.assets.find((a) => a.id === clip.assetId);
	if (!asset) return null;
	if (mainTakeIsCamera(asset)) {
		if (!isFormatFillActive(document, probedAssetDims)) return null;
		const axes = fillCutAxes(document, clip, probedAssetDims);
		if (!axes.horizontal && !axes.vertical) return null;
		return {
			kind: "take",
			key: "fillPosition",
			axes,
			auto: true,
			travel: fillTravel(document, clip, probedAssetDims),
			mirrored: false,
		};
	}
	if (assetCameraSource(asset).path === "") return null;
	if (!cameraCutNarrower(document, asset, probedAssetDims)) return null;
	const own = getClipEditorSettings(document, clip);
	// A zoomed crop is placed by the "Webcam crop" framing below it, which moves the rect it
	// cuts; the compositor centres the cover inside a zoomed crop, so the pan here would move
	// nothing. Same threshold as the compositor's "whole crop" and the thumbnail's `roomy`.
	if (own.webcamCropRegion.width < 0.999) return null;
	return {
		kind: "camera",
		key: "webcamCoverPan",
		axes: { horizontal: true, vertical: false },
		auto: true,
		travel: null,
		mirrored: own.webcamMirrored,
	};
}

/**
 * Whether any talking head on the timeline has a cut to place: the camera pane is offered for it
 * even though the project has no camera of a screen take to arrange. The editor asks on every
 * store change, so the cheap test goes first and the fill is checked once.
 */
export function hasTakeFramePosition(
	document: AxcutDocument,
	probedAssetDims: Record<string, Dims> = {},
): boolean {
	const assetById = new Map(document.assets.map((a) => [a.id, a]));
	const takes = document.timeline.clips.filter((c) => mainTakeIsCamera(assetById.get(c.assetId)));
	if (takes.length === 0 || !isFormatFillActive(document, probedAssetDims)) return false;
	return takes.some((clip) => {
		const axes = fillCutAxes(document, clip, probedAssetDims);
		return axes.horizontal || axes.vertical;
	});
}

/** The position the control shows from `settings`; `null` is Auto. */
export function framePositionValue(
	target: FramePositionTarget,
	settings: EditorSettingsSnapshot,
): CropPan | null {
	return settings[target.key];
}

/** Where a cut placed by hand starts when Auto is turned off: where Auto rests with no pointer. */
export function framePositionStart(
	target: FramePositionTarget,
	face?: { x: number; y: number } | null,
): CropPan {
	if (!target.travel) return { x: 0.5, y: 0.5 };
	const start = (range: { min: number; max: number }, at?: number) =>
		Math.min(range.max, Math.max(range.min, at ?? (range.min + range.max) / 2));
	return { x: start(target.travel.x, face?.x), y: start(target.travel.y, face?.y) };
}

/** A pan share as seen: across a mirrored camera, the left of the picture is the right of the file. */
function seen(target: FramePositionTarget, axis: "x" | "y", share: number): number {
	const clamped = Math.min(1, Math.max(0, share));
	return target.mirrored && axis === "x" ? 1 - clamped : clamped;
}

/** The slider share (0 the start of the travel, 1 its end) a stored position sits at. */
export function framePositionShare(
	target: FramePositionTarget,
	axis: "x" | "y",
	value: CropPan,
): number {
	if (target.travel) return fillShareOf(target.travel[axis], value[axis]);
	return seen(target, axis, value[axis]);
}

/** `value` with one axis moved to a slider share. */
export function framePositionAt(
	target: FramePositionTarget,
	axis: "x" | "y",
	share: number,
	value: CropPan,
): CropPan {
	const next = target.travel ? fillCentreAt(target.travel[axis], share) : seen(target, axis, share);
	return { ...value, [axis]: next };
}

/**
 * The patch that places the cut at `next` (`null`: Auto). The crop's pan is written with the rect
 * it places, in one patch, as the framing thumbnail does, so a half-written pair never reaches
 * disk; `settings` gives the zoom it keeps.
 */
export function framePositionPatch(
	target: FramePositionTarget,
	settings: EditorSettingsSnapshot,
	next: CropPan | null,
): EditorSettingsPatch {
	if (target.key === "fillPosition") return { fillPosition: next };
	if (target.key === "webcamCoverPan") return { webcamCoverPan: next };
	const pan = next ?? { x: 0.5, y: 0.5 };
	const { width, height } = settings.webcamCropRegion;
	return {
		webcamCropPan: pan,
		webcamCropRegion: { x: pan.x * (1 - width), y: pan.y * (1 - height), width, height },
	};
}

/** Whether `key` places this clip's picture at all: what the "own position" count counts. */
function positionApplies(key: FramePositionKey, asset: AxcutAsset | undefined): boolean {
	return key === "fillPosition" ? fillPositionApplies(asset) : assetCameraSource(asset).path !== "";
}

/** The clips whose look sets a position of their own for `key` (null, Auto, included) that shows. */
export function clipsWithOwnFramePosition(
	document: AxcutDocument,
	key: FramePositionKey,
): AxcutClip[] {
	const assetById = new Map(document.assets.map((a) => [a.id, a]));
	return document.timeline.clips.filter(
		(clip) => !!clip.look && key in clip.look && positionApplies(key, assetById.get(clip.assetId)),
	);
}

/**
 * Every clip follows the project's position again: `key` is dropped from their looks. Only the
 * position goes; a zoomed crop's own size stays, since the rect's offset is rebuilt from the pan.
 */
export function clearOwnFramePositions(
	document: AxcutDocument,
	key: FramePositionKey,
): AxcutDocument {
	const own = new Set(clipsWithOwnFramePosition(document, key).map((clip) => clip.id));
	if (own.size === 0) return document;
	return {
		...document,
		timeline: {
			...document.timeline,
			clips: document.timeline.clips.map((clip) => {
				if (!own.has(clip.id) || !clip.look) return clip;
				const { [key]: _own, ...look } = clip.look as Record<string, unknown>;
				const { look: _old, ...rest } = clip;
				return Object.keys(look).length > 0 ? { ...rest, look } : rest;
			}),
		},
	};
}
