import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
