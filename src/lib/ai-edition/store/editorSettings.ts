// Typed read/write layer over `document.legacyEditor`.
//
// The v3 schema keeps `legacyEditor` as a `Record<string, unknown>` envelope so
// v2 projects round-trip without losing fields. The right panes and the
// per-region inspectors need a typed surface — this module provides it.
//
// The shape mirrors the legacy editor's `ProjectEditorState` so the same names
// are used everywhere; values that v3 owns directly (zoomRanges, annotations,
// transcripts, clips) stay in their dedicated fields.

import {
	type CropRegion,
	type CursorVisualSettings,
	DEFAULT_CROP_REGION,
	isWallpaperMotion,
	isWebcamBackgroundMode,
	type WallpaperMotion,
	type WebcamBackgroundMode,
	type WebcamLayoutPreset,
	type WebcamMaskShape,
	type WebcamPosition,
	type WebcamSizePreset,
} from "@/components/video-editor/types";
import { normalizeCursorThemeId, readCursorAsArrow } from "@/lib/cursor/cursorThemes";
import {
	DEFAULT_PROJECT_APPEARANCE,
	type FrameTheme,
	isFrameTheme,
	type RecordingFrame,
	readBackgroundBlur,
	readBounded,
	readRecordingFrame,
	readWebcamAnchor,
	readWebcamMask,
	type WebcamAnchor,
	type WebcamMask,
} from "@/lib/projectDefaults";
import { type AspectRatio, getAspectRatioValue } from "@/utils/aspectRatioUtils";
import type { AxcutClip, AxcutDocument } from "../schema";

// ponytail: avoid dragging in lib/exporter full surface here — we only
// need the type names. Wallpaper + cursor theme are stored as plain strings
// for the same reason (their canonical types live in lib/wallpaper and
// lib/cursor/cursorThemes as the source of truth).

/** Output gain bound, shared by the slider, this store and `finish_audio` (Rust).
 *
 *  A linear gain is the one audio setting that behaves identically on the preview's source
 *  file and on the export's assembled timeline, which is why it is the only one left. A sync
 *  offset was tried and removed: the preview seeks in SOURCE time while the export shifts the
 *  stretched, concatenated timeline, so the same value meant different delays under a speed
 *  region, and near a cut the export pulls audio across the junction while the preview cannot. */
import { type DuckRegion, isDuckRegions } from "@/lib/ai-edition/recordingDuck";

export const AUDIO_GAIN_DB_LIMIT = 12;

/** The recording's two levels go all the way down: this value and anything below it is silence. */
export const STEM_GAIN_FLOOR_DB = -60;

/** How far the system audio dips under the voice, in dB (a positive depth). */
export const DUCK_DEPTH_MIN_DB = 3;
export const DUCK_DEPTH_MAX_DB = 30;
export const DUCK_DEPTH_DEFAULT_DB = 12;

export function stemGainScalar(gainDb: number): number {
	return gainDb <= STEM_GAIN_FLOOR_DB ? 0 : 10 ** (gainDb / 20);
}
export const AUDIO_TRACK_GAIN_DB_MIN = -60;
export const AUDIO_TRACK_GAIN_DB_MAX = 12;

/** dB to the linear scalar every side of the boundary multiplies by.
 *
 *  Exported rather than written out three times. `finish_audio` applies
 *  `10f32.powf(gain_db / 20.0)` per sample; the preview feeds this to a `GainNode`; the
 *  timeline waveform scales its bars by it. The claim those three make together — that what
 *  you see is what you hear is what you export — only holds while they are the same number,
 *  and a hand-copied `10 ** (dB / 20)` is exactly how that stops being true. */
export function audioGainScalar(gainDb: number): number {
	return 10 ** (gainDb / 20);
}

/**
 * Where the webcam crop window sits inside the room its zoom leaves, 0..1 per axis:
 * 0 hard against one edge, 1 against the other, 0.5 centred.
 *
 * Stored because the rect cannot hold it. At 100% zoom the crop IS the frame, so `x` and `y`
 * are necessarily 0 and the pan they used to be read back from is gone — which meant a trip
 * down to 100% and back erased the framing the user had set. Expressed as a fraction of the
 * available room, the pan survives every zoom, including the one where it does not apply.
 *
 * This never leaves the app. `webcamCropRegion` remains the only thing the scene carries to
 * the compositor, so the preview and the export see exactly what they saw before.
 */
export interface CropPan {
	x: number;
	y: number;
}

/** Centred: the crop window sits in the middle of whatever room the zoom leaves. */
const DEFAULT_CROP_PAN: CropPan = { x: 0.5, y: 0.5 };

export type SegmentScene = "camera" | "screen";

export interface EditorSettingsSnapshot {
	wallpaper: string;
	/** Only a gradient wallpaper moves; kept as chosen when the wallpaper changes kind. */
	wallpaperMotion: WallpaperMotion;
	/** The frame drawn around the recording (window chrome or a modelled device), or "none". */
	frame: RecordingFrame;
	/** Light or dark, for whichever frame is on. Inert with `frame: "none"`. */
	frameTheme: FrameTheme;
	aspectRatio: AspectRatio;
	/** The shape of the screen inside the frame; "auto" keeps the recording's own shape. */
	screenAspect: AspectRatio;
	webcamAspect: AspectRatio;
	/**
	 * Under a fixed format that is not the recording's shape: fill the frame with a window of
	 * the recording that follows the smoothed cursor (true), or show it whole (false). `null`
	 * until the user picks a format or this option: projects from before it keep showing the
	 * recording whole. See `formatFillAvailability`.
	 */
	formatFollowCursor: boolean | null;
	shadowIntensity: number;
	backgroundBlur: number;
	motionBlurAmount: number;
	depthOfField: boolean;
	borderRadius: number;
	padding: number;
	cropRegion: CropRegion;
	webcamLayoutPreset: WebcamLayoutPreset;
	/** A segment that shows the camera alone or the screen alone, over whatever its layout is. */
	segmentScene: SegmentScene | null;
	/** The camera's proportions. `circle` and `rounded` are read as a roundness: see `readWebcamMask`. */
	webcamMaskShape: WebcamMask;
	/** 0 square corners to 1 fully round, a fraction of half the camera's short side. */
	webcamRoundness: number;
	webcamMirrored: boolean;
	webcamReactiveZoom: boolean;
	webcamSizePreset: WebcamSizePreset;
	/** Percent of the camera's height that reaches up into the screen ("Camera over screen"). */
	webcamOverlap: number;
	/** The camera's width in percent of the frame's width ("Camera over screen"); 100 is edge to edge. */
	webcamStackSize: number;
	freeScreenX: number;
	freeScreenY: number;
	freeScreenWidth: number;
	freeCamX: number;
	freeCamY: number;
	freeCamWidth: number;
	/** Picture-in-picture: the camera's distance from the border, percent of the short side. */
	webcamMargin: number;
	webcamShadow: number;
	/** "Camera over screen": the camera's own padding, in percent of the frame's width. */
	webcamPadLeft: number;
	webcamPadRight: number;
	webcamPadBottom: number;
	webcamPadTop: number;
	webcamPadLinkSides: boolean;
	webcamDodge: boolean;
	webcamPadLinkAll: boolean;
	/** The camera's padding equals the screen's padding, pixel for pixel. */
	webcamPadMatchScreen: boolean;
	/** Where the picture-in-picture camera sits, at a constant distance from the border. */
	webcamAnchor: WebcamAnchor;
	webcamCropRegion: CropRegion;
	/** Where the crop window sits in the room the zoom leaves it, 0..1 per axis.
	 *  Authoritative: `webcamCropRegion.x/y` are rebuilt from it on read. */
	webcamCropPan: CropPan;
	audioGainDb: number;
	/** The recording's own system audio and microphone, each on top of the master level, in dB. */
	recordingSystemGainDb: number;
	recordingMicGainDb: number;
	/** Dip the system audio while the voice speaks (a take with separate tracks). */
	recordingDuckEnabled: boolean;
	recordingDuckDepthDb: number;
	/** Where the voice speaks, written once when the take is first opened. null: not analysed yet. */
	recordingDuckRegions: DuckRegion[] | null;
	webcamBackgroundMode: WebcamBackgroundMode;
	webcamWallpaper: string;
	webcamBlurIntensity: number;
	cursor: CursorVisualSettings;
	cursorShow: boolean;
	cursorAutoHide: boolean;
	cursorTheme: string;
	autoFocusAll: boolean;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettingsSnapshot = {
	// Opinionated by default: the wallpaper and the padding were already on, but
	// with square corners and no shadow the recording read as a rectangle pasted
	// onto the background rather than a window floating above it (#271 reported
	// the symptom and blamed the padding). These three are the rest of that look;
	// shipping the background without them was shipping half a composition.
	...DEFAULT_PROJECT_APPEARANCE,
	cropRegion: DEFAULT_CROP_REGION,
	webcamCropRegion: DEFAULT_CROP_REGION,
	webcamCropPan: DEFAULT_CROP_PAN,
	audioGainDb: 0,
	recordingSystemGainDb: 0,
	recordingMicGainDb: 0,
	recordingDuckEnabled: true,
	recordingDuckDepthDb: DUCK_DEPTH_DEFAULT_DB,
	recordingDuckRegions: null,
	formatFollowCursor: null,
	segmentScene: null,
};

interface LegacyShape {
	wallpaper?: string;
	wallpaperMotion?: WallpaperMotion;
	/** `unknown`: it may still hold `window-light` / `window-dark` (`readRecordingFrame`). */
	frame?: unknown;
	frameTheme?: FrameTheme;
	aspectRatio?: AspectRatio;
	screenAspect?: AspectRatio;
	webcamAspect?: AspectRatio;
	formatFollowCursor?: boolean;
	shadowIntensity?: number;
	backgroundBlur?: number;
	/** Before the amount: an on/off switch. Read by `readBackgroundBlur`, never written. */
	showBlur?: boolean;
	motionBlurAmount?: number;
	depthOfField?: boolean;
	borderRadius?: number;
	padding?: number;
	cropRegion?: CropRegion;
	webcamLayoutPreset?: WebcamLayoutPreset;
	segmentScene?: SegmentScene | null;
	webcamMaskShape?: WebcamMaskShape;
	webcamRoundness?: number;
	webcamMirrored?: boolean;
	webcamReactiveZoom?: boolean;
	webcamSizePreset?: WebcamSizePreset;
	webcamOverlap?: number;
	webcamStackSize?: number;
	freeScreenX?: number;
	freeScreenY?: number;
	freeScreenWidth?: number;
	freeCamX?: number;
	freeCamY?: number;
	freeCamWidth?: number;
	webcamMargin?: number;
	webcamShadow?: number;
	webcamPadLeft?: number;
	webcamPadRight?: number;
	webcamPadBottom?: number;
	webcamPadTop?: number;
	webcamPadLinkSides?: boolean;
	webcamDodge?: boolean;
	webcamPadLinkAll?: boolean;
	webcamPadMatchScreen?: boolean;
	webcamAnchor?: WebcamAnchor;
	/** Written by builds that let the camera be dragged anywhere; read as the nearest anchor. */
	webcamPosition?: WebcamPosition | null;
	webcamCropRegion?: CropRegion;
	webcamCropPan?: CropPan;
	audioGainDb?: number;
	recordingSystemGainDb?: number;
	recordingMicGainDb?: number;
	recordingDuckEnabled?: boolean;
	recordingDuckDepthDb?: number;
	recordingDuckRegions?: DuckRegion[] | null;
	webcamBackgroundMode?: WebcamBackgroundMode;
	webcamWallpaper?: string;
	webcamBlurIntensity?: number;
	cursorSize?: number;
	cursorSmoothing?: number;
	cursorMotionBlur?: number;
	cursorClickBounce?: number;
	cursorModel3d?: boolean;
	/** `unknown`: read through `readCursorAsArrow`, which drops what this build does not know. */
	cursorAsArrow?: unknown;
	/** Written by builds with one "always use the arrow" switch; read as every kind. */
	cursorAlwaysArrow?: boolean;
	cursorClickImpact?: boolean;
	cursorClickSound?: boolean;
	cursorClickSoundGainDb?: number;
	cursorShow?: boolean;
	cursorAutoHide?: boolean;
	cursorTheme?: string;
	autoFocusAll?: boolean;
}
function isShape(value: unknown): value is LegacyShape {
	return typeof value === "object" && value !== null;
}

function isNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}
function isBoolean(v: unknown): v is boolean {
	return typeof v === "boolean";
}
function isString(v: unknown): v is string {
	return typeof v === "string";
}

/**
 * The project's layout in a frame of this format. The format is one for the whole project, and a
 * layout made for a tall frame means nothing in a wide one, so what is stored stays the choice and
 * this is what it comes to here: back in 9:16, the 9:16 layout returns. "auto" takes its shape from
 * the layout and "native" has no shape to read here, so neither changes it.
 */
export function webcamPresetForFormat(
	preset: WebcamLayoutPreset,
	aspectRatio: AspectRatio,
): WebcamLayoutPreset {
	if (aspectRatio === "auto" || aspectRatio === "native") return preset;
	if (getAspectRatioValue(aspectRatio) < 1)
		return preset === "dual-frame" ? "vertical-stack" : preset;
	if (preset === "vertical-stack") return "dual-frame";
	return preset === "cutout-stack" ? "picture-in-picture" : preset;
}

export function getEditorSettings(doc: AxcutDocument | null | undefined): EditorSettingsSnapshot {
	const legacy = isShape(doc?.legacyEditor) ? (doc.legacyEditor as LegacyShape) : null;
	const num = (v: unknown, fallback: number) => (isNumber(v) ? v : fallback);
	const bool = (v: unknown, fallback: boolean) => (isBoolean(v) ? v : fallback);
	const str = (v: unknown, fallback: string) => (isString(v) ? v : fallback);
	// `window-light` / `window-dark` were the frame AND its theme; they split here.
	const stored = readRecordingFrame(legacy?.frame);

	const defaults = DEFAULT_EDITOR_SETTINGS;
	const cursor: CursorVisualSettings = {
		size: readBounded(legacy?.cursorSize, "cursorSize", defaults.cursor.size),
		smoothing: readBounded(legacy?.cursorSmoothing, "cursorSmoothing", defaults.cursor.smoothing),
		motionBlur: readBounded(
			legacy?.cursorMotionBlur,
			"cursorMotionBlur",
			defaults.cursor.motionBlur,
		),
		clickBounce: readBounded(
			legacy?.cursorClickBounce,
			"cursorClickBounce",
			defaults.cursor.clickBounce,
		),
		// Absent in every project saved before the setting existed: those keep the flat cursor.
		model3d: bool(legacy?.cursorModel3d, DEFAULT_EDITOR_SETTINGS.cursor.model3d),
		asArrow: readCursorAsArrow(
			legacy?.cursorAsArrow,
			legacy?.cursorAlwaysArrow,
			defaults.cursor.asArrow,
		),
		clickImpact: bool(legacy?.cursorClickImpact, DEFAULT_EDITOR_SETTINGS.cursor.clickImpact),
		clickSound: bool(legacy?.cursorClickSound, DEFAULT_EDITOR_SETTINGS.cursor.clickSound),
		clickSoundGainDb: readBounded(
			legacy?.cursorClickSoundGainDb,
			"cursorClickSoundGainDb",
			defaults.cursor.clickSoundGainDb,
		),
		autoHide: bool(legacy?.cursorAutoHide, DEFAULT_EDITOR_SETTINGS.cursorAutoHide),
	};

	// The pan is authoritative and the rect's offset is rebuilt from it, so the two cannot
	// drift apart — on disk, or in a patch that wrote one and not the other. Only the SIZE
	// survives from the stored rect; `pan * (1 - size)` is a position that cannot leave the
	// frame, which is why nothing here clamps it.
	// `circle` and `rounded` were a proportion and a rounding in one value; they split here.
	const webcamMask = readWebcamMask(legacy?.webcamMaskShape, legacy?.webcamRoundness);

	const storedCrop = normaliseCropRegion(legacy?.webcamCropRegion);
	const webcamCropPan = normaliseCropPan(legacy?.webcamCropPan, storedCrop);
	const webcamCrop: CropRegion = {
		...storedCrop,
		x: webcamCropPan.x * (1 - storedCrop.width),
		y: webcamCropPan.y * (1 - storedCrop.height),
	};

	return {
		wallpaper: str(legacy?.wallpaper, DEFAULT_EDITOR_SETTINGS.wallpaper),
		wallpaperMotion: isWallpaperMotion(legacy?.wallpaperMotion)
			? legacy.wallpaperMotion
			: DEFAULT_EDITOR_SETTINGS.wallpaperMotion,
		// An unknown value (a frame a newer build added) reads as no frame, like the compositor.
		// `window-light` / `window-dark` split into a frame PLUS a theme, so a project written
		// before the theme existed opens with the look it had (`readRecordingFrame`).
		frame: stored?.frame ?? DEFAULT_EDITOR_SETTINGS.frame,
		frameTheme: isFrameTheme(legacy?.frameTheme)
			? legacy.frameTheme
			: (stored?.theme ?? DEFAULT_EDITOR_SETTINGS.frameTheme),
		aspectRatio: legacy?.aspectRatio ?? DEFAULT_EDITOR_SETTINGS.aspectRatio,
		screenAspect: legacy?.screenAspect ?? DEFAULT_EDITOR_SETTINGS.screenAspect,
		segmentScene:
			legacy?.segmentScene === "camera" || legacy?.segmentScene === "screen"
				? legacy.segmentScene
				: null,
		webcamAspect: legacy?.webcamAspect ?? DEFAULT_EDITOR_SETTINGS.webcamAspect,
		formatFollowCursor:
			typeof legacy?.formatFollowCursor === "boolean" ? legacy.formatFollowCursor : null,
		// Every number below is read into its `SETTING_BOUNDS` range: the slider's range, and the
		// one a preset and the agent are held to. A stored value past it plays at the bound.
		shadowIntensity: readBounded(
			legacy?.shadowIntensity,
			"shadowIntensity",
			defaults.shadowIntensity,
		),
		backgroundBlur: readBackgroundBlur(legacy, defaults.backgroundBlur),
		motionBlurAmount: readBounded(
			legacy?.motionBlurAmount,
			"motionBlurAmount",
			defaults.motionBlurAmount,
		),
		depthOfField: bool(legacy?.depthOfField, DEFAULT_EDITOR_SETTINGS.depthOfField),
		borderRadius: readBounded(legacy?.borderRadius, "borderRadius", defaults.borderRadius),
		padding: readBounded(legacy?.padding, "padding", defaults.padding),
		cropRegion: legacy?.cropRegion ?? DEFAULT_EDITOR_SETTINGS.cropRegion,
		webcamLayoutPreset: webcamPresetForFormat(
			legacy?.webcamLayoutPreset ?? DEFAULT_EDITOR_SETTINGS.webcamLayoutPreset,
			legacy?.aspectRatio ?? DEFAULT_EDITOR_SETTINGS.aspectRatio,
		),
		webcamMaskShape: webcamMask.shape,
		webcamRoundness: webcamMask.roundness,
		webcamMirrored: bool(legacy?.webcamMirrored, DEFAULT_EDITOR_SETTINGS.webcamMirrored),
		webcamReactiveZoom: bool(
			legacy?.webcamReactiveZoom,
			DEFAULT_EDITOR_SETTINGS.webcamReactiveZoom,
		),
		webcamSizePreset: readBounded(
			legacy?.webcamSizePreset,
			"webcamSizePreset",
			defaults.webcamSizePreset,
		),
		webcamOverlap: readBounded(legacy?.webcamOverlap, "webcamOverlap", defaults.webcamOverlap),
		webcamStackSize: readBounded(
			legacy?.webcamStackSize,
			"webcamStackSize",
			defaults.webcamStackSize,
		),
		freeScreenX: readBounded(legacy?.freeScreenX, "freeScreenX", defaults.freeScreenX),
		freeScreenY: readBounded(legacy?.freeScreenY, "freeScreenY", defaults.freeScreenY),
		freeScreenWidth: readBounded(
			legacy?.freeScreenWidth,
			"freeScreenWidth",
			defaults.freeScreenWidth,
		),
		freeCamX: readBounded(legacy?.freeCamX, "freeCamX", defaults.freeCamX),
		freeCamY: readBounded(legacy?.freeCamY, "freeCamY", defaults.freeCamY),
		freeCamWidth: readBounded(legacy?.freeCamWidth, "freeCamWidth", defaults.freeCamWidth),
		webcamMargin: readBounded(legacy?.webcamMargin, "webcamMargin", defaults.webcamMargin),
		webcamShadow: readBounded(legacy?.webcamShadow, "webcamShadow", defaults.webcamShadow),
		webcamPadLeft: readBounded(legacy?.webcamPadLeft, "webcamPadLeft", defaults.webcamPadLeft),
		webcamPadRight: readBounded(legacy?.webcamPadRight, "webcamPadRight", defaults.webcamPadRight),
		webcamPadBottom: readBounded(
			legacy?.webcamPadBottom,
			"webcamPadBottom",
			defaults.webcamPadBottom,
		),
		webcamPadTop: readBounded(legacy?.webcamPadTop, "webcamPadTop", defaults.webcamPadTop),
		webcamPadLinkSides: bool(legacy?.webcamPadLinkSides, defaults.webcamPadLinkSides),
		webcamDodge: bool(legacy?.webcamDodge, defaults.webcamDodge),
		webcamPadLinkAll: bool(legacy?.webcamPadLinkAll, defaults.webcamPadLinkAll),
		webcamPadMatchScreen: bool(legacy?.webcamPadMatchScreen, defaults.webcamPadMatchScreen),
		webcamAnchor: readWebcamAnchor(legacy?.webcamAnchor, legacy?.webcamPosition),
		webcamCropRegion: webcamCrop,
		webcamCropPan: webcamCropPan,
		// Same bound the slider offers and the native `finish_audio` clamps to. Two
		// different ranges for one value is how a project ends up exporting a gain the
		// UI cannot display.
		audioGainDb: Math.min(
			AUDIO_GAIN_DB_LIMIT,
			Math.max(-AUDIO_GAIN_DB_LIMIT, num(legacy?.audioGainDb, 0)),
		),
		recordingSystemGainDb: Math.min(
			AUDIO_GAIN_DB_LIMIT,
			Math.max(STEM_GAIN_FLOOR_DB, num(legacy?.recordingSystemGainDb, 0)),
		),
		recordingMicGainDb: Math.min(
			AUDIO_GAIN_DB_LIMIT,
			Math.max(STEM_GAIN_FLOOR_DB, num(legacy?.recordingMicGainDb, 0)),
		),
		recordingDuckRegions: isDuckRegions(legacy?.recordingDuckRegions)
			? legacy.recordingDuckRegions
			: null,
		recordingDuckEnabled: bool(legacy?.recordingDuckEnabled, defaults.recordingDuckEnabled),
		recordingDuckDepthDb: Math.min(
			DUCK_DEPTH_MAX_DB,
			Math.max(DUCK_DEPTH_MIN_DB, num(legacy?.recordingDuckDepthDb, DUCK_DEPTH_DEFAULT_DB)),
		),
		webcamBackgroundMode: isWebcamBackgroundMode(legacy?.webcamBackgroundMode)
			? legacy.webcamBackgroundMode
			: DEFAULT_EDITOR_SETTINGS.webcamBackgroundMode,
		webcamWallpaper: str(legacy?.webcamWallpaper, DEFAULT_EDITOR_SETTINGS.webcamWallpaper),
		// Unclamped, a stored 1000 reached `blur(25000px)` on the preview canvas and wedged the
		// compositing thread.
		webcamBlurIntensity: readBounded(
			legacy?.webcamBlurIntensity,
			"webcamBlurIntensity",
			defaults.webcamBlurIntensity,
		),
		cursor,
		cursorShow: bool(legacy?.cursorShow, DEFAULT_EDITOR_SETTINGS.cursorShow),
		cursorAutoHide: bool(legacy?.cursorAutoHide, DEFAULT_EDITOR_SETTINGS.cursorAutoHide),
		// A pack the app no longer ships reads as the default art, which is what the renderer
		// draws for it anyway. Left raw, the id would also switch off the modelled cursor: the
		// compositor only builds it for the default theme.
		cursorTheme: normalizeCursorThemeId(legacy?.cursorTheme),
		autoFocusAll: bool(legacy?.autoFocusAll, DEFAULT_EDITOR_SETTINGS.autoFocusAll),
	};
}
export interface EditorSettingsPatch {
	wallpaper?: string;
	wallpaperMotion?: WallpaperMotion;
	frame?: RecordingFrame;
	frameTheme?: FrameTheme;
	aspectRatio?: AspectRatio;
	screenAspect?: AspectRatio;
	webcamAspect?: AspectRatio;
	formatFollowCursor?: boolean;
	shadowIntensity?: number;
	backgroundBlur?: number;
	motionBlurAmount?: number;
	depthOfField?: boolean;
	borderRadius?: number;
	padding?: number;
	cropRegion?: CropRegion;
	webcamLayoutPreset?: WebcamLayoutPreset;
	segmentScene?: SegmentScene | null;
	webcamMaskShape?: WebcamMask;
	webcamRoundness?: number;
	webcamMirrored?: boolean;
	webcamReactiveZoom?: boolean;
	webcamSizePreset?: WebcamSizePreset;
	webcamOverlap?: number;
	webcamStackSize?: number;
	freeScreenX?: number;
	freeScreenY?: number;
	freeScreenWidth?: number;
	freeCamX?: number;
	freeCamY?: number;
	freeCamWidth?: number;
	webcamMargin?: number;
	webcamShadow?: number;
	webcamPadLeft?: number;
	webcamPadRight?: number;
	webcamPadBottom?: number;
	webcamPadTop?: number;
	webcamPadLinkSides?: boolean;
	webcamDodge?: boolean;
	webcamPadLinkAll?: boolean;
	webcamPadMatchScreen?: boolean;
	webcamAnchor?: WebcamAnchor;
	webcamCropRegion?: CropRegion;
	webcamCropPan?: CropPan;
	audioGainDb?: number;
	recordingSystemGainDb?: number;
	recordingMicGainDb?: number;
	recordingDuckEnabled?: boolean;
	recordingDuckDepthDb?: number;
	recordingDuckRegions?: DuckRegion[] | null;
	webcamBackgroundMode?: WebcamBackgroundMode;
	webcamWallpaper?: string;
	webcamBlurIntensity?: number;
	cursor?: Partial<CursorVisualSettings> & { theme?: string; show?: boolean; autoHide?: boolean };
	cursorAutoHide?: boolean;
	autoFocusAll?: boolean;
}

function nextLegacy(current: LegacyShape | null, patch: EditorSettingsPatch): LegacyShape {
	const base: LegacyShape = current ?? {};
	// Spread, but only over keys the patch actually set — a plain {...base,
	// ...patch} would write undefined over a value the caller left alone.
	// `cursor` is handled separately below: its keys are renamed (size ->
	// cursorSize), so it is not a straight passthrough.
	// The Pick keeps what the 16 `if`s used to check: a patch key with no
	// LegacyShape counterpart fails to compile instead of leaking into the
	// persisted blob.
	const { cursor: _cursor, ...rest } = patch;
	const defined = Object.fromEntries(
		Object.entries(rest).filter(([, v]) => v !== undefined),
	) as Partial<Pick<LegacyShape, keyof Omit<EditorSettingsPatch, "cursor">>>;
	const next: LegacyShape = { ...base, ...defined };
	if (patch.cursor) {
		const c = patch.cursor;
		if (c.size !== undefined) next.cursorSize = c.size;
		if (c.smoothing !== undefined) next.cursorSmoothing = c.smoothing;
		if (c.motionBlur !== undefined) next.cursorMotionBlur = c.motionBlur;
		if (c.clickBounce !== undefined) next.cursorClickBounce = c.clickBounce;
		if (c.model3d !== undefined) next.cursorModel3d = c.model3d;
		if (c.asArrow !== undefined) {
			next.cursorAsArrow = c.asArrow;
			// The kinds now say it all; the old switch would only contradict them.
			delete next.cursorAlwaysArrow;
		}
		if (c.clickImpact !== undefined) next.cursorClickImpact = c.clickImpact;
		if (c.clickSound !== undefined) next.cursorClickSound = c.clickSound;
		if (c.clickSoundGainDb !== undefined) next.cursorClickSoundGainDb = c.clickSoundGainDb;
		if (c.theme !== undefined) next.cursorTheme = c.theme;
		if (c.show !== undefined) next.cursorShow = c.show;
		if (c.autoHide !== undefined) next.cursorAutoHide = c.autoHide;
	}
	if (patch.cursorAutoHide !== undefined) next.cursorAutoHide = patch.cursorAutoHide;
	return next;
}

export function patchEditorSettings(doc: AxcutDocument, patch: EditorSettingsPatch): AxcutDocument {
	const current = isShape(doc.legacyEditor) ? (doc.legacyEditor as LegacyShape) : null;
	return {
		...doc,
		legacyEditor: nextLegacy(current, patch) as Record<string, unknown>,
	};
}

/** What one segment can have of its own. The rest is the project's: format, background, cursor, audio. */
export const SEGMENT_LOOK_KEYS = [
	"segmentScene",
	"frame",
	"frameTheme",
	"shadowIntensity",
	"borderRadius",
	"padding",
	"screenAspect",
	"webcamLayoutPreset",
	"webcamMaskShape",
	"webcamRoundness",
	"webcamMirrored",
	"webcamReactiveZoom",
	"webcamSizePreset",
	"webcamAnchor",
	"webcamAspect",
	"webcamMargin",
	"webcamShadow",
	"webcamOverlap",
	"webcamStackSize",
	"freeScreenX",
	"freeScreenY",
	"freeScreenWidth",
	"freeCamX",
	"freeCamY",
	"freeCamWidth",
	"webcamPadLeft",
	"webcamPadRight",
	"webcamPadBottom",
	"webcamPadTop",
	"webcamPadLinkSides",
	"webcamPadLinkAll",
	"webcamPadMatchScreen",
	"webcamDodge",
	"webcamCropRegion",
	"webcamCropPan",
	"webcamBackgroundMode",
	"webcamBlurIntensity",
] as const satisfies readonly (keyof LegacyShape)[];

const LOOK_KEY_SET: ReadonlySet<string> = new Set(SEGMENT_LOOK_KEYS);

/** The clip the program is showing, which is the one the controls act on. */
export function clipUnderPlayhead(
	doc: AxcutDocument | null | undefined,
	timeSec: number,
): AxcutClip | null {
	const clips = doc?.timeline.clips ?? [];
	return (
		clips.find((clip) => clip.timelineStartSec <= timeSec && timeSec < clip.timelineEndSec) ??
		clips.at(-1) ??
		null
	);
}

/** The settings as one clip sees them: the project's, with its own look on top. */
export function getClipEditorSettings(
	doc: AxcutDocument,
	clip: Pick<AxcutClip, "look"> | null | undefined,
): EditorSettingsSnapshot {
	if (!clip?.look) return getEditorSettings(doc);
	const legacy = isShape(doc.legacyEditor) ? doc.legacyEditor : {};
	return getEditorSettings({ ...doc, legacyEditor: { ...legacy, ...clip.look } });
}

/** What in a patch belongs to a segment, and what to the project. */
export function splitLookPatch(patch: EditorSettingsPatch): {
	look: EditorSettingsPatch;
	rest: EditorSettingsPatch;
} {
	const look: Record<string, unknown> = {};
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(patch)) {
		(LOOK_KEY_SET.has(key) ? look : rest)[key] = value;
	}
	// Picking a layout leaves "the camera alone" or "the screen alone".
	if (look.webcamLayoutPreset !== undefined && look.segmentScene === undefined) {
		look.segmentScene = null;
	}
	return { look, rest };
}

/** `patch` on one clip. A clip stores only where it differs from the project. */
export function patchClipLook(
	doc: AxcutDocument,
	clipId: string,
	patch: EditorSettingsPatch,
): AxcutDocument {
	const clip = doc.timeline.clips.find((c) => c.id === clipId);
	if (!clip) return doc;
	const project = (isShape(doc.legacyEditor) ? doc.legacyEditor : {}) as Record<string, unknown>;
	const merged = nextLegacy({ ...project, ...clip.look } as LegacyShape, patch) as Record<
		string,
		unknown
	>;
	const look: Record<string, unknown> = {};
	for (const key of SEGMENT_LOOK_KEYS) {
		const value = merged[key];
		if (value !== undefined && JSON.stringify(value) !== JSON.stringify(project[key] ?? null)) {
			look[key] = value;
		}
	}
	const { look: _old, ...rest } = clip;
	const next = Object.keys(look).length > 0 ? { ...rest, look } : rest;
	return {
		...doc,
		timeline: {
			...doc.timeline,
			clips: doc.timeline.clips.map((c) => (c.id === clipId ? next : c)),
		},
	};
}

/** One clip's look becomes the project's, so every clip and every clip to come has it. */
export function applyLookToAllClips(doc: AxcutDocument, clipId: string): AxcutDocument {
	const clip = doc.timeline.clips.find((c) => c.id === clipId);
	if (!clip) return doc;
	const project = isShape(doc.legacyEditor) ? doc.legacyEditor : {};
	return {
		...doc,
		legacyEditor: { ...project, ...clip.look },
		timeline: {
			...doc.timeline,
			clips: doc.timeline.clips.map(({ look: _look, ...rest }) => rest),
		},
	};
}

const MIN_CROP_SIZE = 0.01;

/**
 * Recovers the pan of a crop rect authored before the pan was stored.
 *
 * `x / (1 - width)` is the expression the pane used to derive the slider's value from the
 * rect on every render, and it has to stay that expression: every project on disk today has
 * a rect and no pan, so anything else here would silently reframe them on first open. A
 * full-frame crop has no room to sit in, so it reports centred — the one case where the
 * answer is arbitrary, and the one case where nothing depends on it.
 */
export function panOfCropRegion(crop: CropRegion): CropPan {
	// Guarded at 1 and not at some epsilon below it: the zoom slider is integer percent, so
	// the smallest window short of full frame is 100/101 and leaves ~0.0099 of room — a
	// perfectly ordinary divisor that a wider guard would throw away as if it were centred.
	// `normaliseCropRegion` keeps `x + width <= 1`, so the quotient is in range by
	// construction; the clamp is for a hand-edited document that got there another way.
	const axis = (offset: number, size: number) =>
		size >= 1 ? 0.5 : Math.min(1, Math.max(0, offset / (1 - size)));
	return { x: axis(crop.x, crop.width), y: axis(crop.y, crop.height) };
}

function normaliseCropPan(value: unknown, crop: CropRegion): CropPan {
	if (!value || typeof value !== "object") return panOfCropRegion(crop);
	const candidate = value as Record<string, unknown>;
	const fallback = panOfCropRegion(crop);
	return {
		x: isNumber(candidate.x) ? Math.min(1, Math.max(0, candidate.x)) : fallback.x,
		y: isNumber(candidate.y) ? Math.min(1, Math.max(0, candidate.y)) : fallback.y,
	};
}

function normaliseCropRegion(value: unknown): CropRegion {
	if (!value || typeof value !== "object") return DEFAULT_CROP_REGION;
	const candidate = value as Record<string, unknown>;
	const x = isNumber(candidate.x) ? Math.min(1 - MIN_CROP_SIZE, Math.max(0, candidate.x)) : 0;
	const y = isNumber(candidate.y) ? Math.min(1 - MIN_CROP_SIZE, Math.max(0, candidate.y)) : 0;
	const width = isNumber(candidate.width)
		? Math.min(1 - x, Math.max(MIN_CROP_SIZE, candidate.width))
		: 1 - x;
	const height = isNumber(candidate.height)
		? Math.min(1 - y, Math.max(MIN_CROP_SIZE, candidate.height))
		: 1 - y;
	return { x, y, width, height };
}
