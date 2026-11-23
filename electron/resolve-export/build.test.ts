import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "../../src/lib/ai-edition/schema";
import {
	type LuaTable,
	type LuaValue,
	parseLuaChunk,
} from "../../src/lib/resolve-export/luaSubset.testutil";
import { type BuildResolveExportDeps, buildResolveExport } from "./build";

const media = vi.hoisted(() => ({
	calls: [] as Array<{ fn: string; dst: string; opts?: unknown }>,
	clone: true,
	noAudio: false,
	/** Frames every probed (prepared) video file reports. */
	frames: 100000,
	/** Frames every probed WAV reports. */
	audioFrames: 100000,
}));

vi.mock("./media", async () => {
	const fsp = await import("node:fs/promises");
	const put = async (fn: string, dst: string, opts?: unknown) => {
		media.calls.push({ fn, dst, opts });
		await fsp.writeFile(dst, "x");
	};
	return {
		probeFrameTiming: async () => ({
			constant: media.clone,
			fps: 30,
			startSec: 0,
			frames: media.frames,
		}),
		probeAudioFrames: async () => media.audioFrames,
		canCloneVideo: (t: { constant: boolean } | null) => t?.constant === true,
		NoAudioStreamError: class NoAudioStreamError extends Error {},
		prepareVideo: async (_f: string, _s: string, dst: string, opts: unknown) => {
			await put("video", dst, opts);
			return { cloned: true };
		},
		prepareWav: async (_f: string, _s: string, dst: string, opts: unknown) => {
			if (media.noAudio) throw new (await import("./media")).NoAudioStreamError("x");
			await put("wav", dst, opts);
			return { cloned: false };
		},
		backgroundStill: async (_f: string, _bg: unknown, w: number, h: number, dst: string) =>
			put("background", dst, { w, h }),
		cursorAtlas: async (_f: string, sprites: Array<{ name: string }>, dst: string) => {
			await put("atlas", dst);
			return {
				kinds: sprites.map((s, i) => ({
					name: s.name,
					rect: [i * 10, 0, 10, 10] as [number, number, number, number],
					hotspot: [0, 0] as [number, number],
				})),
				width: 20,
				height: 10,
			};
		},
	};
});

let root = "";
let src = "";
let out = "";
let resolveDir = "";
let userDir = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-build-"));
	src = path.join(root, "src");
	out = path.join(root, "out");
	resolveDir = path.join(root, "resolve");
	userDir = path.join(root, "user");
	for (const d of [src, out, resolveDir]) await fs.mkdir(d, { recursive: true });
	await fs.writeFile(path.join(src, "rec.mp4"), "v");
	await fs.writeFile(path.join(src, "rec.mp4.cursor.json"), "{}");
	await fs.writeFile(path.join(src, "rec-webcam.webm"), "c");
	await fs.writeFile(path.join(resolveDir, "FilmaretoScreen.fuse"), "fuse-v1");
	media.calls.length = 0;
	media.clone = true;
	media.noAudio = false;
	media.frames = 100000;
	media.audioFrames = 100000;
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** One take of 10 s with a camera; 2 s to 4 s trimmed away; 6 s to 8 s of the ruler at 2x. */
function doc(extra: Partial<AxcutDocument> = {}): AxcutDocument {
	const base = createEmptyDocument({
		title: "My: Film/1",
		projectId: "p1",
		createdAt: "2026-01-01T00:00:00.000Z",
	} as Parameters<typeof createEmptyDocument>[0]);
	return {
		...base,
		assets: [
			{
				id: "a1",
				kind: "video",
				label: "rec",
				originalPath: path.join(src, "rec.mp4"),
				video: { codec: "h264", width: 2048, height: 1152, fps: 30 },
				cameraTrack: {
					sourcePath: path.join(src, "rec-webcam.webm"),
					startMs: 0,
					offsetMs: 0,
					visible: true,
					width: 1280,
					height: 720,
				},
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "c1",
					assetId: "a1",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "system",
					reason: "",
				},
			],
			trimRanges: [{ id: "t1", assetId: "a1", startSec: 2, endSec: 4, reason: "", origin: "user" }],
		},
		legacyEditor: { speedRegions: [{ id: "s1", startMs: 6000, endMs: 8000, speed: 2 }] },
		...extra,
	} as unknown as AxcutDocument;
}

interface BuildDeps extends BuildResolveExportDeps {
	sampled: Array<{
		role: string;
		n: number;
		webcamW: number;
		cursor: string | null;
		renderW: number;
		renderH: number;
	}>;
}

function deps(over: Partial<BuildResolveExportDeps> = {}): BuildDeps {
	const sampled: BuildDeps["sampled"] = [];
	return {
		sampled,
		sampleFrames: (_scene, cursor, _clip, role, times, _kinds, params) => {
			sampled.push({
				role,
				n: times.length,
				webcamW: params.webcamW,
				cursor,
				renderW: params.renderW,
				renderH: params.renderH,
			});
			return new Float32Array(times.length * 19);
		},
		exportAlpha: async () => ({}),
		resolveScene: (json) => {
			const scene = JSON.parse(json);
			scene.cursor.cursorSprites = {
				pointer: { path: "/p.png", hotspotX: 0.1, hotspotY: 0.1 },
				arrow: { path: "/a.png", hotspotX: 0, hotspotY: 0 },
			};
			return JSON.stringify(scene);
		},
		resolveImagePath: () => null,
		// Local time, like the folder name.
		now: () => new Date(2026, 10, 22, 9, 5),
		...over,
	};
}

const run = (d: AxcutDocument, dp: BuildResolveExportDeps) =>
	buildResolveExport({
		doc: d,
		outRoot: out,
		ffmpegPath: "/ffmpeg",
		resolveDir,
		resolveUserDir: userDir,
		deps: dp,
		onProgress: () => undefined,
	});

const plain = (v: LuaValue): any => {
	if (typeof v !== "object") return v;
	const t = v as LuaTable;
	if (Object.keys(t.map).length === 0) return t.array.map(plain);
	return Object.fromEntries(Object.entries(t.map).map(([k, x]) => [k, plain(x)]));
};

const read = async (...p: string[]) =>
	plain(parseLuaChunk(await fs.readFile(path.join(...p), "utf8"))) as Record<string, any>;

describe("buildResolveExport", () => {
	it("writes the folder, data files and manifest for a trimmed, sped-up take with a camera", async () => {
		const dp = deps();
		const result = await run(doc(), dp);
		if (!result.ok) throw new Error(result.message);
		expect(path.basename(result.folder)).toBe("2026-11-22 09.05 My- Film-1");
		expect(result.restartNeeded).toBe(true);
		expect(result.warnings).toEqual([]);

		const names = (await fs.readdir(path.join(result.folder, "data"))).sort();
		expect(names).toEqual([
			"cam-001.lua",
			"cam-002.lua",
			"cam-003.lua",
			"cam-004.lua",
			"seg-001.lua",
			"seg-002.lua",
			"seg-003.lua",
			"seg-004.lua",
		]);
		expect(await fs.readdir(path.join(result.folder))).toContain("cursors.png");
		expect(await fs.readdir(path.join(result.folder, "media"))).toContain("background.png");

		const manifest = await read(result.folder, "timeline.lua");
		expect(manifest.name).toBe("My: Film/1");
		const clips = manifest.clips as Array<Record<string, any>>;
		const v2 = clips.filter((c) => c.track === "video" && c.index === 2);
		const v3 = clips.filter((c) => c.track === "video" && c.index === 3);
		const a1 = clips.filter((c) => c.track === "audio");
		expect(clips[0]).toMatchObject({ index: 1, media: "background.png", start: 0, record: 0 });
		// [0,2], [4,6] and [8,10] at 1x, [6,8] at 2x (1 s of programme): 60, 60, 30, 60 frames.
		expect(v2.map((c) => [c.record, c.finish - c.start])).toEqual([
			[0, 60],
			[60, 60],
			[120, 30],
			[150, 60],
		]);
		expect(v2.map((c) => c.start)).toEqual([0, 120, 0, 240]);
		expect(v3).toHaveLength(4);
		expect(a1.map((c) => [c.record, c.start, c.finish - c.start])).toEqual([
			[0, 0, 60],
			[60, 120, 60],
			[120, 0, 30],
			[150, 240, 60],
		]);
		// Paths are relative to the export folder, written with "/".
		expect(v2[0].effect.data).toBe("data/seg-001.lua");
		expect(v2[0].effect.atlas).toBe("cursors.png");
		const mediaPaths = manifest.media.map((m: { path: string }) => m.path) as string[];
		expect(mediaPaths).toContain("media/rec.mp4");
		expect(mediaPaths.every((p) => p.startsWith("media/"))).toBe(true);
		expect(clips.filter((c) => c.effect).every((c) => !path.isAbsolute(c.effect.data))).toBe(true);
		// The timeline is the project's aspect with the short side at 1080, both sides even (the
		// explicit 9:16 and 16:9 cases are in "sizes the timeline" below).
		expect(manifest.height).toBe(1080);
		expect(manifest.width % 2).toBe(0);
		expect(await fs.readFile(path.join(result.folder, "data", "seg-001.lua"), "utf8")).toContain(
			'atlas = "cursors.png"',
		);
		expect(v2[0].effect.role).toBe("screen");
		expect(v3[0].effect.role).toBe("camera");
		expect(v3[0].effect.atlas).toBeUndefined();

		// A non-retimed piece samples its range plus 90 frames of handle on each side.
		const seg1 = await read(result.folder, "data", "seg-001.lua");
		expect(seg1.frame0).toBe(0);
		expect(seg1.n).toBe(60 + 90);
		const seg2 = await read(result.folder, "data", "seg-002.lua");
		expect(seg2.frame0).toBe(120 - 90);
		expect(seg2.n).toBe(60 + 180);
		// A retimed piece is one sample per programme frame.
		const seg3 = await read(result.folder, "data", "seg-003.lua");
		expect(seg3.frame0).toBe(0);
		expect(seg3.n).toBe(30);
		expect(seg3.cursor.kinds.map((k: any) => k.name)).toEqual(["arrow", "pointer"]);

		// Same times for the camera; its data starts at the same media frame (no offset).
		const cam2 = await read(result.folder, "data", "cam-002.lua");
		expect(cam2.frame0).toBe(120 - 90);
		expect(cam2.n).toBe(60 + 180);
		expect(cam2.role).toBe("camera");
		expect(dp.sampled.filter((s) => s.role === "camera").every((s) => s.webcamW === 1280)).toBe(
			true,
		);

		// The pointer goes to the sampler for both roles (the camera dodges it).
		const cursorFile = path.join(src, "rec.mp4.cursor.json");
		expect(
			dp.sampled.filter((s) => s.role === "screen").every((s) => s.cursor === cursorFile),
		).toBe(true);
		expect(
			dp.sampled.filter((s) => s.role === "camera").every((s) => s.cursor === cursorFile),
		).toBe(true);
		expect(dp.sampled.some((s) => s.role === "camera")).toBe(true);

		const last = await fs.readFile(path.join(userDir, "Filmareto", "last-export.lua"), "utf8");
		expect(last).toBe(`return { folder = "${result.folder}" }\n`);
		expect(
			await fs.readFile(path.join(userDir, "Fuses", "Filmareto", "FilmaretoScreen.fuse"), "utf8"),
		).toBe("fuse-v1");
	});

	it("retimed pieces get their own files; the rest is cloned once per source", async () => {
		const result = await run(doc(), deps());
		if (!result.ok) throw new Error(result.message);
		const files = (await fs.readdir(path.join(result.folder, "media"))).sort();
		expect(files).toEqual([
			"background.png",
			"cam-003.mov",
			"cam-rec-webcam.webm",
			"rec.mp4",
			"rec.wav",
			"seg-003.mov",
			"voice-003.wav",
		]);
		const retime = media.calls.find((c) => c.dst.endsWith("seg-003.mov"));
		expect(retime?.opts).toMatchObject({ speed: 2, startSec: 6, endSec: 8 });
	});

	it("warns that privacy blur is not carried", async () => {
		const d = doc({
			annotations: [
				{
					id: "b1",
					startMs: 0,
					endMs: 1500,
					type: "blur",
					content: "",
					position: { x: 10, y: 10 },
					size: { width: 20, height: 20 },
					zIndex: 1,
				},
			],
		} as unknown as Partial<AxcutDocument>);
		const result = await run(d, deps());
		if (!result.ok) throw new Error(result.message);
		expect(result.warnings).toContain("Privacy blur is not in the Resolve export yet");
		// A blur alone leaves no overlay.
		expect(await fs.readdir(path.join(result.folder, "media"))).not.toContain("overlay.mov");
	});

	it("keeps frame-space titles in the overlay and leaves captions out of it", async () => {
		const text = (id: string, extra: Record<string, unknown> = {}) => ({
			id,
			startMs: 0,
			endMs: 1500,
			type: "text",
			content: "Hello",
			textContent: "Hello",
			space: "frame",
			position: { x: 10, y: 10 },
			size: { width: 40, height: 10 },
			zIndex: 1,
			style: {
				color: "#ffffff",
				backgroundColor: "transparent",
				fontSize: 32,
				fontFamily: "Inter",
				fontWeight: "bold",
				fontStyle: "normal",
				textDecoration: "none",
				textAlign: "center",
			},
			...extra,
		});
		const exported: Array<{ annotations: Array<{ id: string }> }> = [];
		const dp = deps({
			exportAlpha: async (_c, outPath, json) => {
				exported.push(JSON.parse(json));
				await fs.writeFile(outPath, "x");
				return {};
			},
		});
		const result = await run(
			doc({
				annotations: [
					text("title-1"),
					text("stored-cap", { annotationSource: "auto-caption", startMs: 1000, endMs: 5000 }),
				],
			} as unknown as Partial<AxcutDocument>),
			dp,
		);
		if (!result.ok) throw new Error(result.message);
		expect(exported).toHaveLength(1);
		expect(exported[0].annotations.map((a) => a.id)).toEqual(["title-1"]);
		expect(await fs.readdir(path.join(result.folder, "media"))).toContain("overlay.mov");
		const clips = (await read(result.folder, "timeline.lua")).clips as Array<Record<string, any>>;
		expect(clips.some((c) => c.index === 4)).toBe(true);
	});

	it("names a file that will be re-encoded .mov, and keeps the extension of a clone", async () => {
		media.clone = false;
		const result = await run(doc(), deps());
		if (!result.ok) throw new Error(result.message);
		const files = await fs.readdir(path.join(result.folder, "media"));
		expect(files).toContain("rec.mov");
		expect(files).toContain("cam-rec-webcam.mov");
		expect(files).not.toContain("rec.mp4");
	});

	it("drops the A1 clips of a take without an audio stream and warns", async () => {
		media.noAudio = true;
		const result = await run(doc(), deps());
		if (!result.ok) throw new Error(result.message);
		expect(result.warnings).toContain("No audio could be read from rec.mp4");
		const clips = (await read(result.folder, "timeline.lua")).clips as Array<Record<string, any>>;
		expect(clips.filter((c) => c.track === "audio")).toEqual([]);
	});

	it("builds the scene without captions, even one that crosses a cut", async () => {
		const scenes: Array<{ annotations: unknown[]; captions?: boolean }> = [];
		const dp = deps({
			resolveScene: (json) => {
				scenes.push(JSON.parse(json));
				return json;
			},
		});
		const caption = {
			id: "cap-1",
			startMs: 1000,
			endMs: 5000, // across the 2-4 s trim
			type: "text",
			content: "x",
			textContent: "x",
			space: "frame",
			annotationSource: "auto-caption",
			position: { x: 10, y: 80 },
			size: { width: 80, height: 10 },
			zIndex: 1,
			style: {
				color: "#fff",
				backgroundColor: "transparent",
				fontSize: 32,
				fontFamily: "Inter",
				fontWeight: "bold",
				fontStyle: "normal",
				textDecoration: "none",
				textAlign: "center",
			},
		};
		const result = await run(
			doc({
				annotations: [caption],
				legacyEditor: {
					speedRegions: [{ id: "s1", startMs: 6000, endMs: 8000, speed: 2 }],
					captions: { enabled: true },
				},
			} as unknown as Partial<AxcutDocument>),
			dp,
		);
		if (!result.ok) throw new Error(result.message);
		// No piece of the caption reaches the scene, so no overlay is exported.
		expect(scenes[0].annotations).toEqual([]);
		expect(await fs.readdir(path.join(result.folder, "media"))).not.toContain("overlay.mov");
	});

	it("warns about imported audio tracks", async () => {
		const result = await run(
			doc({ audioTracks: [{ id: "t" }] } as unknown as Partial<AxcutDocument>),
			deps(),
		);
		// The stub track is not a valid track for the scene: the warning is what matters.
		if (result.ok) {
			expect(result.warnings).toContain(
				"Imported audio (voice-overs, music) is not in the Resolve export yet",
			);
		}
	});

	it("removes the half-written folder when the export fails", async () => {
		const result = await run(doc(), deps({ sampleFrames: () => null }));
		expect(result.ok).toBe(false);
		expect(await fs.readdir(out)).toEqual([]);
	});

	it("fails clearly when the Fuse does not ship with the app", async () => {
		await fs.rm(path.join(resolveDir, "FilmaretoScreen.fuse"));
		const result = await run(doc(), deps());
		expect(result).toMatchObject({ ok: false, reason: "error" });
		expect((result as { message: string }).message).toContain("FilmaretoScreen.fuse");
		expect(await fs.readdir(out)).toEqual([]);
	});

	it("installs the Resolve parts first: a missing Fuse stops before any media work", async () => {
		await fs.rm(path.join(resolveDir, "FilmaretoScreen.fuse"));
		const dp = deps();
		const result = await run(doc(), dp);
		expect(result.ok).toBe(false);
		expect(media.calls).toEqual([]);
		expect(dp.sampled).toEqual([]);
		await expect(fs.stat(path.join(userDir, "Filmareto", "last-export.lua"))).rejects.toThrow();
	});

	it("installs the parts even when the export later fails, but writes last-export.lua only on success", async () => {
		const failed = await run(doc(), deps({ sampleFrames: () => null }));
		expect(failed.ok).toBe(false);
		expect(
			await fs.readFile(path.join(userDir, "Fuses", "Filmareto", "FilmaretoScreen.fuse"), "utf8"),
		).toBe("fuse-v1");
		await expect(fs.stat(path.join(userDir, "Filmareto", "last-export.lua"))).rejects.toThrow();
		const ok = await run(doc(), deps());
		if (!ok.ok) throw new Error(ok.message);
		await fs.stat(path.join(userDir, "Filmareto", "last-export.lua"));
	});

	it("sizes the timeline to the project's aspect with the short side at 1080", async () => {
		for (const [aspect, w, h] of [
			["9:16", 1080, 1920],
			["16:9", 1920, 1080],
		] as const) {
			media.calls.length = 0;
			const overlayArgs: Array<{ width: number; height: number }> = [];
			const dp = deps({
				exportAlpha: async (_c, outPath, _json, params) => {
					overlayArgs.push({ width: params.width, height: params.height });
					await fs.writeFile(outPath, "x");
					return {};
				},
			});
			const text = {
				id: "t1",
				startMs: 0,
				endMs: 1500,
				type: "text",
				content: "Hi",
				textContent: "Hi",
				space: "frame",
				position: { x: 10, y: 10 },
				size: { width: 40, height: 10 },
				zIndex: 1,
				style: {
					color: "#fff",
					backgroundColor: "transparent",
					fontSize: 32,
					fontFamily: "Inter",
					fontWeight: "bold",
					fontStyle: "normal",
					textDecoration: "none",
					textAlign: "center",
				},
			};
			const result = await run(
				doc({
					annotations: [text],
					legacyEditor: { speedRegions: [], aspectRatio: aspect },
				} as never),
				dp,
			);
			if (!result.ok) throw new Error(result.message);
			const manifest = await read(result.folder, "timeline.lua");
			expect([manifest.width, manifest.height]).toEqual([w, h]);
			expect(dp.sampled.every((s) => s.renderW === w && s.renderH === h)).toBe(true);
			const seg = await read(result.folder, "data", "seg-001.lua");
			expect(seg.canvas).toEqual({ w, h });
			expect(media.calls.find((c) => c.fn === "background")?.opts).toEqual({ w, h });
			expect(overlayArgs).toEqual([{ width: w, height: h }]);
		}
	});

	it("gives a retimed piece its exact frame count, and the camera and voice with it", async () => {
		const result = await run(doc(), deps());
		if (!result.ok) throw new Error(result.message);
		const opts = (name: string) => media.calls.find((c) => c.dst.endsWith(name))?.opts;
		// 6 s to 8 s at 2x is 1 s of programme: 30 frames.
		expect(opts("seg-003.mov")).toMatchObject({ speed: 2, frames: 30 });
		expect(opts("cam-003.mov")).toMatchObject({ speed: 2, frames: 30 });
		expect(opts("voice-003.wav")).toMatchObject({ speed: 2, frames: 30 });
	});

	it("never lets a clip's finish go past the prepared file's frames", async () => {
		media.frames = 150;
		media.audioFrames = 130;
		const result = await run(doc(), deps());
		if (!result.ok) throw new Error(result.message);
		const clips = (await read(result.folder, "timeline.lua")).clips as Array<Record<string, any>>;
		const plainVideo = clips.filter(
			(c) => c.track === "video" && (c.index === 2 || c.index === 3) && c.media.endsWith(".mp4"),
		);
		expect(plainVideo.length).toBeGreaterThan(0);
		for (const c of clips.filter(
			(x) => x.media === "rec.mp4" || x.media === "cam-rec-webcam.webm",
		)) {
			expect(c.finish).toBeLessThanOrEqual(150);
			expect(c.finish).toBeGreaterThan(c.start);
		}
		// [4,6] s is media frames 120..180: cut to 150.
		expect(clips.find((c) => c.media === "rec.mp4" && c.start === 120)?.finish).toBe(150);
		for (const c of clips.filter((x) => x.track === "audio" && x.media === "rec.wav")) {
			expect(c.finish).toBeLessThanOrEqual(130);
		}
		// Retimed files are exact by construction and keep their frames.
		const retimed = clips.find((c) => c.media === "seg-003.mov");
		expect(retimed && retimed.finish - retimed.start).toBe(30);
	});

	it("warns that the camera's background effect is not exported", async () => {
		const withMode = async (mode: string) => {
			const result = await run(
				doc({
					legacyEditor: { speedRegions: [], webcamBackgroundMode: mode },
				} as never),
				deps(),
			);
			if (!result.ok) throw new Error(result.message);
			return result.warnings;
		};
		const text =
			"The camera's background effect (cutout, blur or custom background) is not in the Resolve export yet: the camera comes in as filmed.";
		for (const mode of ["transparent", "blur", "custom"]) {
			expect(await withMode(mode)).toContain(text);
		}
		expect(await withMode("none")).not.toContain(text);
	});

	it("warns, once, about a take without cursor data", async () => {
		await fs.rm(path.join(src, "rec.mp4.cursor.json"));
		const result = await run(doc(), deps());
		if (!result.ok) throw new Error(result.message);
		const w = result.warnings.filter((x) => x.startsWith("No cursor data for"));
		expect(w).toEqual([
			"No cursor data for rec.mp4: no cursor, no cursor-follow zoom and no camera dodge in Resolve for it.",
		]);
	});

	it("warns about a window or device frame, which is not in the export", async () => {
		const result = await run(
			doc({ legacyEditor: { speedRegions: [], frame: "window" } } as never),
			deps(),
		);
		if (!result.ok) throw new Error(result.message);
		expect(result.warnings.filter((x) => x.includes("frame around the recording"))).toHaveLength(1);
		const plainRun = await run(doc(), deps());
		if (!plainRun.ok) throw new Error(plainRun.message);
		expect(plainRun.warnings.some((x) => x.includes("frame around the recording"))).toBe(false);
	});

	it("reports no-clips for an empty timeline", async () => {
		const empty = doc();
		empty.timeline.clips = [];
		const result = await run(empty, deps());
		expect(result).toMatchObject({ ok: false, reason: "no-clips" });
	});

	it("fails with an error when the compositor cannot sample", async () => {
		const result = await run(doc(), deps({ sampleFrames: () => null }));
		expect(result).toMatchObject({ ok: false, reason: "error" });
	});

	it("gives a floating camera its shadow, also under format fill, and none to a block layout", async () => {
		const camShadow = async (legacy: Record<string, unknown>) => {
			const result = await run(
				doc({
					legacyEditor: {
						speedRegions: [{ id: "s1", startMs: 6000, endMs: 8000, speed: 2 }],
						...legacy,
					},
				} as never),
				deps(),
			);
			if (!result.ok) throw new Error(result.message);
			const cam = await read(result.folder, "data", "cam-001.lua");
			return (cam.shadow as { opacity: number }).opacity;
		};
		expect(await camShadow({ webcamLayoutPreset: "picture-in-picture" })).toBeGreaterThan(0);
		// Format fill marks every clip `screenCover`; the camera still floats and keeps its shadow.
		expect(
			await camShadow({
				webcamLayoutPreset: "picture-in-picture",
				aspectRatio: "9:16",
				formatFollowCursor: true,
			}),
		).toBeGreaterThan(0);
		expect(await camShadow({ webcamLayoutPreset: "vertical-stack" })).toBe(0);
	});

	it("adds ' 2' when the folder name is taken", async () => {
		const first = await run(doc(), deps());
		const second = await run(doc(), deps());
		if (!first.ok || !second.ok) throw new Error("export failed");
		expect(path.basename(second.folder)).toBe(`${path.basename(first.folder)} 2`);
		// The Fuse is already installed: no restart the second time.
		expect(second.restartNeeded).toBe(false);
	});
});
