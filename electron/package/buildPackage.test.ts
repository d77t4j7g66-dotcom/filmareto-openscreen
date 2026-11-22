import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	createEmptyDocument,
	parseDocumentFile,
} from "../../src/lib/ai-edition/schema";
import { buildEditorPackage, type PackageProgress } from "./buildPackage";
import { parsePackageManifest } from "./manifest";

let root = "";
let src = "";
let out = "";
let templates = "";
const NOW = new Date("2026-11-20T10:00:00Z");

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "build-package-"));
	src = path.join(root, "src");
	out = path.join(root, "out");
	templates = path.join(root, "templates");
	await fs.mkdir(src, { recursive: true });
	await fs.mkdir(out, { recursive: true });
	await fs.mkdir(templates, { recursive: true });
	await fs.writeFile(path.join(src, "rec.mp4"), randomBytes(1024 * 1024));
	await fs.writeFile(path.join(src, "rec.mp4.cursor.json"), '{"c":1}');
	await fs.writeFile(path.join(src, "rec.session.json"), '{"s":1}');
	await fs.writeFile(path.join(src, "rec-webcam.webm"), randomBytes(2048));
});

afterEach(async () => {
	await fs.chmod(path.join(src, "rec-webcam.webm"), 0o644).catch(() => undefined);
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

const input = (d: AxcutDocument, more: Record<string, unknown> = {}) => ({
	doc: d,
	outRoot: out,
	appVersion: "1.1.0",
	now: NOW,
	...more,
});

async function walk(dir: string): Promise<string[]> {
	const names: string[] = [];
	for (const e of await fs.readdir(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) names.push(...(await walk(p)));
		else names.push(p);
	}
	return names;
}

describe("buildEditorPackage", () => {
	it("writes the folder, project, manifest, media and a zip", async () => {
		const res = await buildEditorPackage(input(doc()));
		if (!res.ok) throw new Error("expected ok");
		expect(path.basename(res.folderPath)).toBe("2026-11-20 My Film");
		expect(res.zipPath).toBe(`${res.folderPath}.zip`);
		await fs.stat(res.zipPath);
		const names = (await fs.readdir(res.folderPath)).sort();
		expect(names).toEqual(["filmareto-package.json", "media", "project.openscreen"]);
		for (const f of ["rec.mp4", "rec.mp4.cursor.json", "rec.session.json", "rec-webcam.webm"]) {
			const a = await fs.readFile(path.join(src, f));
			const b = await fs.readFile(path.join(res.folderPath, "media", f));
			expect(b.equals(a)).toBe(true);
		}
		expect((await fs.readdir(out)).sort()).toEqual([
			"2026-11-20 My Film",
			"2026-11-20 My Film.zip",
		]);
	});

	it("rewrites the project to relative package paths", async () => {
		const res = await buildEditorPackage(input(doc()));
		if (!res.ok) throw new Error("expected ok");
		const parsed = parseDocumentFile(
			JSON.parse(await fs.readFile(path.join(res.folderPath, "project.openscreen"), "utf8")),
		);
		expect(parsed.assets[0].originalPath).toBe("media/rec.mp4");
		expect(parsed.assets[0].cameraTrack?.sourcePath).toBe("media/rec-webcam.webm");
	});

	it("lists every copied file with its size in the manifest", async () => {
		const res = await buildEditorPackage(input(doc()));
		if (!res.ok) throw new Error("expected ok");
		const manifest = parsePackageManifest(
			await fs.readFile(path.join(res.folderPath, "filmareto-package.json"), "utf8"),
		);
		expect(manifest?.projectId).toBe("p1");
		expect(manifest?.title).toBe("My Film");
		expect(manifest?.appVersion).toBe("1.1.0");
		expect(manifest?.files.map((f) => f.path).sort()).toEqual([
			"media/rec-webcam.webm",
			"media/rec.mp4",
			"media/rec.mp4.cursor.json",
			"media/rec.session.json",
		]);
		const video = manifest?.files.find((f) => f.path === "media/rec.mp4");
		expect(video?.sizeBytes).toBe(1024 * 1024);
		expect(res.totalBytes).toBe((manifest?.files ?? []).reduce((sum, f) => sum + f.sizeBytes, 0));
	});

	it("reports missing required files and leaves nothing behind", async () => {
		await fs.rm(path.join(src, "rec-webcam.webm"));
		const res = await buildEditorPackage(input(doc()));
		expect(res).toEqual({ ok: false, reason: "missing-files", missing: ["rec-webcam.webm"] });
		expect(await fs.readdir(out)).toEqual([]);
	});

	it("skips missing optional sidecars", async () => {
		await fs.rm(path.join(src, "rec.mp4.cursor.json"));
		await fs.rm(path.join(src, "rec.session.json"));
		const res = await buildEditorPackage(input(doc()));
		if (!res.ok) throw new Error("expected ok");
		expect((await fs.readdir(path.join(res.folderPath, "media"))).sort()).toEqual([
			"rec-webcam.webm",
			"rec.mp4",
		]);
	});

	it("drops a missing optional proxy from the project instead of pointing at nothing", async () => {
		const d = doc();
		d.assets[0].proxyPath = path.join(src, "gone-proxy.mp4");
		const res = await buildEditorPackage(input(d));
		if (!res.ok) throw new Error("expected ok");
		const parsed = parseDocumentFile(
			JSON.parse(await fs.readFile(path.join(res.folderPath, "project.openscreen"), "utf8")),
		);
		expect(parsed.assets[0].proxyPath).toBeUndefined();
	});

	it("reports non-decreasing progress ending at the total", async () => {
		const seen: PackageProgress[] = [];
		const res = await buildEditorPackage(
			input(doc(), { onProgress: (p: PackageProgress) => seen.push(p) }),
		);
		if (!res.ok) throw new Error("expected ok");
		expect(seen.length).toBeGreaterThan(0);
		for (let i = 1; i < seen.length; i++) {
			expect(seen[i].copiedBytes).toBeGreaterThanOrEqual(seen[i - 1].copiedBytes);
		}
		const last = seen[seen.length - 1];
		expect(last.copiedBytes).toBe(last.totalBytes);
		expect(last.totalBytes).toBe(res.totalBytes);
	});

	it("leaves the original files untouched", async () => {
		const files = await walk(src);
		const before = await Promise.all(files.map(async (f) => (await fs.stat(f)).mtimeMs));
		await buildEditorPackage(input(doc()));
		const after = await Promise.all(files.map(async (f) => (await fs.stat(f)).mtimeMs));
		expect(after).toEqual(before);
	});

	it("never packs a user graphics template, only its frames", async () => {
		await fs.mkdir(path.join(templates, "lower", "sub"), { recursive: true });
		await fs.writeFile(path.join(templates, "lower", "index.html"), "<script>x</script>");
		const d = doc({
			annotations: [
				{
					id: "n1",
					graphicData: { templateId: "user:lower", frames: [] },
				},
			],
		});
		const res = await buildEditorPackage(input(d));
		if (!res.ok) throw new Error("expected ok");
		expect(await fs.readdir(res.folderPath)).not.toContain("graphics-templates");
		const manifest = parsePackageManifest(
			await fs.readFile(path.join(res.folderPath, "filmareto-package.json"), "utf8"),
		);
		expect(manifest?.files.some((f) => f.path.startsWith("graphics-templates"))).toBe(false);
	});

	it("uses (2) when the same project is packed twice", async () => {
		const first = await buildEditorPackage(input(doc()));
		const second = await buildEditorPackage(input(doc()));
		if (!first.ok || !second.ok) throw new Error("expected ok");
		expect(path.basename(second.folderPath)).toBe("2026-11-20 My Film (2)");
		expect(second.zipPath).toBe(`${second.folderPath}.zip`);
		await fs.stat(second.zipPath);
		const third = await buildEditorPackage(input(doc()));
		if (!third.ok) throw new Error("expected ok");
		expect(path.basename(third.folderPath)).toBe("2026-11-20 My Film (3)");
		expect((await fs.readdir(out)).filter((n) => n.startsWith(".partial"))).toEqual([]);
	});

	it("refuses an unsafe package path and writes nothing", async () => {
		const d = doc({
			annotations: [
				{
					id: "n1",
					graphicData: {
						templateId: "builtin:x",
						frames: [{ path: "/a/../f1.png" }],
					},
				},
			],
		});
		const res = await buildEditorPackage(input(d));
		expect(res.ok).toBe(false);
		if (res.ok || res.reason !== "unsafe-path") throw new Error("expected unsafe-path");
		expect(res.paths).toEqual(["graphics-cache/../f1.png"]);
		expect(await fs.readdir(out)).toEqual([]);
	});

	it("keeps the package path of a missing generated asset and writes no sentinel", async () => {
		const d = doc();
		d.assets.push({
			id: "ext:gen1",
			kind: "video",
			label: "gen",
			originalPath: path.join(src, "gen1.mp4"),
			cameraTrack: null,
		} as unknown as AxcutDocument["assets"][number]);
		const res = await buildEditorPackage(input(d));
		if (!res.ok) throw new Error("expected ok");
		const raw = await fs.readFile(path.join(res.folderPath, "project.openscreen"), "utf8");
		const parsed = parseDocumentFile(JSON.parse(raw));
		expect(parsed.assets[1].originalPath).toBe("media/gen1.mp4");
		expect(raw).not.toContain("\\u0000");
		expect(raw).not.toContain(src);
	});

	it("leaves nothing in outRoot when a copy fails", async () => {
		await fs.chmod(path.join(src, "rec-webcam.webm"), 0o000);
		await expect(buildEditorPackage(input(doc()))).rejects.toThrow();
		expect(await fs.readdir(out)).toEqual([]);
	});
});
