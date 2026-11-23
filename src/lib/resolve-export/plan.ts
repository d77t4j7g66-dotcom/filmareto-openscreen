import type { SceneBackground, SceneDescription } from "@/native/sceneDescription";

/** The timeline rate of every Resolve export (the 1.2.0 capture standard). */
export const RESOLVE_FPS = 30;
/** Frames of media kept on each side of a clip for samples; clamping to the file happens later. */
export const RESOLVE_HANDLE_FRAMES = 90;

/** The short side of the Resolve timeline, whatever the project's aspect. */
export const RESOLVE_SHORT_SIDE = 1080;

const evenPx = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/**
 * The timeline's size: the project's aspect with the short side at 1080, both sides even.
 * 9:16 gives 1080x1920, 16:9 gives 1920x1080.
 */
export function resolveTimelineSize(output: { width: number; height: number }): {
	width: number;
	height: number;
} {
	const w = output.width > 0 ? output.width : 16;
	const h = output.height > 0 ? output.height : 9;
	if (w >= h) return { width: evenPx((RESOLVE_SHORT_SIDE * w) / h), height: RESOLVE_SHORT_SIDE };
	return { width: RESOLVE_SHORT_SIDE, height: evenPx((RESOLVE_SHORT_SIDE * h) / w) };
}

/**
 * Whole frames of a duration in seconds. Rounds (a 432.53 s take is 12976 frames, not 12975); the
 * 1e-6 keeps a duration exactly half a frame over from rounding up.
 */
export function framesOfSeconds(sec: number, fps: number = RESOLVE_FPS): number {
	return Math.max(0, Math.round(sec * fps - 1e-6));
}

// Same floor as `regions.rs` MIN_SPEED_SEGMENT_SEC: no zero-width slivers at region boundaries.
const MIN_SEGMENT_SEC = 0.0001;

export interface ResolveCamera {
	mediaSourcePath: string;
	key: string;
	/** Camera media frame for screen media frame f is `f - offsetFrames`. */
	offsetFrames: number;
	/** Not retimed with the segment's speed, but own render when the segment is retimed. */
	retimed: boolean;
	/** First camera media frame on the clip (0 when delayed or retimed). */
	mediaStartFrame: number;
	/** Timeline frames; a camera that starts late is delayed and shorter than its segment. */
	recordFrame: number;
	frames: number;
}

export interface ResolveSegment {
	/** "seg-001"... one data file per segment, so a duplicated range gets its own. */
	key: string;
	clipIndex: number;
	/** The V2 clip is always "screen"; a camera-only take rides V2 with no camera. */
	role: "screen";
	mediaSourcePath: string;
	/** speed != 1: the media is a new file Task 3 renders for this piece only. */
	retimed: boolean;
	speed: number;
	srcStartSec: number;
	srcEndSec: number;
	/** The frame the decoder shows at the first programme frame in the original CFR-30 file, or 0 in a retimed render. */
	mediaStartFrame: number;
	/** Programme seconds where the span starts (continuous across clips). */
	outputStartSec: number;
	/** Timeline frames from the programme grid: framesDue(outputEnd) - framesDue(outputStart). */
	frames: number;
	/** Programme grid frame of the span's first frame: framesDue(outputStartSec). */
	recordFrame: number;
	handleFrames: number;
	/** `<screen>.cursor.json`; the caller checks that it exists. */
	cursorPath: string | null;
	camera: ResolveCamera | null;
}

export interface ResolveAudioClip {
	/** "voice-001"... */
	key: string;
	sourcePath: string;
	/** The take (screen recording) this voice belongs to: its own path, even when the voice is the mic WAV. */
	takePath: string;
	retimed: boolean;
	speed: number;
	srcStartSec: number;
	srcEndSec: number;
	mediaStartFrame: number;
	frames: number;
	recordFrame: number;
	track: 1;
}

export interface ResolveSpan {
	/** V1 / V4 clips span the whole timeline. */
	startFrame: 0;
	frames: number;
}

export interface ResolvePlan {
	fps: 30;
	segments: ResolveSegment[];
	audio: ResolveAudioClip[];
	durationFrames: number;
	background: SceneBackground;
	/** V1: the background still spans the timeline. */
	backgroundSpan: ResolveSpan;
	/** V4: the overlay file spans the timeline when requested, otherwise null. */
	overlaySpan: ResolveSpan | null;
}

export interface PlanOptions {
	fps: 30;
	/** The separately recorded mic WAV for a take, or null to use the screen file's own audio. */
	micWavPathFor?: (videoPath: string) => string | null;
	overlay: boolean;
}

interface Piece {
	start: number;
	end: number;
	speed: number;
	outputStart: number;
	outputEnd: number;
}

/** regions.rs SPEED_FRAME_EPSILON_SEC: a frame is due only if more than 1 ms of programme remains. */
export const SPEED_FRAME_EPSILON_SEC = 0.001;

/** regions.rs `frames_due`: grid frames due before programme time `t`. */
export function framesDue(t: number, fps: number): number {
	return Math.max(0, Math.ceil((t - SPEED_FRAME_EPSILON_SEC) * fps));
}

/** Splits one clip window by its speed regions, like `speed_segments_for_window` (regions.rs). */
function splitWindow(
	regions: ReadonlyArray<{ startSec: number; endSec: number; speed: number }>,
	start: number,
	end: number,
	outputStartSec: number,
): Piece[] {
	if (!(end > start)) return [];
	const overlapping = regions
		.filter((r) => r.startSec < end && r.endSec > start)
		.sort((a, b) => a.startSec - b.startSec);
	const out: Piece[] = [];
	let outputSec = outputStartSec;
	// Port of `push_speed_segment`: outputSec advances only for spans that are kept.
	const push = (s: number, e: number, speed: number) => {
		if (e - s <= MIN_SEGMENT_SEC) return;
		const outputStart = outputSec;
		outputSec += (e - s) / speed;
		out.push({ start: s, end: e, speed, outputStart, outputEnd: outputSec });
	};
	let cursor = start;
	for (const r of overlapping) {
		const s = Math.max(r.startSec, start, cursor);
		const e = Math.min(r.endSec, end);
		if (e <= s) continue;
		if (s > cursor) push(cursor, s, 1);
		push(s, e, Number.isFinite(r.speed) && r.speed > 0 ? r.speed : 1);
		cursor = e;
	}
	if (cursor < end) push(cursor, end, 1);
	return out;
}

const pad = (prefix: string, n: number) => `${prefix}-${String(n).padStart(3, "0")}`;

export function planResolveExport(scene: SceneDescription, opts: PlanOptions): ResolvePlan {
	const fps = opts.fps;
	const segments: ResolveSegment[] = [];
	const audio: ResolveAudioClip[] = [];
	let durationFrames = 0;
	let outputSec = 0;
	let camCount = 0;

	scene.clips.forEach((clip, clipIndex) => {
		const regions = scene.speedRegions.filter(
			(r) => r.clipIndex === undefined || r.clipIndex === clipIndex,
		);
		const hasCamera = !!clip.webcamPath && clip.webcamPath !== clip.screenPath;
		for (const piece of splitWindow(regions, clip.sourceStartSec, clip.sourceEndSec, outputSec)) {
			outputSec = piece.outputEnd;
			const recordFrame = framesDue(piece.outputStart, fps);
			const frames = framesDue(piece.outputEnd, fps) - recordFrame;
			// A span too short to own a frame cannot be a Resolve clip; the programme clock still advanced.
			if (frames <= 0) continue;
			durationFrames += frames;
			const retimed = piece.speed !== 1;
			// The frame Rust's decoder shows at the first programme frame (not round(srcStart*30)).
			const mediaStartFrame = retimed
				? 0
				: Math.floor((piece.start + recordFrame / fps - piece.outputStart) * fps + 1e-6);
			let camera: ResolveCamera | null = null;
			if (hasCamera) {
				// webcam time = screen source time - webcamOffsetSec (timeline_walk.rs).
				const offsetFrames = Math.round(clip.webcamOffsetSec * fps);
				const delay = retimed ? 0 : Math.max(0, offsetFrames - mediaStartFrame);
				const camFrames = frames - delay;
				if (camFrames > 0) {
					camCount += 1;
					camera = {
						mediaSourcePath: clip.webcamPath,
						key: pad("cam", camCount),
						offsetFrames,
						retimed,
						mediaStartFrame: retimed || delay > 0 ? 0 : mediaStartFrame - offsetFrames,
						recordFrame: recordFrame + delay,
						frames: camFrames,
					};
				}
			}
			segments.push({
				key: pad("seg", segments.length + 1),
				clipIndex,
				role: "screen",
				mediaSourcePath: clip.screenPath,
				retimed,
				speed: piece.speed,
				srcStartSec: piece.start,
				srcEndSec: piece.end,
				outputStartSec: piece.outputStart,
				mediaStartFrame,
				frames,
				recordFrame,
				handleFrames: retimed ? 0 : RESOLVE_HANDLE_FRAMES,
				cursorPath: `${clip.screenPath}.cursor.json`,
				camera,
			});
			if (clip.hasAudio) {
				audio.push({
					key: pad("voice", audio.length + 1),
					sourcePath: opts.micWavPathFor?.(clip.screenPath) || clip.screenPath,
					takePath: clip.screenPath,
					retimed,
					speed: piece.speed,
					srcStartSec: piece.start,
					srcEndSec: piece.end,
					mediaStartFrame,
					frames,
					recordFrame,
					track: 1,
				});
			}
		}
	});

	return {
		fps,
		segments,
		audio,
		durationFrames,
		background: scene.background,
		backgroundSpan: { startFrame: 0, frames: durationFrames },
		overlaySpan: opts.overlay ? { startFrame: 0, frames: durationFrames } : null,
	};
}

/**
 * Source times (screen clock) to sample for a segment's data file. Serves the screen and its
 * camera: the framing is keyed on the screen clock for both.
 *
 * `frame0` is in SCREEN media frames. For the camera file the caller converts it with
 * `cameraFrame0` and drops leading samples whose camera frame is below 0.
 */
export function segmentSourceTimes(
	seg: ResolveSegment,
	fps: 30,
	handleFrames: number = seg.handleFrames,
	mediaFrameCount?: number,
): { frame0: number; times: Float64Array } {
	if (seg.retimed) {
		const times = new Float64Array(seg.frames);
		for (let i = 0; i < seg.frames; i++) {
			const t = seg.srcStartSec + ((seg.recordFrame + i) / fps - seg.outputStartSec) * seg.speed;
			times[i] = Math.max(t, seg.srcStartSec);
		}
		return { frame0: 0, times };
	}
	const first = Math.max(0, seg.mediaStartFrame - handleFrames);
	let last = seg.mediaStartFrame + seg.frames - 1 + handleFrames;
	if (mediaFrameCount !== undefined) last = Math.min(last, mediaFrameCount - 1);
	const n = Math.max(0, last - first + 1);
	const times = new Float64Array(n);
	for (let i = 0; i < n; i++) times[i] = (first + i) / fps;
	return { frame0: first, times };
}

/**
 * Camera media frame matching `screenFrame0` (a screen media frame from `segmentSourceTimes`).
 * May be negative: the caller drops the leading samples with a camera frame below 0. A retimed
 * segment has its own camera render indexed like the screen one, so it maps 1:1.
 */
export function cameraFrame0(seg: ResolveSegment, screenFrame0: number): number {
	if (!seg.camera || seg.retimed) return screenFrame0;
	return screenFrame0 - seg.camera.offsetFrames;
}
