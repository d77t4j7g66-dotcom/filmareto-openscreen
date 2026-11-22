import path from "node:path";
import { describe, expect, it } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "../../src/lib/ai-edition/schema";
import {
	collectPackageRefs,
	type PackageRef,
	packageFolderName,
	rewriteDocumentPaths,
	sessionManifestPathForVideo,
} from "./packageReferences";

function emptyDoc(): AxcutDocument {
	return createEmptyDocument({
		title: "T",
		projectId: "p1",
		createdAt: "2026-01-01T00:00:00.000Z",
	} as Parameters<typeof createEmptyDocument>[0]);
}

function video(id: string, originalPath: string, extra: Record<string, unknown> = {}) {
	return { id, kind: "video", label: id, originalPath, cameraTrack: null, ...extra };
}

function withAssets(assets: unknown[]): AxcutDocument {
	return { ...emptyDoc(), assets } as unknown as AxcutDocument;
}

function find(refs: PackageRef[], sourcePath: string) {
	return refs.find((r) => r.sourcePath === sourcePath);
}

describe("sessionManifestPathForVideo", () => {
	it("strips -webcam and swaps the extension for .session.json", () => {
		expect(sessionManifestPathForVideo("/a/rec-1.mp4")).toBe("/a/rec-1.session.json");
		expect(sessionManifestPathForVideo("/a/rec-1-webcam.webm")).toBe("/a/rec-1.session.json");
	});
});

describe("collectPackageRefs", () => {
	it("lists originalPath and camera as required media", () => {
		const doc = withAssets([
			video("a1", "/v/rec.mp4", {
				cameraTrack: { sourcePath: "/v/rec-webcam.mp4", startMs: 0, offsetMs: 0, visible: true },
			}),
		]);
		const refs = collectPackageRefs(doc);
		expect(find(refs, "/v/rec.mp4")).toEqual({
			sourcePath: "/v/rec.mp4",
			packagePath: "media/rec.mp4",
			kind: "asset",
			required: true,
		});
		expect(find(refs, "/v/rec-webcam.mp4")).toEqual({
			sourcePath: "/v/rec-webcam.mp4",
			packagePath: "media/rec-webcam.mp4",
			kind: "camera",
			required: true,
		});
	});

	it("lists cursor and session sidecars of video assets as optional", () => {
		const doc = withAssets([video("a1", "/v/rec.mp4")]);
		const refs = collectPackageRefs(doc);
		expect(find(refs, "/v/rec.mp4.cursor.json")).toEqual({
			sourcePath: "/v/rec.mp4.cursor.json",
			packagePath: "media/rec.mp4.cursor.json",
			kind: "cursor",
			required: false,
		});
		expect(find(refs, "/v/rec.session.json")).toEqual({
			sourcePath: "/v/rec.session.json",
			packagePath: "media/rec.session.json",
			kind: "session",
			required: false,
		});
	});

	it("gives audio assets no sidecars", () => {
		const doc = withAssets([{ ...video("s", "/v/vo.wav"), kind: "audio" }]);
		const refs = collectPackageRefs(doc);
		expect(refs).toHaveLength(1);
		expect(refs[0].kind).toBe("asset");
	});

	it("lists proxy, waveform, transcript paths and ext: clips as optional derived", () => {
		const doc = {
			...withAssets([
				video("a1", "/v/rec.mp4", { proxyPath: "/v/p.mp4", waveformPath: "/v/w.json" }),
				video("ext:gen1", "/v/.openscreen-extensions/gen.mp4"),
			]),
			transcripts: [
				{
					assetId: "a1",
					language: "en",
					sourceDslPath: "/v/t.dsl",
					sourceJsonPath: "/v/t.json",
					segments: [],
					words: [],
				},
			],
		} as unknown as AxcutDocument;
		const refs = collectPackageRefs(doc);
		for (const p of [
			"/v/p.mp4",
			"/v/w.json",
			"/v/t.dsl",
			"/v/t.json",
			"/v/.openscreen-extensions/gen.mp4",
		]) {
			expect(find(refs, p)).toMatchObject({ kind: "derived", required: false });
		}
		expect(find(refs, "/v/.openscreen-extensions/gen.mp4")?.packagePath).toBe("media/gen.mp4");
	});

	it("maps graphic frames and never maps a user template", () => {
		const doc = {
			...emptyDoc(),
			annotations: [
				{
					graphicData: {
						graphicId: "g",
						templateId: "user:lower-third",
						name: "n",
						fields: [],
						frames: [
							{ path: "/u/graphics-cache/abc123/f00001.png", atMs: 0 },
							{ path: "/u/graphics-cache/abc123/f00002.png", atMs: 40 },
						],
						durationMs: 1000,
						holdMs: 0,
					},
				},
				{
					graphicData: {
						graphicId: "h",
						templateId: "builtin:title",
						name: "n",
						fields: [],
						frames: [],
						durationMs: 1000,
						holdMs: 0,
					},
				},
			],
		} as unknown as AxcutDocument;
		const refs = collectPackageRefs(doc);
		expect(find(refs, "/u/graphics-cache/abc123/f00001.png")).toEqual({
			sourcePath: "/u/graphics-cache/abc123/f00001.png",
			packagePath: "graphics-cache/abc123/f00001.png",
			kind: "graphic-frame",
			required: true,
		});
		expect(refs.some((r) => r.packagePath.startsWith("graphics-templates"))).toBe(false);
	});

	it("gives a file referenced twice one ref", () => {
		const doc = withAssets([video("a1", "/v/rec.mp4"), video("a2", "/v/rec.mp4")]);
		const refs = collectPackageRefs(doc);
		expect(refs.filter((r) => r.sourcePath === "/v/rec.mp4")).toHaveLength(1);
		expect(refs.filter((r) => r.kind === "cursor")).toHaveLength(1);
	});

	it("disambiguates same basenames and carries sidecars to the final name", () => {
		const doc = withAssets([video("a1", "/x/rec.mp4"), video("a2", "/y/rec.mp4")]);
		const refs = collectPackageRefs(doc);
		expect(find(refs, "/x/rec.mp4")?.packagePath).toBe("media/rec.mp4");
		expect(find(refs, "/y/rec.mp4")?.packagePath).toBe("media/2-rec.mp4");
		expect(find(refs, "/y/rec.mp4.cursor.json")?.packagePath).toBe("media/2-rec.mp4.cursor.json");
		expect(find(refs, "/y/rec.session.json")?.packagePath).toBe("media/2-rec.session.json");
		const paths = refs.map((r) => r.packagePath);
		expect(new Set(paths).size).toBe(paths.length);
	});

	it("keeps required when a file is both required and optional", () => {
		const doc = withAssets([video("a1", "/v/rec.mp4", { proxyPath: "/v/rec.mp4" })]);
		const refs = collectPackageRefs(doc);
		expect(find(refs, "/v/rec.mp4")).toMatchObject({ kind: "asset", required: true });
	});
});

describe("package path rules", () => {
	const unique = (refs: PackageRef[]) => {
		const keys = refs.map((r) => r.packagePath.normalize("NFC").toLowerCase());
		expect(new Set(keys).size).toBe(keys.length);
	};

	it("keeps session manifests of different videos apart (different extension)", () => {
		const refs = collectPackageRefs(
			withAssets([video("a1", "/x/rec.mp4"), video("a2", "/y/rec.mov")]),
		);
		unique(refs);
		expect(find(refs, "/y/rec.session.json")?.packagePath).toBe("media/2-rec.session.json");
		expect(find(refs, "/y/rec.mov")?.packagePath).toBe("media/2-rec.mov");
	});

	it("keeps session manifests apart when one video is a -webcam file", () => {
		const refs = collectPackageRefs(
			withAssets([video("a1", "/x/rec.mp4"), video("a2", "/y/rec-webcam.mp4")]),
		);
		unique(refs);
		expect(find(refs, "/y/rec.session.json")?.packagePath).toBe("media/2-rec.session.json");
	});

	it("shares one session manifest between a screen video and its webcam video", () => {
		const refs = collectPackageRefs(
			withAssets([video("a1", "/x/rec.mp4"), video("a2", "/x/rec-webcam.mp4")]),
		);
		unique(refs);
		expect(refs.filter((r) => r.kind === "session")).toHaveLength(1);
	});

	const pairingHolds = (refs: PackageRef[]) => {
		for (const r of refs.filter((x) => x.kind === "asset" && x.packagePath.endsWith(".mp4"))) {
			const own = path.posix.join(
				path.posix.dirname(r.packagePath),
				`${path.posix.parse(r.packagePath).name.replace(/-webcam$/, "")}.session.json`,
			);
			expect(refs.some((x) => x.kind === "session" && x.packagePath === own)).toBe(true);
		}
	};

	it("gives a webcam video the prefix of its screen video (screen first)", () => {
		const refs = collectPackageRefs(
			withAssets([
				video("a1", "/x/rec.mp4"),
				video("a2", "/y/rec.mp4"),
				video("a3", "/y/rec-webcam.mp4"),
			]),
		);
		unique(refs);
		expect(find(refs, "/y/rec-webcam.mp4")?.packagePath).toBe("media/2-rec-webcam.mp4");
		expect(find(refs, "/y/rec.session.json")?.packagePath).toBe("media/2-rec.session.json");
		pairingHolds(refs);
	});

	it("gives a screen video the prefix of its webcam video (webcam first)", () => {
		const refs = collectPackageRefs(
			withAssets([
				video("a1", "/x/rec-webcam.mp4"),
				video("a2", "/y/rec-webcam.mp4"),
				video("a3", "/y/rec.mp4"),
			]),
		);
		unique(refs);
		expect(find(refs, "/y/rec.mp4")?.packagePath).toBe("media/2-rec.mp4");
		pairingHolds(refs);
	});

	it("treats names differing only in case as a clash", () => {
		const refs = collectPackageRefs(
			withAssets([video("a1", "/x/Rec.mp4"), video("a2", "/y/rec.mp4")]),
		);
		unique(refs);
		expect(find(refs, "/y/rec.mp4")?.packagePath).toBe("media/2-rec.mp4");
	});

	it("treats NFC and NFD names as a clash", () => {
		const nfc = "/x/\u03ac.mp4";
		const nfd = "/y/\u03b1\u0301.mp4";
		const refs = collectPackageRefs(withAssets([video("a1", nfc), video("a2", nfd)]));
		unique(refs);
		expect(find(refs, nfd)?.packagePath.startsWith("media/2-")).toBe(true);
	});

	it("never emits a backslash in a package path", () => {
		const refs = collectPackageRefs(
			withAssets([video("a1", "/x/we\\ird.mp4"), video("a2", "/y/rec.mp4")]),
		);
		expect(refs.length).toBeGreaterThan(0);
		for (const r of refs) expect(r.packagePath).not.toContain("\\");
	});

	it("emits no ref for a user template, whatever its folder", () => {
		const doc = (templateId: string) =>
			({
				...emptyDoc(),
				annotations: [
					{
						graphicData: {
							graphicId: "g",
							templateId,
							name: "n",
							fields: [],
							frames: [],
							durationMs: 1,
							holdMs: 0,
						},
					},
				],
			}) as unknown as AxcutDocument;
		for (const id of ["user:../../x", "user:a/b", "user:", "user:ok"]) {
			expect(collectPackageRefs(doc(id))).toEqual([]);
		}
	});

	it("gives an ext: video no cursor or session refs", () => {
		const refs = collectPackageRefs(
			withAssets([video("ext:g1", "/v/.openscreen-extensions/gen.mp4")]),
		);
		expect(refs).toHaveLength(1);
		expect(refs[0]).toMatchObject({ kind: "derived", required: false });
	});

	it("collects the singular transcript's paths", () => {
		const doc = {
			...emptyDoc(),
			transcript: {
				assetId: "a1",
				language: "en",
				sourceDslPath: "/v/s.dsl",
				sourceJsonPath: "/v/s.json",
				segments: [],
				words: [],
			},
		} as unknown as AxcutDocument;
		const refs = collectPackageRefs(doc);
		expect(find(refs, "/v/s.dsl")).toMatchObject({ kind: "derived", required: false });
		expect(find(refs, "/v/s.json")).toMatchObject({ kind: "derived", required: false });
	});
});

describe("rewriteDocumentPaths", () => {
	it("rewrites the singular transcript's paths", () => {
		const doc = {
			...emptyDoc(),
			transcript: {
				assetId: "a1",
				language: "en",
				sourceDslPath: "/v/s.dsl",
				sourceJsonPath: "/v/s.json",
				segments: [],
				words: [],
			},
		} as unknown as AxcutDocument;
		const out = rewriteDocumentPaths(doc, (p) => `PKG${p}`);
		expect(out.transcript?.sourceDslPath).toBe("PKG/v/s.dsl");
		expect(out.transcript?.sourceJsonPath).toBe("PKG/v/s.json");
		expect(doc.transcript?.sourceDslPath).toBe("/v/s.dsl");
	});

	function fullDoc(): AxcutDocument {
		return {
			...withAssets([
				video("a1", "/v/rec.mp4", {
					proxyPath: "/v/p.mp4",
					waveformPath: "/v/w.json",
					cameraTrack: { sourcePath: "/v/cam.mp4", startMs: 0, offsetMs: 0, visible: true },
				}),
			]),
			transcripts: [
				{
					assetId: "a1",
					language: "en",
					sourceDslPath: "/v/t.dsl",
					sourceJsonPath: "/v/t.json",
					segments: [],
					words: [],
				},
			],
			annotations: [
				{
					graphicData: {
						graphicId: "g",
						templateId: "user:x",
						name: "n",
						fields: [],
						frames: [{ path: "/u/graphics-cache/s/f1.png", atMs: 0 }],
						durationMs: 1,
						holdMs: 0,
					},
				},
			],
		} as unknown as AxcutDocument;
	}

	it("round-trips through a map and its inverse without touching the input", () => {
		const doc = fullDoc();
		const snapshot = structuredClone(doc);
		const out = rewriteDocumentPaths(doc, (p) => `PKG${p}`);
		expect(doc).toEqual(snapshot);
		expect(out).not.toBe(doc);
		const asset = out.assets[0];
		expect(asset.originalPath).toBe("PKG/v/rec.mp4");
		expect(asset.cameraTrack?.sourcePath).toBe("PKG/v/cam.mp4");
		expect(asset.proxyPath).toBe("PKG/v/p.mp4");
		expect(asset.waveformPath).toBe("PKG/v/w.json");
		expect(out.transcripts[0].sourceDslPath).toBe("PKG/v/t.dsl");
		expect(out.transcripts[0].sourceJsonPath).toBe("PKG/v/t.json");
		expect(out.annotations[0].graphicData?.frames[0].path).toBe("PKG/u/graphics-cache/s/f1.png");
		expect(rewriteDocumentPaths(out, (p) => p.slice(3))).toEqual(doc);
	});
});

describe("packageFolderName", () => {
	const date = new Date(2026, 10, 20, 12, 0, 0);

	it("builds a dated, filename-safe name", () => {
		expect(packageFolderName("Tutorial 6: Premiere/Resolve 🔥", date)).toBe(
			"2026-11-20 Tutorial 6 - Premiere-Resolve 🔥",
		);
	});

	it("keeps Greek", () => {
		expect(packageFolderName("Εκπαίδευση Κοσμοντάτα", date)).toBe(
			"2026-11-20 Εκπαίδευση Κοσμοντάτα",
		);
	});

	it("is at most 80 characters and never holds / : or backslash", () => {
		const name = packageFolderName(`${"a/b:c\\d ".repeat(30)}`, date);
		expect(name.length).toBeLessThanOrEqual(80);
		expect(name).not.toMatch(/[/:\\]/);
	});

	it("uses the local date, not UTC, around local midnight", () => {
		expect(packageFolderName("T", new Date(2026, 10, 20, 0, 5, 0))).toBe("2026-11-20 T");
		expect(packageFolderName("T", new Date(2026, 10, 20, 23, 55, 0))).toBe("2026-11-20 T");
		expect(packageFolderName("T", new Date(2026, 0, 5, 23, 59, 59))).toBe("2026-01-05 T");
	});

	it("falls back for an empty title", () => {
		expect(packageFolderName("  ", date)).toBe("2026-11-20 Untitled");
	});
});
