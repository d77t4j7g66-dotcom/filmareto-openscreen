import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	type FacePoint,
	type FaceSample,
	smoothFaceTrack,
} from "../../src/lib/ai-edition/timeline/faceTrack";
import { extractMono16kPcm, NoAudioTrackError } from "../stt/extractAudio";
import type { SttTranscribeRequest, SttTranscribeResponse } from "../stt/transcriptionContract";
import { resolveFfmpeg } from "./audioPeaks";

/** The chain measures per frame of a 30 fps timeline: `LEVELS_PER_SEC` in `timeline/yapping.ts`. */
const LEVELS_PER_SEC = 30;
const SAMPLE_RATE = 16_000;
const FACE_SAMPLES = 9;

export interface TalkingHeadAnalysis {
	success: boolean;
	levelsDb?: Float32Array;
	/** The take was recorded with the microphone off: there is nothing to edit by. */
	noSound?: boolean;
	/** Where the eyes are, 0-1 from the top left. Null: no face found. */
	face?: { x: number; y: number; h?: number } | null;
	message?: string;
}

/** Loudness of every frame, in dBFS. */
export function levelsOf(samples: Float32Array): Float32Array {
	const count = Math.floor((samples.length * LEVELS_PER_SEC) / SAMPLE_RATE);
	const levels = new Float32Array(count);
	for (let frame = 0; frame < count; frame += 1) {
		const from = Math.floor((frame * SAMPLE_RATE) / LEVELS_PER_SEC);
		const to = Math.floor(((frame + 1) * SAMPLE_RATE) / LEVELS_PER_SEC);
		let sum = 0;
		for (let i = from; i < to; i += 1) sum += samples[i] * samples[i];
		levels[frame] = 20 * Math.log10(Math.sqrt(sum / Math.max(1, to - from)) + 1e-12);
	}
	return levels;
}

function frameAt(ffmpeg: string, filePath: string, atSec: number, out: string): Promise<void> {
	return new Promise((resolve) => {
		const child = spawn(
			ffmpeg,
			["-v", "error", "-ss", atSec.toFixed(3), "-i", filePath, "-frames:v", "1", "-y", out],
			{ stdio: "ignore", timeout: 20_000, killSignal: "SIGKILL" },
		);
		child.on("close", () => resolve());
		child.on("error", () => resolve());
	});
}

function eyesIn(
	helper: string,
	image: string,
): Promise<{ x: number; y: number; h: number } | null> {
	return new Promise((resolve) => {
		execFile(helper, ["--eyes", image], { timeout: 15_000 }, (error, stdout) => {
			const [x, y, h] = stdout.trim().split(/\s+/).map(Number);
			resolve(error || !Number.isFinite(x) || !Number.isFinite(y) ? null : { x, y, h });
		});
	});
}

const middle = (values: number[]) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** The eye line over the whole take: the middle of nine looks, so a turn of the head does not count. */
export async function findFace(
	filePath: string,
	durationSec: number,
	helper: string,
): Promise<{ x: number; y: number; h: number } | null> {
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg || durationSec <= 0) return null;
	const folder = await fs.mkdtemp(path.join(os.tmpdir(), "filmareto-face-"));
	try {
		const hits: { x: number; y: number; h: number }[] = [];
		for (let i = 0; i < FACE_SAMPLES; i += 1) {
			const image = path.join(folder, `${i}.png`);
			await frameAt(ffmpeg, filePath, (durationSec * (i + 0.5)) / FACE_SAMPLES, image);
			const hit = await eyesIn(helper, image);
			if (hit) hits.push(hit);
		}
		if (hits.length === 0) return null;
		return {
			x: middle(hits.map((hit) => hit.x)),
			y: middle(hits.map((hit) => hit.y)),
			h: middle(hits.map((hit) => hit.h)),
		};
	} finally {
		await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
	}
}

const FACE_TRACK_MAX_SAMPLES = 1200;

/** Seconds between two looks: every half second, spread thinner over a take past 10 minutes. */
export function faceTrackInterval(durationSec: number): number {
	return Math.max(0.5, durationSec / FACE_TRACK_MAX_SAMPLES);
}

/** One call for the whole take: a picture every `interval` seconds, 640 px wide, named by order. */
export function faceTrackArgs(filePath: string, folder: string, interval: number): string[] {
	return [
		"-v",
		"error",
		"-threads",
		"2",
		"-i",
		filePath,
		"-an",
		"-vf",
		`fps=1/${interval},scale=640:-2`,
		"-q:v",
		"3",
		"-y",
		path.join(folder, "f_%05d.jpg"),
	];
}

export interface FaceTrackOptions {
	/** Added to every time: the take's seconds of a camera file's 0 (`cameraTrack` start + offset). */
	offsetSec?: number;
	ffmpeg?: string | null;
	/** Stops the look: its ffmpeg and helper are killed, and it throws. */
	signal?: AbortSignal;
	runFfmpeg?: (args: string[], signal?: AbortSignal) => Promise<void>;
	/** The helper's `--eyes-batch` output for a folder. */
	runHelper?: (helper: string, folder: string, signal?: AbortSignal) => Promise<string>;
}

export function runFfmpegProcess(
	ffmpeg: string,
	args: string[],
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(ffmpeg, args, {
			stdio: "ignore",
			timeout: 15 * 60_000,
			killSignal: "SIGKILL",
			signal,
		});
		child.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)),
		);
		child.on("error", reject);
	});
}

/** About 50 ms a frame and 30 s to start, at most 15 minutes: a stuck helper fails soon. */
export function helperTimeoutMs(frames: number): number {
	return Math.min(15 * 60_000, 30_000 + frames * 50);
}

async function runHelperProcess(
	helper: string,
	folder: string,
	signal?: AbortSignal,
): Promise<string> {
	const frames = (await fs.readdir(folder)).length;
	return new Promise((resolve, reject) => {
		execFile(
			helper,
			["--eyes-batch", folder],
			{
				timeout: helperTimeoutMs(frames),
				maxBuffer: 16 * 1024 * 1024,
				killSignal: "SIGKILL",
				signal,
			},
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		);
	});
}

/**
 * Where the face is over a whole take, a look every `faceTrackInterval` seconds, smoothed. `t` is
 * seconds of the file, plus `offsetSec`; x, y (and h) are 0-1 of the picture as the file holds it.
 * Null: no face in any look. Throws when the pictures or the looks could not be made, so the
 * caller can tell "none there" from "could not look".
 */
export async function findFaceTrack(
	filePath: string,
	durationSec: number,
	helper: string,
	options: FaceTrackOptions = {},
): Promise<FacePoint[] | null> {
	const ffmpeg = options.ffmpeg === undefined ? resolveFfmpeg() : options.ffmpeg;
	if (!ffmpeg || !(durationSec > 0)) throw new Error("no ffmpeg or no duration for a face track");
	const interval = faceTrackInterval(durationSec);
	const { signal } = options;
	signal?.throwIfAborted();
	const folder = await fs.mkdtemp(path.join(os.tmpdir(), "filmareto-facetrack-"));
	try {
		const args = faceTrackArgs(filePath, folder, interval);
		await (options.runFfmpeg ?? ((a, s) => runFfmpegProcess(ffmpeg, a, s)))(args, signal);
		// Stopped between the two: the helper is not started at all.
		signal?.throwIfAborted();
		const output = await (options.runHelper ?? runHelperProcess)(helper, folder, signal);
		const samples: FaceSample[] = [];
		for (const line of output.split("\n")) {
			const [name, ...rest] = line.trim().split(/\s+/);
			const frame = /^f_(\d+)\./.exec(name ?? "");
			if (!frame) continue;
			// With fps=1/interval, picture n shows second (n - 0.5) * interval.
			const t = (Number(frame[1]) - 0.5) * interval;
			const [x, y, h] = rest.map(Number);
			samples.push(
				rest[0] === "none" || !Number.isFinite(x) || !Number.isFinite(y)
					? { t, none: true }
					: { t, x, y, ...(Number.isFinite(h) ? { h } : {}) },
			);
		}
		if (samples.length === 0) throw new Error("no pictures to look at for a face track");
		const offset = options.offsetSec ?? 0;
		const track = smoothFaceTrack(samples);
		if (!track) return null;
		const shifted = track
			.map((point) => ({ ...point, t: point.t + offset }))
			.filter((point) => point.t >= 0);
		return shifted.length > 0 ? shifted : null;
	} finally {
		await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
	}
}

export type FaceTrackAnswer = FacePoint[] | null | undefined | "busy";

/**
 * The face looks in progress, so that a take starting can stop them. A look is minutes of ffmpeg
 * and Vision work over a whole take; started before the take, it went on into it and could cost
 * the take frames. `stopAll` (called as a recording starts) kills the running ffmpeg and helper of
 * every look; a stopped look answers "busy", which the renderer asks again for later, and leaves
 * no temp folder behind. Otherwise a look answers the track, null (no face), or undefined (could
 * not look).
 */
export function createFaceTrackLooks(find: typeof findFaceTrack = findFaceTrack) {
	const running = new Set<AbortController>();
	return {
		async look(
			filePath: string,
			durationSec: number,
			helper: string,
			offsetSec?: number,
		): Promise<FaceTrackAnswer> {
			const controller = new AbortController();
			running.add(controller);
			try {
				return await find(filePath, durationSec, helper, {
					offsetSec,
					signal: controller.signal,
				});
			} catch (error) {
				if (controller.signal.aborted) return "busy";
				console.warn("[face-track] could not look:", error);
				return undefined;
			} finally {
				running.delete(controller);
			}
		},
		/** Stops every look in progress. Returns how many there were. */
		stopAll(): number {
			const count = running.size;
			for (const controller of running) controller.abort();
			return count;
		},
	};
}

/**
 * What is said in each stretch, each heard on its own. Over a whole file the transcriber writes a
 * line said three times once, and drops the takes that give it away: the words it does write land
 * on the wrong take too. The longest stretch goes first, to settle the language for the short ones.
 */
export async function hearSpans(
	filePath: string,
	spans: { start: number; end: number }[],
	options: { language?: string; prompt?: string },
	transcribe: (request: SttTranscribeRequest) => Promise<SttTranscribeResponse>,
): Promise<SttTranscribeResponse | null> {
	const samples = await extractMono16kPcm(filePath);
	const longestFirst = [...spans].sort((a, b) => b.end - b.start - (a.end - a.start));
	let language = options.language;
	let last: SttTranscribeResponse | null = null;
	const segments: SttTranscribeResponse["segments"] = [];
	const wordSegments: SttTranscribeResponse["wordSegments"] = [];
	for (const span of longestFirst) {
		const from = Math.floor(span.start * SAMPLE_RATE);
		const to = Math.min(samples.length, Math.ceil(span.end * SAMPLE_RATE));
		if (to <= from) continue;
		last = await transcribe({
			samples: samples.subarray(from, to),
			language,
			prompt: options.prompt,
		});
		language ??= last.detectedLanguage || undefined;
		const at = from / SAMPLE_RATE;
		for (const part of last.segments) {
			segments.push({ ...part, startSec: part.startSec + at, endSec: part.endSec + at });
		}
		for (const word of last.wordSegments) {
			wordSegments.push({ ...word, startSec: word.startSec + at, endSec: word.endSec + at });
		}
	}
	if (!last) return null;
	segments.sort((a, b) => a.startSec - b.startSec);
	wordSegments.sort((a, b) => a.startSec - b.startSec);
	return {
		...last,
		segments,
		wordSegments,
		detectedLanguage: language ?? last.detectedLanguage,
		timing: undefined,
	};
}

export async function analyseTalkingHead(
	filePath: string,
	durationSec: number,
	helper: string | null,
): Promise<TalkingHeadAnalysis> {
	try {
		const samples = await extractMono16kPcm(filePath);
		const face = helper ? await findFace(filePath, durationSec, helper) : null;
		return { success: true, levelsDb: levelsOf(samples), face };
	} catch (error) {
		if (error instanceof NoAudioTrackError) return { success: false, noSound: true };
		return { success: false, message: error instanceof Error ? error.message : String(error) };
	}
}
