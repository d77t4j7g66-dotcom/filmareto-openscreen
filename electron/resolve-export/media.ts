import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RESOLVE_FPS } from "../../src/lib/resolve-export/plan";
import type { SceneBackground } from "../../src/native/sceneDescription";

/**
 * Media preparation for the Resolve export folder. Pure Node: every function takes the ffmpeg
 * path first, so it runs under vitest with no Electron.
 */

/** Timeline fps of the export (the 1.2.0 capture standard). */
const FPS = RESOLVE_FPS;
/** Audio rate of every WAV the export writes. */
const AUDIO_RATE = 48000;
/** Reading packets with `-c copy` is only a demux: past this the open is wedged. */
const PROBE_TIMEOUT_MS = 30_000;
/** A re-encode of a long take; generous, but a wedged ffmpeg must still end. */
const ENCODE_TIMEOUT_MS = 30 * 60_000;
const STILL_TIMEOUT_MS = 60_000;

interface RunResult {
	stdout: Buffer;
	stderr: string;
}

function runFfmpeg(ffmpeg: string, args: string[], timeout: number): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const out: Buffer[] = [];
		let stderr = "";
		const child = spawn(ffmpeg, ["-hide_banner", ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			timeout,
			killSignal: "SIGKILL",
		});
		child.stdout.on("data", (c: Buffer) => out.push(c));
		child.stderr.on("data", (c: Buffer) => {
			// Keep the tail only: the error is at the end and a long encode logs a lot.
			stderr = (stderr + c.toString()).slice(-8000);
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) resolve({ stdout: Buffer.concat(out), stderr });
			else reject(new Error(`ffmpeg ${signal ?? `exited ${code}`}: ${stderr.slice(-1500)}`));
		});
	});
}

export interface FrameTiming {
	/** Every gap between frames is within 1 timebase tick of the others. */
	constant: boolean;
	/** Average frame rate (frames - 1) / span; 30 when there are too few frames to tell. */
	fps: number;
	/** PTS of the first frame, in seconds (the decoder PTS OpenScreen uses as source time). */
	startSec: number;
	/** Frames (packets) in the stream. */
	frames: number;
}

/**
 * Frame timing of the first video stream, from `-copyts -c copy -f framecrc` (no decode).
 *
 * pts deltas rather than the `duration` column: a MediaRecorder `.webm` carries no block
 * durations, and every duration reads as 0, which would look constant. `-copyts` keeps a
 * non-zero start instead of shifting it to 0.
 */
export async function probeFrameTiming(ffmpeg: string, filePath: string): Promise<FrameTiming> {
	const { stdout } = await runFfmpeg(
		ffmpeg,
		["-copyts", "-i", filePath, "-map", "0:v:0", "-c", "copy", "-f", "framecrc", "-"],
		PROBE_TIMEOUT_MS,
	);
	const text = stdout.toString();
	const tbm = /^#tb 0:\s*(\d+)\/(\d+)/m.exec(text);
	const tb = tbm ? Number(tbm[1]) / Number(tbm[2]) : 1;
	const pts: number[] = [];
	for (const line of text.split("\n")) {
		if (!line || line.startsWith("#")) continue;
		const v = Number(line.split(",")[2]);
		if (Number.isFinite(v)) pts.push(v);
	}
	pts.sort((a, b) => a - b);
	const startSec = pts.length ? pts[0] * tb : 0;
	const frames = pts.length;
	if (pts.length < 3) return { constant: true, fps: 30, startSec, frames };
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (let i = 1; i < pts.length; i++) {
		const d = pts[i] - pts[i - 1];
		if (d < min) min = d;
		if (d > max) max = d;
	}
	const span = (pts[pts.length - 1] - pts[0]) * tb;
	return {
		constant: max - min <= 1,
		fps: span > 0 ? (pts.length - 1) / span : 30,
		startSec,
		frames,
	};
}

/** Whether `prepareVideo` clones a file (speed 1, no range) rather than re-encoding it. */
export function canCloneVideo(timing: FrameTiming | null): boolean {
	return (
		timing !== null &&
		timing.constant &&
		Math.abs(timing.fps - FPS) <= 0.01 &&
		timing.startSec <= 0.001
	);
}

/** True when the first video stream has a constant frame interval. */
export async function isConstantFrameRate(ffmpeg: string, filePath: string): Promise<boolean> {
	return (await probeFrameTiming(ffmpeg, filePath)).constant;
}

async function cloneOrCopy(src: string, dst: string): Promise<void> {
	// COPYFILE_FICLONE (not _FORCE) already falls back to a plain copy where cloning is unsupported.
	await copyFile(src, dst, fsConstants.COPYFILE_FICLONE);
}

function checkSpeed(speed: number): void {
	if (!Number.isFinite(speed) || speed <= 0) throw new Error(`invalid speed: ${speed}`);
}

function rangeArgs(opts: { startSec?: number; endSec?: number }): string[] {
	const a: string[] = [];
	if (opts.startSec !== undefined) a.push("-ss", String(opts.startSec));
	if (opts.endSec !== undefined) a.push("-to", String(opts.endSec));
	return a;
}

const hasRange = (o: { startSec?: number; endSec?: number }) =>
	o.startSec !== undefined || o.endSec !== undefined;

/** Run an encode; a failed (or empty) run leaves no partial `dst` behind. */
async function encodeTo(
	ffmpeg: string,
	dst: string,
	args: string[],
	check?: () => Promise<void>,
): Promise<void> {
	try {
		await runFfmpeg(ffmpeg, args, ENCODE_TIMEOUT_MS);
		if (check) await check();
	} catch (e) {
		await rm(dst, { force: true });
		throw e;
	}
}

/**
 * A CFR 30 fps `.mov` of the take (or of a piece of it, retimed). Output frame i shows the
 * source at t = S + i * speed / 30 (S = startSec, or 0), with source time = the decoder PTS.
 *
 * - CFR at 30 fps, speed 1, no range, starting at 0: cloned as is. Any other rate (25, 29.97,
 *   60...) is re-encoded, because the samples index 30 fps frames.
 * - `frames` (retimed pieces): the output has EXACTLY that many frames. A source that ends early
 *   gets its last picture held (`tpad=stop_mode=clone`), a longer one is cut (`-frames:v`).
 * - Otherwise `fps=30:start_time=0` first (the 30 fps grid, held frames repeated and a late
 *   start padded with the first picture), then `trim`, then `setpts=(PTS-STARTPTS)/speed,fps=30`.
 *   The grid goes BEFORE the cut and there is no input seeking: an accurate `-ss` drops a held
 *   frame that spans the cut and pulls the next one in. Decoding from the start is the price.
 */
export async function prepareVideo(
	ffmpeg: string,
	src: string,
	dst: string,
	opts: {
		speed: number;
		startSec?: number;
		endSec?: number;
		timing?: FrameTiming;
		/** Exact number of output frames. */
		frames?: number;
	},
): Promise<{ cloned: boolean }> {
	checkSpeed(opts.speed);
	// A caller that already probed the file passes its timing, so it is demuxed once.
	const timing = opts.timing ?? (await probeFrameTiming(ffmpeg, src));
	if (opts.speed === 1 && !hasRange(opts) && canCloneVideo(timing)) {
		await cloneOrCopy(src, dst);
		return { cloned: true };
	}
	const filters = [`fps=${FPS}:start_time=0`];
	if (hasRange(opts)) {
		const start = opts.startSec ?? 0;
		// At least one output frame, however short the piece.
		const end =
			opts.endSec === undefined
				? undefined
				: Math.max(opts.endSec, start + Math.max(1, opts.speed) / FPS);
		filters.push(`trim=start=${start}${end === undefined ? "" : `:end=${end}`}`);
		filters.push(`setpts=(PTS-STARTPTS)/${opts.speed}`, `fps=${FPS}`);
	} else if (opts.speed !== 1) {
		filters.push(`setpts=PTS/${opts.speed}`, `fps=${FPS}`);
	}
	const exact =
		opts.frames !== undefined && opts.frames > 0 ? Math.max(1, Math.round(opts.frames)) : null;
	if (exact !== null) {
		// Generous on purpose: `-frames:v` below cuts to the exact count whatever the shortfall was.
		filters.push(`tpad=stop_mode=clone:stop_duration=${(exact / FPS + 1).toFixed(6)}`);
	}
	await encodeTo(
		ffmpeg,
		dst,
		[
			"-y",
			"-copyts",
			"-i",
			src,
			"-map",
			"0:v:0",
			"-vf",
			filters.join(","),
			"-fps_mode",
			"cfr",
			...(exact !== null ? ["-frames:v", String(exact)] : []),
			"-c:v",
			"hevc_videotoolbox",
			"-profile:v",
			"main10",
			"-pix_fmt",
			"p010le",
			"-b:v",
			"50M",
			"-tag:v",
			"hvc1",
			"-an",
			dst,
		],
		async () => {
			const { stderr } = await runFfmpeg(
				ffmpeg,
				["-i", dst, "-t", "0", "-f", "null", "-"],
				PROBE_TIMEOUT_MS,
			);
			if (!/Stream #0:\d+.*Video:/.test(stderr)) {
				throw new Error(`prepareVideo wrote no video stream (piece too short?): ${dst}`);
			}
		},
	);
	return { cloned: false };
}

/** `atempo` takes 0.5..2 per instance; chain for anything outside. */
export function atempoChain(speed: number): string {
	checkSpeed(speed);
	const f: number[] = [];
	let s = speed;
	while (s > 2) {
		f.push(2);
		s /= 2;
	}
	while (s < 0.5) {
		f.push(0.5);
		s *= 2;
	}
	f.push(s);
	return f.map((x) => `atempo=${x}`).join(",");
}

/** The source has no audio stream to make a WAV from. */
export class NoAudioStreamError extends Error {
	constructor(src: string) {
		super(`no audio stream in ${src}`);
		this.name = "NoAudioStreamError";
	}
}

/** Container duration in seconds, from the `Duration:` line of ffmpeg's input listing. */
export async function probeDuration(ffmpeg: string, file: string): Promise<number> {
	const { stderr } = await runFfmpeg(
		ffmpeg,
		["-i", file, "-t", "0", "-f", "null", "-"],
		PROBE_TIMEOUT_MS,
	);
	const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
	if (!m) throw new Error(`no duration for ${file}`);
	return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Whole timeline frames an audio file covers (never more than it has). */
export async function probeAudioFrames(ffmpeg: string, file: string): Promise<number> {
	return Math.max(0, Math.floor((await probeDuration(ffmpeg, file)) * FPS + 1e-6));
}

/**
 * A 48 kHz 24-bit WAV of the audio (or a retimed piece). A `.wav` at speed 1 with no range is
 * cloned. `channels` defaults to the source's own count. `frames` (retimed pieces): exactly
 * `frames / 30 * 48000` samples, silence-padded when the source runs out (`apad`), cut to the
 * sample (`atrim`).
 */
export async function prepareWav(
	ffmpeg: string,
	src: string,
	dst: string,
	opts: { speed: number; startSec?: number; endSec?: number; channels?: 1 | 2; frames?: number },
): Promise<{ cloned: boolean }> {
	checkSpeed(opts.speed);
	if (opts.speed === 1 && !hasRange(opts) && src.toLowerCase().endsWith(".wav")) {
		await cloneOrCopy(src, dst);
		return { cloned: true };
	}
	// atempo flushes a little past the exact length (2.4 ms on a 2x of 4 s), so a retimed piece is
	// cut to its exact output length.
	const samples =
		opts.frames !== undefined && opts.frames > 0
			? Math.round((Math.round(opts.frames) / FPS) * AUDIO_RATE)
			: null;
	const outSec =
		samples === null && opts.speed !== 1
			? ((opts.endSec ?? (await probeDuration(ffmpeg, src))) - (opts.startSec ?? 0)) / opts.speed
			: null;
	try {
		await encodeTo(ffmpeg, dst, [
			"-y",
			...rangeArgs(opts),
			"-i",
			src,
			"-vn",
			...(opts.speed !== 1 || samples !== null
				? [
						"-af",
						[
							...(opts.speed !== 1 ? [atempoChain(opts.speed)] : []),
							// Resampled first: the sample counts below are at the output rate.
							...(samples !== null
								? [
										`aresample=${AUDIO_RATE}`,
										`apad=whole_len=${samples}`,
										`atrim=end_sample=${samples}`,
									]
								: []),
						].join(","),
					]
				: []),
			...(outSec !== null ? ["-t", outSec.toFixed(6)] : []),
			"-ar",
			String(AUDIO_RATE),
			...(opts.channels ? ["-ac", String(opts.channels)] : []),
			"-c:a",
			"pcm_s24le",
			dst,
		]);
	} catch (e) {
		if (e instanceof Error && /does not contain any stream/.test(e.message)) {
			throw new NoAudioStreamError(src);
		}
		throw e;
	}
	return { cloned: false };
}

type RGB = [number, number, number];

function parseColor(input: string): RGB {
	const s = input.trim().toLowerCase();
	let m = /^#([0-9a-f]{3,8})$/.exec(s);
	if (m) {
		let h = m[1];
		if (h.length === 3 || h.length === 4) {
			h = [...h].map((c) => c + c).join("");
		}
		if (h.length === 6 || h.length === 8) {
			return [
				Number.parseInt(h.slice(0, 2), 16),
				Number.parseInt(h.slice(2, 4), 16),
				Number.parseInt(h.slice(4, 6), 16),
			];
		}
	}
	m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
	if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.round(v)) as RGB;
	throw new Error(`unsupported colour: ${input}`);
}

const hex = ([r, g, b]: RGB) =>
	`0x${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;

/** Colour of the piecewise-linear gradient defined by stops at offsets, at position t. */
function sampleStops(colors: RGB[], offsets: number[], t: number): RGB {
	if (t <= offsets[0]) return colors[0];
	for (let i = 1; i < colors.length; i++) {
		if (t <= offsets[i]) {
			const span = offsets[i] - offsets[i - 1] || 1;
			const k = (t - offsets[i - 1]) / span;
			return colors[i - 1].map((c, j) => Math.round(c + (colors[i][j] - c) * k)) as RGB;
		}
	}
	return colors[colors.length - 1];
}

/** `gradients` source for a CSS-angle linear gradient (0deg = to top, 90deg = to right). */
function gradientSource(
	w: number,
	h: number,
	g: { angleDeg: number; stops: string[]; offsets: number[] },
): string {
	const colors = g.stops.map(parseColor);
	if (colors.length === 0) throw new Error("gradient without stops");
	const offsets = colors.map((_, i) =>
		g.offsets[i] !== undefined ? g.offsets[i] : colors.length > 1 ? i / (colors.length - 1) : 0,
	);
	// The `gradients` source spaces its colours evenly along the line and has no per-colour
	// offsets, so a gradient with uneven offsets is resampled into 8 evenly spaced colours
	// (an approximation). Even offsets with at most 8 stops are passed through exactly.
	const even = offsets.every((o, i) => Math.abs(o - i / Math.max(1, colors.length - 1)) < 1e-3);
	const exact = even && colors.length <= 8;
	const used = exact
		? colors
		: Array.from({ length: 8 }, (_, i) => sampleStops(colors, offsets, i / 7));
	const list = used.length === 1 ? [used[0], used[0]] : used;
	const a = (g.angleDeg * Math.PI) / 180;
	const dx = Math.sin(a);
	const dy = -Math.cos(a);
	// CSS gradient line length: the projection of the box on the direction, centred on the box.
	const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
	const cx = w / 2;
	const cy = h / 2;
	const f = (v: number) => v.toFixed(2);
	const colorOpts = list.map((c, i) => `c${i}=${hex(c)}`).join(":");
	return `gradients=s=${w}x${h}:x0=${f(cx - dx * half)}:y0=${f(cy - dy * half)}:x1=${f(
		cx + dx * half,
	)}:y1=${f(cy + dy * half)}:nb_colors=${list.length}:${colorOpts}:type=linear:speed=0:d=1:r=1`;
}

/** A WxH PNG of the scene background; `blur` applies `gblur` with sigma 13 * H / 1080. */
export async function backgroundStill(
	ffmpeg: string,
	bg: SceneBackground,
	w: number,
	h: number,
	dst: string,
	opts: { blur: boolean; resolveImagePath: (p: string) => string | null },
): Promise<void> {
	const blur = opts.blur ? [`gblur=sigma=${((13 * h) / 1080).toFixed(3)}`] : [];
	let tmpDir: string | null = null;
	try {
		let input: string[];
		let chain: string[];
		if (bg.kind === "color") {
			// `format=rgba` inside the source graph makes the source itself produce RGB; converting
			// from its default YUV afterwards costs a few levels of colour.
			input = [
				"-f",
				"lavfi",
				"-i",
				`color=c=${hex(parseColor(bg.color))}:s=${w}x${h}:r=1:d=1,format=rgba`,
			];
			chain = blur.length ? blur : ["null"];
		} else if (bg.kind === "gradient") {
			input = ["-f", "lavfi", "-i", `${gradientSource(w, h, bg)},format=rgba`];
			chain = blur.length ? blur : ["null"];
		} else {
			let file: string | null;
			const data = /^data:([^,]*),(.*)$/s.exec(bg.path);
			if (data) {
				tmpDir = await mkdtemp(path.join(os.tmpdir(), "filmareto-bg-"));
				file = path.join(tmpDir, "bg.img");
				await writeFile(
					file,
					/;base64$/i.test(data[1])
						? Buffer.from(data[2], "base64")
						: Buffer.from(decodeURIComponent(data[2])),
				);
			} else {
				file = opts.resolveImagePath(bg.path);
			}
			if (!file) throw new Error(`background image not found: ${bg.path.slice(0, 80)}`);
			input = ["-i", file];
			chain = [
				`scale=${w}:${h}:force_original_aspect_ratio=increase`,
				`crop=${w}:${h}`,
				"format=rgba",
				...blur,
			];
		}
		await runFfmpeg(
			ffmpeg,
			["-y", ...input, "-vf", chain.join(","), "-frames:v", "1", "-update", "1", dst],
			STILL_TIMEOUT_MS,
		);
	} finally {
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
	}
}

/** Width and height from a PNG's IHDR chunk (big-endian u32 at bytes 16 and 20). */
async function pngSize(file: string): Promise<{ w: number; h: number }> {
	const fh = await open(file, "r");
	try {
		const buf = Buffer.alloc(24);
		await fh.read(buf, 0, 24, 0);
		if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("ascii", 12, 16) !== "IHDR") {
			throw new Error(`not a PNG: ${file}`);
		}
		return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
	} finally {
		await fh.close();
	}
}

export interface CursorAtlasResult {
	kinds: Array<{ name: string; rect: [number, number, number, number]; hotspot: [number, number] }>;
	width: number;
	height: number;
}

/**
 * One RGBA PNG strip of the cursor sprites, side by side, each padded at the bottom with
 * transparent pixels to the tallest. Rects are atlas pixels; hotspots pass through unchanged.
 */
export async function cursorAtlas(
	ffmpeg: string,
	sprites: Array<{ name: string; path: string; hotspot: [number, number] }>,
	dst: string,
): Promise<CursorAtlasResult> {
	if (sprites.length === 0) throw new Error("cursorAtlas: no sprites");
	const sizes = await Promise.all(sprites.map((s) => pngSize(s.path)));
	const height = Math.max(...sizes.map((s) => s.h));
	let x = 0;
	const kinds = sprites.map((s, i) => {
		const rect: [number, number, number, number] = [x, 0, sizes[i].w, sizes[i].h];
		x += sizes[i].w;
		return { name: s.name, rect, hotspot: s.hotspot };
	});
	const padded = sprites.map(
		(_, i) => `[${i}:v]format=rgba,pad=${sizes[i].w}:${height}:0:0:color=0x00000000[p${i}]`,
	);
	const stack =
		sprites.length === 1
			? "[p0]null[out]"
			: `${sprites.map((_, i) => `[p${i}]`).join("")}hstack=inputs=${sprites.length}[out]`;
	await runFfmpeg(
		ffmpeg,
		[
			"-y",
			...sprites.flatMap((s) => ["-i", s.path]),
			"-filter_complex",
			[...padded, stack].join(";"),
			"-map",
			"[out]",
			"-pix_fmt",
			"rgba",
			"-frames:v",
			"1",
			"-update",
			"1",
			dst,
		],
		STILL_TIMEOUT_MS,
	);
	return { kinds, width: x, height };
}
