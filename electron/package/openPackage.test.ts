import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AxcutDocument,
	createEmptyDocument,
	parseDocumentFile,
} from "../../src/lib/ai-edition/schema";
import { registerMediaLinks } from "../media/mediaLinksRegistry";
import { buildEditorPackage } from "./buildPackage";
import { openEditorPackage } from "./openPackage";
import { zipFolder } from "./zip";

vi.mock("../media/mediaLinksRegistry", () => ({
	registerMediaLinks: vi.fn(async () => undefined),
}));

let root = "";
let src = "";
let out = "";
let receive = "";
let cache = "";
let registry = "";
const NOW = new Date("2026-11-20T10:00:00Z");
const ZIP_NAME = "2026-11-20 My Film";

beforeEach(async () => {
	vi.mocked(registerMediaLinks).mockClear();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "open-package-"));
	src = path.join(root, "src");
	out = path.join(root, "out");
	receive = path.join(root, "receive");
	cache = path.join(root, "cache");
	registry = path.join(root, "registry");
	for (const d of [src, out]) await fs.mkdir(d, { recursive: true });
	await fs.writeFile(path.join(src, "rec.mp4"), randomBytes(4096));
	await fs.writeFile(path.join(src, "rec.mp4.cursor.json"), '{"c":1}');
	await fs.writeFile(
		path.join(src, "rec.session.json"),
		JSON.stringify({
			screenVideoPath: path.join(src, "rec.mp4"),
			webcamVideoPath: path.join(src, "rec-webcam.webm"),
			createdAt: 5,
			extra: "kept",
		}),
	);
	await fs.writeFile(path.join(src, "rec-webcam.webm"), randomBytes(2048));
	await fs.mkdir(path.join(cache, "src-sha"), { recursive: true });
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

function doc(extra: Record<string, unknown> = {}): AxcutDocument {
	const base = createEmptyDocument({
		title: "My Film",
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
				cameraTrack: {
					sourcePath: path.join(src, "rec-webcam.webm"),
					startMs: 0,
					offsetMs: 0,
					visible: true,
				},
			},
		],
		...extra,
	} as unknown as AxcutDocument;
}

function annotation(id: string, templateId: string, framePaths: string[] = []) {
	return {
		id,
		startMs: 0,
		endMs: 1000,
		type: "image",
		content: "",
		position: { x: 10, y: 10 },
		size: { width: 10, height: 10 },
		style: {},
		zIndex: 1,
		graphicData: {
			graphicId: `g_${id}`,
			templateId,
			name: id,
			fields: [],
			frames: framePaths.map((p, i) => ({ path: p, atMs: i })),
			durationMs: 1000,
			holdMs: 0,
		},
	};
}

async function pack(d: AxcutDocument = doc()) {
	const res = await buildEditorPackage({
		doc: d,
		outRoot: out,
		appVersion: "1.1.0",
		now: NOW,
	});
	if (!res.ok) throw new Error("pack failed");
	return res;
}

const open = (source: string, more: Record<string, unknown> = {}) =>
	openEditorPackage({
		source,
		receiveRoot: receive,
		graphicsCacheRoot: cache,
		registryDir: registry,
		existingProjectIds: new Set<string>(),
		...more,
	});

function allPaths(d: AxcutDocument): string[] {
	const found: string[] = [];
	for (const a of d.assets) {
		found.push(a.originalPath);
		if (a.cameraTrack) found.push(a.cameraTrack.sourcePath);
		if (a.proxyPath) found.push(a.proxyPath);
	}
	for (const n of d.annotations) for (const f of n.graphicData?.frames ?? []) found.push(f.path);
	return found;
}

async function receiveEntries(): Promise<string[]> {
	return fs.readdir(receive).catch(() => []);
}

async function craft(
	name: string,
	manifestFiles: { path: string; sizeBytes: number }[],
	d: unknown,
	files: Record<string, string> = {},
): Promise<string> {
	const folder = path.join(root, "crafted", name);
	await fs.mkdir(folder, { recursive: true });
	await fs.writeFile(
		path.join(folder, "filmareto-package.json"),
		JSON.stringify({
			format: 1,
			createdAt: "2026-11-20T10:00:00.000Z",
			appVersion: "1.1.0",
			projectId: "p1",
			title: "My Film",
			files: manifestFiles,
		}),
	);
	await fs.writeFile(path.join(folder, "project.openscreen"), JSON.stringify(d));
	for (const [rel, content] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
		await fs.writeFile(path.join(folder, rel), content);
	}
	return folder;
}

describe("openEditorPackage", () => {
	it("opens a zip with the sources gone, every path absolute and present", async () => {
		const { zipPath } = await pack();
		await fs.rm(src, { recursive: true });
		await fs.rm(out.concat("/", ZIP_NAME), { recursive: true });
		const res = await open(zipPath);
		if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res)}`);
		expect(path.dirname(res.folderPath)).toBe(receive);
		expect(path.basename(res.folderPath)).toBe(ZIP_NAME);
		const paths = allPaths(res.doc);
		expect(paths.length).toBe(2);
		for (const p of paths) {
			expect(path.isAbsolute(p)).toBe(true);
			expect(p.startsWith(`${receive}/`)).toBe(true);
			await fs.stat(p);
		}
		expect(await receiveEntries()).toEqual([ZIP_NAME]);
	});

	it("opens the unzipped folder the same way", async () => {
		const { folderPath } = await pack();
		await fs.rm(src, { recursive: true });
		const res = await open(folderPath);
		if (!res.ok) throw new Error("expected ok");
		expect(path.basename(res.folderPath)).toBe(ZIP_NAME);
		expect(res.doc.assets[0].originalPath).toBe(path.join(res.folderPath, "media", "rec.mp4"));
		expect(await receiveEntries()).toEqual([ZIP_NAME]);
		await fs.stat(folderPath);
	});

	it("rewrites the session manifest to the received paths and keeps its other fields", async () => {
		const { zipPath } = await pack();
		const res = await open(zipPath);
		if (!res.ok) throw new Error("expected ok");
		const session = JSON.parse(
			await fs.readFile(path.join(res.folderPath, "media", "rec.session.json"), "utf8"),
		);
		expect(session.screenVideoPath).toBe(path.join(res.folderPath, "media", "rec.mp4"));
		expect(session.webcamVideoPath).toBe(path.join(res.folderPath, "media", "rec-webcam.webm"));
		expect(session.extra).toBe("kept");
		expect(session.createdAt).toBe(5);
	});

	it("keeps the cursor sidecar next to the received video and registers the links", async () => {
		const { zipPath } = await pack();
		const res = await open(zipPath);
		if (!res.ok) throw new Error("expected ok");
		const video = path.join(res.folderPath, "media", "rec.mp4");
		expect(await fs.readFile(`${video}.cursor.json`, "utf8")).toBe('{"c":1}');
		expect(registerMediaLinks).toHaveBeenCalledWith(registry, video, {
			webcamVideoPath: path.join(res.folderPath, "media", "rec-webcam.webm"),
			cursorTelemetryPath: `${video}.cursor.json`,
		});
	});

	it("copies graphic frames into the cache without overwriting", async () => {
		await fs.mkdir(path.join(cache, "abc"), { recursive: true });
		await fs.mkdir(path.join(cache, "def"), { recursive: true });
		await fs.writeFile(path.join(cache, "abc", "f1.png"), "package-1");
		await fs.writeFile(path.join(cache, "def", "f2.png"), "new-2");
		const d = doc({
			annotations: [
				annotation("n1", "user:lower", [path.join(cache, "abc", "f1.png")]),
				annotation("n2", "user:other", [path.join(cache, "def", "f2.png")]),
			],
		});
		const { zipPath } = await pack(d);
		// Another Mac: the first frame already exists there with other content, the second does not.
		await fs.writeFile(path.join(cache, "abc", "f1.png"), "keep-me");
		await fs.rm(path.join(cache, "def"), { recursive: true });
		const res = await open(zipPath);
		if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res)}`);
		expect(await fs.readFile(path.join(cache, "abc", "f1.png"), "utf8")).toBe("keep-me");
		expect(await fs.readFile(path.join(cache, "def", "f2.png"), "utf8")).toBe("new-2");
		const frames = res.doc.annotations
			.flatMap((n) => n.graphicData?.frames ?? [])
			.map((f) => f.path);
		expect(frames).toEqual([path.join(cache, "abc", "f1.png"), path.join(cache, "def", "f2.png")]);
	});

	it("reports exists, then copies with a new id and title or replaces with the same id", async () => {
		const { zipPath } = await pack();
		const ids = new Set(["p1"]);
		const exists = await open(zipPath, { existingProjectIds: ids });
		expect(exists).toEqual({ ok: false, reason: "exists", projectId: "p1", title: "My Film" });
		expect(await receiveEntries()).toEqual([]);

		const copy = await open(zipPath, { existingProjectIds: ids, mode: "copy" });
		if (!copy.ok) throw new Error("expected ok");
		expect(copy.doc.project.id).toMatch(/^proj_[A-Za-z0-9_-]+$/);
		expect(copy.doc.project.id).not.toBe("p1");
		expect(copy.doc.project.title).toBe("My Film (2)");

		const replace = await open(zipPath, { existingProjectIds: ids, mode: "replace" });
		if (!replace.ok) throw new Error("expected ok");
		expect(replace.doc.project.id).toBe("p1");
		expect(path.basename(replace.folderPath)).toBe(`${ZIP_NAME} (2)`);
		expect((await receiveEntries()).sort()).toEqual([ZIP_NAME, `${ZIP_NAME} (2)`]);
	});

	it("says not-a-package for a zip without a manifest and leaves nothing behind", async () => {
		const folder = path.join(root, "plain");
		await fs.mkdir(folder, { recursive: true });
		await fs.writeFile(path.join(folder, "a.txt"), "x");
		const zip = path.join(root, "plain.zip");
		await zipFolder(folder, zip);
		const res = await open(zip);
		expect(res).toMatchObject({ ok: false, reason: "not-a-package" });
		expect(await receiveEntries()).toEqual([]);
	});

	it("says damaged for a truncated zip and leaves nothing behind", async () => {
		const { zipPath } = await pack();
		const bytes = await fs.readFile(zipPath);
		const cut = path.join(root, "cut.zip");
		await fs.writeFile(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
		const res = await open(cut);
		expect(res).toMatchObject({ ok: false, reason: "damaged" });
		expect(await receiveEntries()).toEqual([]);
	});

	it("says damaged when the project file is not valid", async () => {
		const folder = await craft("Bad", [], { nope: true });
		expect(await open(folder)).toMatchObject({ ok: false, reason: "damaged" });
		await fs.writeFile(path.join(folder, "project.openscreen"), "{not json");
		expect(await open(folder)).toMatchObject({ ok: false, reason: "damaged" });
		expect(await receiveEntries()).toEqual([]);
	});

	it("names the manifest file that is missing from the folder", async () => {
		const { folderPath } = await pack();
		await fs.rm(path.join(folderPath, "media", "rec-webcam.webm"));
		const res = await open(folderPath);
		expect(res).toEqual({ ok: false, reason: "missing-files", detail: ["rec-webcam.webm"] });
		expect(await receiveEntries()).toEqual([]);
	});

	it("says damaged, naming the file, when a folder file differs from its manifest size", async () => {
		const { zipPath } = await pack();
		const unzipped = path.join(root, "unzipped");
		await fs.mkdir(unzipped);
		const { unzipTo } = await import("./zip");
		await unzipTo(zipPath, unzipped);
		const folderPath = path.join(unzipped, ZIP_NAME);
		const video = path.join(folderPath, "media", "rec.mp4");
		await fs.truncate(video, 100);
		const res = await open(folderPath);
		expect(res).toEqual({ ok: false, reason: "damaged", detail: ["rec.mp4"] });
		expect(await receiveEntries()).toEqual([]);
	});

	it("says not-a-package for a manifest with a negative size", async () => {
		const folder = await craft("Neg", [{ path: "media/a.mp4", sizeBytes: -5 }], doc(), {
			"media/a.mp4": "v",
		});
		expect(await open(folder)).toMatchObject({ ok: false, reason: "not-a-package" });
		expect(await receiveEntries()).toEqual([]);
	});

	it("strips a clip look to the segment keys, wallpaper included", async () => {
		const d = doc();
		d.assets[0].originalPath = "media/rec.mp4";
		(d.assets[0].cameraTrack as { sourcePath: string }).sourcePath = "media/rec-webcam.webm";
		d.timeline.clips.push({
			id: "c1",
			assetId: "a1",
			sourceStartSec: 0,
			sourceEndSec: 1,
			timelineStartSec: 0,
			timelineEndSec: 1,
			origin: "user",
			wordRefs: [],
			reason: "",
			look: {
				wallpaper: "/Users/x/p.jpg",
				webcamWallpaper: "/Users/x/q.jpg",
				borderRadius: 12,
			},
		} as unknown as AxcutDocument["timeline"]["clips"][number]);
		const folder = await craft(
			"Look",
			[
				{ path: "media/rec.mp4", sizeBytes: 1 },
				{ path: "media/rec-webcam.webm", sizeBytes: 1 },
			],
			d,
			{ "media/rec.mp4": "v", "media/rec-webcam.webm": "w" },
		);
		const res = await open(folder);
		if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res)}`);
		expect(res.doc.timeline.clips[0].look).toEqual({ borderRadius: 12 });
	});

	it("refuses a package holding a symlink", async () => {
		const { folderPath } = await pack();
		const outside = path.join(root, "secret.txt");
		await fs.writeFile(outside, "secret");
		const video = path.join(folderPath, "media", "rec.mp4");
		await fs.rm(video);
		await fs.symlink(outside, video);
		const res = await open(folderPath);
		expect(res).toEqual({ ok: false, reason: "not-a-package", detail: ["media/rec.mp4"] });
		expect(await receiveEntries()).toEqual([]);
	});

	it("says missing-files for a referenced media file absent from the package", async () => {
		const { folderPath } = await pack();
		await fs.rm(path.join(folderPath, "media", "rec.mp4"));
		const manifestPath = path.join(folderPath, "filmareto-package.json");
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
		manifest.files = manifest.files.filter((f: { path: string }) => f.path !== "media/rec.mp4");
		await fs.writeFile(manifestPath, JSON.stringify(manifest));
		const res = await open(folderPath);
		expect(res).toEqual({ ok: false, reason: "missing-files", detail: ["rec.mp4"] });
		expect(await receiveEntries()).toEqual([]);
	});

	it("clears an optional proxy that is absent instead of failing", async () => {
		const { folderPath } = await pack();
		const projectPath = path.join(folderPath, "project.openscreen");
		const project = JSON.parse(await fs.readFile(projectPath, "utf8"));
		project.assets[0].proxyPath = "media/gone-proxy.mp4";
		await fs.writeFile(projectPath, JSON.stringify(project));
		const res = await open(folderPath);
		if (!res.ok) throw new Error("expected ok");
		expect(res.doc.assets[0].proxyPath).toBeUndefined();
	});

	it("says damaged for a corrupt session manifest and touches no shared folder", async () => {
		await fs.mkdir(path.join(cache, "abc"), { recursive: true });
		await fs.writeFile(path.join(cache, "abc", "f1.png"), "f");
		const d = doc({
			annotations: [annotation("n1", "user:lower", [path.join(cache, "abc", "f1.png")])],
		});
		await fs.writeFile(path.join(src, "rec.session.json"), "null");
		const { folderPath } = await pack(d);
		await fs.rm(path.join(cache, "abc"), { recursive: true });
		expect(await open(folderPath)).toEqual({ ok: false, reason: "damaged" });
		await fs.writeFile(path.join(folderPath, "media", "rec.session.json"), "{oops");
		expect(await open(folderPath)).toMatchObject({ ok: false, reason: "damaged" });
		expect(await receiveEntries()).toEqual([]);
		expect(await fs.readdir(cache)).toEqual(["src-sha"]);
		expect(registerMediaLinks).not.toHaveBeenCalled();
	});

	it("undoes frames and registry when registering fails, and rethrows", async () => {
		await fs.mkdir(path.join(cache, "abc"), { recursive: true });
		await fs.writeFile(path.join(cache, "abc", "f1.png"), "f");
		const d = doc({
			annotations: [annotation("n1", "user:lower", [path.join(cache, "abc", "f1.png")])],
		});
		const { zipPath } = await pack(d);
		await fs.rm(path.join(cache, "abc"), { recursive: true });
		vi.mocked(registerMediaLinks).mockImplementationOnce(async (dir: string) => {
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, "media-links.registry.json"), "{}");
			throw new Error("registry broke");
		});
		await expect(open(zipPath)).rejects.toThrow("registry broke");
		expect(await receiveEntries()).toEqual([]);
		expect(await fs.readdir(cache)).toEqual(["src-sha"]);
		expect(await fs.readdir(registry).catch(() => [])).toEqual([]);
	});

	it("opens an ext: video with a camera and no file", async () => {
		const d = doc();
		d.assets[0].originalPath = "media/rec.mp4";
		(d.assets[0].cameraTrack as { sourcePath: string }).sourcePath = "media/rec-webcam.webm";
		d.assets.push({
			id: "ext:g1",
			kind: "video",
			label: "g",
			originalPath: "media/g1.mp4",
			cameraTrack: { sourcePath: "media/g1-cam.webm", startMs: 0, offsetMs: 0, visible: true },
		} as unknown as AxcutDocument["assets"][number]);
		const folder = await craft("Ext", [], d, {
			"media/rec.mp4": "v",
			"media/rec-webcam.webm": "w",
		});
		const res = await open(folder);
		if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res)}`);
		const registered = vi.mocked(registerMediaLinks).mock.calls.map((c) => path.basename(c[1]));
		expect(registered).toEqual(["rec.mp4"]);
	});

	it("accepts a package holding graphics-templates but never installs them", async () => {
		const d = doc({ annotations: [annotation("n1", "user:x")] });
		d.assets[0].originalPath = "media/rec.mp4";
		(d.assets[0].cameraTrack as { sourcePath: string }).sourcePath = "media/rec-webcam.webm";
		const folder = await craft("Tpl", [], d, {
			"media/rec.mp4": "v",
			"media/rec-webcam.webm": "w",
			"graphics-templates/x/index.html": "<script>evil()</script>",
		});
		const before = (await fs.readdir(root)).sort();
		const res = await open(folder);
		if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res)}`);
		// Only the received folder has it; no templates folder appears anywhere beside it.
		await fs.stat(path.join(res.folderPath, "graphics-templates", "x", "index.html"));
		expect((await fs.readdir(root)).sort()).toEqual([...before, "receive"].sort());
		expect(await fs.readdir(cache)).toEqual(["src-sha"]);
	});

	it("packs and opens a user graphic without any template folder", async () => {
		await fs.mkdir(path.join(cache, "abc"), { recursive: true });
		await fs.writeFile(path.join(cache, "abc", "f1.png"), "frame");
		const d = doc({
			annotations: [annotation("n1", "user:lower", [path.join(cache, "abc", "f1.png")])],
		});
		const { folderPath } = await pack(d);
		expect(await fs.readdir(folderPath)).not.toContain("graphics-templates");
	});

	it("keeps a real graphic through pack and open, and drops image annotations naming files", async () => {
		await fs.mkdir(path.join(cache, "abc"), { recursive: true });
		await fs.writeFile(path.join(cache, "abc", "f1.png"), "frame");
		const d = doc({
			annotations: [
				annotation("g", "builtin:x", [path.join(cache, "abc", "f1.png")]),
				{ ...annotation("p", "builtin:x"), graphicData: undefined, content: "/Users/x/a.png" },
				{
					...annotation("u", "builtin:x"),
					graphicData: undefined,
					imageContent: "file:///Users/x/a.png",
				},
				{
					...annotation("e", "builtin:x"),
					graphicData: undefined,
					content: "data:image/png;base64,AA",
				},
			],
		});
		const { zipPath } = await pack(d);
		await fs.rm(path.join(cache, "abc"), { recursive: true });
		const res = await open(zipPath);
		if (!res.ok) throw new Error("expected ok");
		expect(res.doc.annotations.map((a) => a.id)).toEqual(["g", "e"]);
		expect(await fs.readFile(path.join(cache, "abc", "f1.png"), "utf8")).toBe("frame");
	});

	it("keeps only allow-listed wallpapers, for both wallpaper fields", async () => {
		const run = async (name: string, value: unknown) => {
			const d = doc({ legacyEditor: { wallpaper: value, webcamWallpaper: value, other: "/keep" } });
			d.assets[0].originalPath = "media/rec.mp4";
			(d.assets[0].cameraTrack as { sourcePath: string }).sourcePath = "media/rec-webcam.webm";
			const folder = await craft(name, [], d, {
				"media/rec.mp4": "v",
				"media/rec-webcam.webm": "w",
			});
			const res = await open(folder);
			if (!res.ok) throw new Error("expected ok");
			const legacy = res.doc.legacyEditor as Record<string, unknown>;
			expect(legacy.other).toBe("/keep");
			expect(legacy.webcamWallpaper).toBe(legacy.wallpaper);
			return legacy.wallpaper;
		};
		const DEFAULT = "/wallpapers/wallpaper11.jpg";
		const reset: unknown[] = [
			" file:///Users/x/p.jpg",
			"/wallpapers/../x",
			"/Users/x/p.jpg",
			"Users/x/p.jpg",
			"../x.jpg",
			"https://example.com/a.jpg",
			"data:image/png;base64,AAAA), url(file:///Users/x/p.jpg",
			'linear-gradient(#000,#000), image-set("../x.jpg" 1x)',
			"linear-gradient(#000,#000), \\75rl(x)",
			"linear-gradient(red, url(file:///x))",
			"/wallpapers/%2e%2e%2fx",
			42,
		];
		for (const [i, v] of reset.entries()) expect(await run(`Reset${i}`, v)).toBe(DEFAULT);
		const kept = [
			"/wallpapers/wallpaper11.jpg",
			"#123456",
			"linear-gradient(135deg, #ff0000 0%, #0000ff 100%)",
			"rgb(10, 20, 30)",
			"data:image/png;base64,iVBORw0KGgo=",
		];
		for (const [i, v] of kept.entries()) expect(await run(`Kept${i}`, v)).toBe(v);
	});

	it("says not-a-package for a folder without a manifest before copying it", async () => {
		const folder = path.join(root, "plainfolder");
		await fs.mkdir(folder, { recursive: true });
		await fs.writeFile(path.join(folder, "big.bin"), "x");
		expect(await open(folder)).toMatchObject({ ok: false, reason: "not-a-package" });
		expect(await receiveEntries()).toEqual([]);
	});

	it("refuses an unsafe manifest path", async () => {
		const folder = await craft("Evil", [{ path: "../evil", sizeBytes: 1 }], doc());
		const res = await open(folder);
		expect(res).toEqual({ ok: false, reason: "not-a-package", detail: ["../evil"] });
		expect(await receiveEntries()).toEqual([]);
	});

	it("refuses absolute and escaping paths inside the project and touches nothing outside", async () => {
		const d = doc();
		d.assets[0].originalPath = "/etc/x";
		d.assets[0].cameraTrack = { ...d.assets[0].cameraTrack, sourcePath: "media/../../x" } as never;
		const folder = await craft("Evil2", [], d);
		const res = await open(folder);
		if (res.ok || res.reason !== "not-a-package") throw new Error("expected not-a-package");
		expect((res.detail ?? []).sort()).toEqual(["/etc/x", "media/../../x"]);
		expect(await receiveEntries()).toEqual([]);
		expect(registerMediaLinks).not.toHaveBeenCalled();
	});

	it("refuses an unsafe template folder name", async () => {
		const d = doc({ annotations: [annotation("n1", "user:../x")] });
		const folder = await craft("Evil3", [], d);
		expect(await open(folder)).toMatchObject({ ok: false, reason: "not-a-package" });
		expect(await receiveEntries()).toEqual([]);
	});

	it("keeps a derived ext: clip that is not in the package", async () => {
		const d = doc();
		d.assets.push({
			id: "ext:g1",
			kind: "video",
			label: "g",
			originalPath: "media/g1.mp4",
			cameraTrack: null,
		} as unknown as AxcutDocument["assets"][number]);
		const { zipPath } = await pack(d);
		const res = await open(zipPath);
		if (!res.ok) throw new Error("expected ok");
		expect(res.doc.assets[1].originalPath).toBe(path.join(res.folderPath, "media", "g1.mp4"));
		parseDocumentFile(res.doc);
	});
});
