import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CURSOR_SPRITES } from "../../src/lib/cursor/cursorThemes";
import {
	atempoChain,
	backgroundStill,
	cursorAtlas,
	isConstantFrameRate,
	NoAudioStreamError,
	prepareVideo,
	prepareWav,
	probeAudioFrames,
	probeFrameTiming,
} from "./media";

// The binary is untracked: a worktree falls back to the main checkout three levels up
// (`<main>/.claude/worktrees/<name>`).
const FFMPEG =
	[
		process.env.OPENSCREEN_FFMPEG_PATH ?? "",
		path.resolve(__dirname, "../native/bin/darwin-arm64/ffmpeg"),
		path.resolve(__dirname, "../../../../../electron/native/bin/darwin-arm64/ffmpeg"),
	].find((c) => c && existsSync(c)) ?? "";
const run = promisify(execFile);
const d = FFMPEG ? describe : describe.skip;

async function ff(args: string[]): Promise<Buffer> {
	const { stdout } = await run(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args], {
		encoding: "buffer",
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout as unknown as Buffer;
}

/** Frame pts (in ticks) of the first video stream, via framecrc. */
async function framePts(file: string): Promise<number[]> {
	const out = (
		await ff(["-i", file, "-map", "0:v:0", "-c", "copy", "-f", "framecrc", "-"])
	).toString();
	return out
		.split("\n")
		.filter((l) => l && !l.startsWith("#"))
		.map((l) => Number(l.split(",")[2]));
}

/** Audio duration in seconds from a PCM WAV (data chunk size / byte rate). */
function wavSeconds(file: string): number {
	const b = readFileSync(file);
	let o = 12;
	let byteRate = 0;
	while (o + 8 <= b.length) {
		const id = b.toString("ascii", o, o + 4);
		const size = b.readUInt32LE(o + 4);
		if (id === "fmt ") byteRate = b.readUInt32LE(o + 16);
		if (id === "data") return size / byteRate;
		o += 8 + size + (size % 2);
	}
	throw new Error("no data chunk");
}

d("resolve-export media", () => {
	let dir: string;
	const p = (n: string) => path.join(dir, n);

	beforeAll(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "filmareto-media-test-"));
		await ff([
			"-f",
			"lavfi",
			"-i",
			"testsrc=d=4:s=320x240:r=30",
			"-c:v",
			"mpeg4",
			"-y",
			p("cfr.mkv"),
		]);
		await ff([
			"-f",
			"lavfi",
			"-i",
			"testsrc=d=4:s=320x240:r=30",
			"-vf",
			// Dropped frames leave real gaps in the pts, which survive a `-fps_mode vfr` encode.
			"select='not(eq(mod(n,4),1))',setpts=PTS",
			"-fps_mode",
			"vfr",
			"-c:v",
			"mpeg4",
			"-y",
			p("vfr.mkv"),
		]);
		await ff(["-f", "lavfi", "-i", "sine=f=440:d=4:r=44100", "-ac", "2", "-y", p("tone.wav")]);
	}, 60_000);

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	/** A small gray rendering of decode-order frame n, for comparing pictures. */
	async function frameAt(file: string, n: number): Promise<Buffer> {
		return ff([
			"-i",
			file,
			"-vf",
			`select=eq(n\\,${n}),scale=64:48,format=gray`,
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"-",
		]);
	}
	const diff = (a: Buffer, b: Buffer) => {
		let t = 0;
		for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]);
		return t / a.length;
	};

	it("keeps a held frame that spans the cut (VFR piece)", async () => {
		// 4 s at 30 fps; frames 30..89 dropped, so source frame 29 is held from 0.967 s to 3 s.
		await ff([
			"-f",
			"lavfi",
			"-i",
			"testsrc=d=4:s=320x240:r=30",
			"-vf",
			"select='not(between(n,30,89))',setpts=PTS",
			"-fps_mode",
			"vfr",
			"-c:v",
			"mpeg4",
			"-q:v",
			"2",
			"-y",
			p("hold.mkv"),
		]);
		await prepareVideo(FFMPEG, p("hold.mkv"), p("hold-out.mov"), {
			speed: 2,
			startSec: 1.5,
			endSec: 4,
		});
		const n = (await framePts(p("hold-out.mov"))).length;
		expect(Math.abs(n - 37.5)).toBeLessThanOrEqual(1.5);
		const out0 = await frameAt(p("hold-out.mov"), 0);
		// File frame 29 is the held picture; file frame 30 is source frame 90.
		expect(diff(out0, await frameAt(p("hold.mkv"), 29))).toBeLessThan(
			diff(out0, await frameAt(p("hold.mkv"), 30)),
		);
	}, 60_000);

	it("gives a retimed piece exactly the planned frames, cut or padded", async () => {
		// 3.1 s of the take at 2x is 46.5 programme frames: the plan owns 47 (or 46), never 'about'.
		for (const frames of [46, 47]) {
			await prepareVideo(FFMPEG, p("cfr.mkv"), p(`exact-${frames}.mov`), {
				speed: 2,
				startSec: 0.5,
				endSec: 3.6,
				frames,
			});
			expect((await framePts(p(`exact-${frames}.mov`))).length).toBe(frames);
			expect((await probeFrameTiming(FFMPEG, p(`exact-${frames}.mov`))).frames).toBe(frames);
		}
		// The take ends before the piece does: the last picture is held to the planned length.
		await prepareVideo(FFMPEG, p("cfr.mkv"), p("exact-pad.mov"), {
			speed: 2,
			startSec: 3,
			endSec: 4,
			frames: 30,
		});
		expect((await framePts(p("exact-pad.mov"))).length).toBe(30);
	}, 60_000);

	it("gives a retimed WAV exactly frames / 30 * 48000 samples, cut or padded", async () => {
		await prepareWav(FFMPEG, p("tone.wav"), p("exact.wav"), {
			speed: 2,
			startSec: 0,
			endSec: 3.1,
			frames: 47,
		});
		expect(Math.round(wavSeconds(p("exact.wav")) * 48000)).toBe((47 / 30) * 48000);
		// A 4 s tone at 2x is 2 s: asked for 5 s, the rest is silence.
		await prepareWav(FFMPEG, p("tone.wav"), p("exact-pad.wav"), {
			speed: 2,
			startSec: 0,
			endSec: 4,
			frames: 150,
		});
		expect(Math.round(wavSeconds(p("exact-pad.wav")) * 48000)).toBe(5 * 48000);
	}, 60_000);

	it("reports the frame count of a prepared video and of a WAV", async () => {
		expect((await probeFrameTiming(FFMPEG, p("cfr.mkv"))).frames).toBe(120);
		expect(await probeAudioFrames(FFMPEG, p("tone.wav"))).toBe(120);
	}, 30_000);

	it("always writes at least one frame for a very short piece", async () => {
		await prepareVideo(FFMPEG, p("cfr.mkv"), p("short.mov"), {
			speed: 2,
			startSec: 1,
			endSec: 1.02,
		});
		expect((await framePts(p("short.mov"))).length).toBeGreaterThanOrEqual(1);
	}, 30_000);

	it("re-encodes a 25 fps CFR source to 30 fps", async () => {
		await ff([
			"-f",
			"lavfi",
			"-i",
			"testsrc=d=2:s=320x240:r=25",
			"-c:v",
			"mpeg4",
			"-y",
			p("c25.mkv"),
		]);
		const t = await probeFrameTiming(FFMPEG, p("c25.mkv"));
		expect(t.constant).toBe(true);
		expect(Math.abs(t.fps - 25)).toBeLessThan(0.05);
		const r = await prepareVideo(FFMPEG, p("c25.mkv"), p("c25-out.mov"), { speed: 1 });
		expect(r.cloned).toBe(false);
		const o = await probeFrameTiming(FFMPEG, p("c25-out.mov"));
		expect(Math.abs(o.fps - 30)).toBeLessThan(0.05);
		expect(Math.abs((await framePts(p("c25-out.mov"))).length - 60)).toBeLessThanOrEqual(1);
	}, 30_000);

	it("keeps source PTS as the frame index when the file starts late", async () => {
		await ff([
			"-f",
			"lavfi",
			"-i",
			"testsrc=d=4:s=320x240:r=30",
			"-vf",
			"setpts=PTS+1/TB",
			"-fps_mode",
			"vfr",
			"-c:v",
			"mpeg4",
			"-q:v",
			"2",
			"-y",
			p("late.mkv"),
		]);
		const t = await probeFrameTiming(FFMPEG, p("late.mkv"));
		expect(Math.abs(t.startSec - 1)).toBeLessThan(0.01);
		const r = await prepareVideo(FFMPEG, p("late.mkv"), p("late-out.mov"), { speed: 1 });
		expect(r.cloned).toBe(false);
		expect(Math.abs((await framePts(p("late-out.mov"))).length - 150)).toBeLessThanOrEqual(1);
		const first = await frameAt(p("late.mkv"), 0);
		const out30 = await frameAt(p("late-out.mov"), 30);
		expect(diff(out30, first)).toBeLessThan(diff(out30, await frameAt(p("late.mkv"), 10)));
	}, 60_000);

	it("rejects a bad speed and flags a missing audio stream", async () => {
		await expect(prepareVideo(FFMPEG, p("cfr.mkv"), p("bad.mov"), { speed: 0 })).rejects.toThrow();
		await expect(
			prepareWav(FFMPEG, p("tone.wav"), p("bad.wav"), { speed: Number.NaN }),
		).rejects.toThrow();
		expect(() => atempoChain(0)).toThrow();
		await expect(
			prepareWav(FFMPEG, p("cfr.mkv"), p("noaudio.wav"), { speed: 1 }),
		).rejects.toBeInstanceOf(NoAudioStreamError);
		expect(existsSync(p("noaudio.wav"))).toBe(false);
	}, 30_000);

	it("detects CFR and VFR", async () => {
		expect(await isConstantFrameRate(FFMPEG, p("cfr.mkv"))).toBe(true);
		expect(await isConstantFrameRate(FFMPEG, p("vfr.mkv"))).toBe(false);
	});

	it("clones a CFR video untouched", async () => {
		const r = await prepareVideo(FFMPEG, p("cfr.mkv"), p("cfr-out.mkv"), { speed: 1 });
		expect(r.cloned).toBe(true);
		expect(statSync(p("cfr-out.mkv")).size).toBe(statSync(p("cfr.mkv")).size);
	});

	it("turns a VFR video into CFR 30 with duration x 30 frames", async () => {
		const r = await prepareVideo(FFMPEG, p("vfr.mkv"), p("vfr-out.mov"), { speed: 1 });
		expect(r.cloned).toBe(false);
		expect(await isConstantFrameRate(FFMPEG, p("vfr-out.mov"))).toBe(true);
		const n = (await framePts(p("vfr-out.mov"))).length;
		expect(Math.abs(n - 120)).toBeLessThanOrEqual(1);
	}, 60_000);

	it("retimes a 4 s piece at 2x into 60 frames", async () => {
		const r = await prepareVideo(FFMPEG, p("cfr.mkv"), p("fast.mov"), {
			speed: 2,
			startSec: 0,
			endSec: 4,
		});
		expect(r.cloned).toBe(false);
		const pts = await framePts(p("fast.mov"));
		expect(Math.abs(pts.length - 60)).toBeLessThanOrEqual(1);
		expect(pts[0]).toBe(0);
	}, 60_000);

	it("clones a wav at speed 1 and halves it at 2x", async () => {
		expect((await prepareWav(FFMPEG, p("tone.wav"), p("tone-1.wav"), { speed: 1 })).cloned).toBe(
			true,
		);
		const r = await prepareWav(FFMPEG, p("tone.wav"), p("tone-2.wav"), { speed: 2 });
		expect(r.cloned).toBe(false);
		expect(Math.abs(wavSeconds(p("tone-2.wav")) - 2)).toBeLessThanOrEqual(0.001);
		// 48 kHz, 24-bit, source's 2 channels kept.
		const hdr = readFileSync(p("tone-2.wav"));
		expect(hdr.readUInt16LE(22)).toBe(2);
		expect(hdr.readUInt32LE(24)).toBe(48000);
		expect(hdr.readUInt16LE(34)).toBe(24);
	}, 30_000);

	it("downmixes a wav range to mono", async () => {
		await prepareWav(FFMPEG, p("tone.wav"), p("mono.wav"), {
			speed: 1,
			startSec: 1,
			endSec: 3,
			channels: 1,
		});
		expect(readFileSync(p("mono.wav")).readUInt16LE(22)).toBe(1);
		expect(Math.abs(wavSeconds(p("mono.wav")) - 2)).toBeLessThanOrEqual(0.001);
	});

	it("chains atempo outside 0.5..2", () => {
		expect(atempoChain(1.5)).toBe("atempo=1.5");
		expect(atempoChain(4)).toBe("atempo=2,atempo=2");
		expect(atempoChain(0.25)).toBe("atempo=0.5,atempo=0.5");
	});

	async function pixel(file: string, x = 0, y = 0, w = 0): Promise<number[]> {
		const raw = await ff([
			"-i",
			file,
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgb24",
			"-frames:v",
			"1",
			"-",
		]);
		const o = (y * w + x) * 3;
		return [raw[o], raw[o + 1], raw[o + 2]];
	}

	async function size(file: string): Promise<[number, number]> {
		const b = readFileSync(file);
		return [b.readUInt32BE(16), b.readUInt32BE(20)];
	}

	const noImages = { blur: false, resolveImagePath: () => null };

	it("renders a colour still of the right size and colour", async () => {
		await backgroundStill(
			FFMPEG,
			{ kind: "color", color: "#336699" },
			108,
			192,
			p("c.png"),
			noImages,
		);
		expect(await size(p("c.png"))).toEqual([108, 192]);
		const px = await pixel(p("c.png"));
		expect(Math.abs(px[0] - 0x33)).toBeLessThanOrEqual(2);
		expect(Math.abs(px[1] - 0x66)).toBeLessThanOrEqual(2);
		expect(Math.abs(px[2] - 0x99)).toBeLessThanOrEqual(2);
	});

	it("renders a gradient still that runs in the CSS direction", async () => {
		// 90deg = to right: left is the first stop (red), right the last (blue).
		await backgroundStill(
			FFMPEG,
			{ kind: "gradient", angleDeg: 90, stops: ["#ff0000", "#0000ff"], offsets: [0, 1] },
			200,
			100,
			p("g.png"),
			{ blur: true, resolveImagePath: () => null },
		);
		expect(await size(p("g.png"))).toEqual([200, 100]);
		const left = await pixel(p("g.png"), 2, 50, 200);
		const right = await pixel(p("g.png"), 197, 50, 200);
		expect(left[0]).toBeGreaterThan(left[2]);
		expect(right[2]).toBeGreaterThan(right[0]);
		// 180deg = to bottom: top is the first stop.
		await backgroundStill(
			FFMPEG,
			{
				kind: "gradient",
				angleDeg: 180,
				stops: ["#ff0000", "#0000ff", "#00ff00"],
				offsets: [0, 0.2, 1],
			},
			100,
			200,
			p("g2.png"),
			noImages,
		);
		const top = await pixel(p("g2.png"), 50, 1, 100);
		expect(top[0]).toBeGreaterThan(top[2]);
	});

	it("cover-fits an image path and a data URL", async () => {
		await backgroundStill(
			FFMPEG,
			{ kind: "color", color: "#ff0000" },
			64,
			32,
			p("src.png"),
			noImages,
		);
		await backgroundStill(FFMPEG, { kind: "image", path: "wall" }, 50, 100, p("img.png"), {
			blur: true,
			resolveImagePath: (q) => (q === "wall" ? p("src.png") : null),
		});
		expect(await size(p("img.png"))).toEqual([50, 100]);
		const url = `data:image/png;base64,${readFileSync(p("src.png")).toString("base64")}`;
		await backgroundStill(FFMPEG, { kind: "image", path: url }, 40, 40, p("img2.png"), noImages);
		expect(await size(p("img2.png"))).toEqual([40, 40]);
		await expect(
			backgroundStill(FFMPEG, { kind: "image", path: "missing" }, 40, 40, p("x.png"), noImages),
		).rejects.toThrow();
	});

	it("builds a cursor atlas as wide as its sprites", async () => {
		const pub = path.resolve(__dirname, "../../public");
		const names = ["arrow", "pointer", "text"] as const;
		const sprites = names.map((name) => ({
			name,
			path: path.join(pub, DEFAULT_CURSOR_SPRITES[name].assetPath),
			hotspot: [DEFAULT_CURSOR_SPRITES[name].hotspotX, DEFAULT_CURSOR_SPRITES[name].hotspotY] as [
				number,
				number,
			],
		}));
		const sizes = sprites.map((s) => {
			const b = readFileSync(s.path);
			return [b.readUInt32BE(16), b.readUInt32BE(20)];
		});
		const r = await cursorAtlas(FFMPEG, sprites, p("atlas.png"));
		expect(r.width).toBe(sizes.reduce((a, s) => a + s[0], 0));
		expect(r.height).toBe(Math.max(...sizes.map((s) => s[1])));
		expect(await size(p("atlas.png"))).toEqual([r.width, r.height]);
		expect(r.kinds.map((k) => k.name)).toEqual([...names]);
		expect(r.kinds[1].rect[0]).toBe(sizes[0][0]);
		expect(r.kinds[0].hotspot).toEqual(sprites[0].hotspot);
		// RGBA colour type (6) in the IHDR.
		expect(readFileSync(p("atlas.png"))[25]).toBe(6);
	});
});
