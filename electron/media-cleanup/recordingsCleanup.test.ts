import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import {
	type AssetTrashDeps,
	type CleanupDeps,
	commitAssetTrash,
	prepareAssetTrash,
	sweepUnusedTakes,
	trashDeletedProject,
	unusedRecordingAssetIds,
} from "./recordingsCleanup";

let root: string;
let recordings: string;
let trashDir: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "rec-cleanup-"));
	recordings = path.join(root, "Movies", "Filmareto OpenScreen Beta");
	trashDir = path.join(root, "Trash");
	await fs.mkdir(recordings, { recursive: true });
	await fs.mkdir(trashDir, { recursive: true });
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** A take on disk as the recorder leaves it: screen, camera, cursor and session sidecars. */
async function take(stem: string, dir = recordings): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	const screen = path.join(dir, `${stem}.mp4`);
	for (const file of [screen, `${screen}.cursor.json`, path.join(dir, `${stem}-webcam.webm`)]) {
		await fs.writeFile(file, "x");
	}
	await fs.writeFile(
		path.join(dir, `${stem}.session.json`),
		JSON.stringify({
			screenVideoPath: screen,
			webcamVideoPath: path.join(dir, `${stem}-webcam.webm`),
		}),
	);
	return screen;
}

/**
 * A project of these takes, with clips for `clipsFor`. A take with no clip is one the user deleted
 * from the timeline (`discardedAt`), unless `unplaced` names it: then it only waits in the library.
 */
function project(
	id: string,
	screens: string[],
	clipsFor: string[] = screens,
	unplaced: string[] = [],
): AxcutDocument {
	const doc = createEmptyDocument({ projectId: id, title: `Project ${id}` });
	const assets = screens.map((screen, index) => ({
		...(clipsFor.includes(screen) || unplaced.includes(screen)
			? {}
			: { discardedAt: "2026-11-22T03:00:00.000Z" }),
		id: `asset_${id}_${index}`,
		kind: "video" as const,
		label: path.basename(screen),
		originalPath: screen,
		cameraTrack: {
			sourcePath: screen.replace(/\.mp4$/, "-webcam.webm"),
			startMs: 0,
			offsetMs: 0,
			visible: true,
		},
	}));
	const clips = clipsFor.map((screen, index) => ({
		id: `clip_${id}_${index}`,
		assetId: assets[screens.indexOf(screen)].id,
		sourceStartSec: 0,
		sourceEndSec: 5,
		timelineStartSec: index * 5,
		timelineEndSec: index * 5 + 5,
	}));
	return {
		...doc,
		assets,
		timeline: { ...doc.timeline, clips },
	} as unknown as AxcutDocument;
}

function deps(projects: AxcutDocument[], overrides: Partial<CleanupDeps> = {}): CleanupDeps {
	return {
		recordingsDir: recordings,
		readAllProjectFilesRaw: async () =>
			projects.map((doc) => ({
				filePath: path.join(root, "projects", `${doc.project.id}.openscreen`),
				raw: JSON.stringify(doc),
			})),
		trash: async (file) => {
			await fs.rename(file, path.join(trashDir, path.basename(file)));
		},
		log: () => {},
		...overrides,
	};
}

const exists = (file: string) =>
	fs.access(file).then(
		() => true,
		() => false,
	);

describe("trashDeletedProject", () => {
	it("sends the deleted project's takes and their sidecars to the Trash", async () => {
		const screen = await take("recording-100");
		const doc = project("a", [screen]);

		const result = await trashDeletedProject(deps([]), doc);

		expect(result.kept).toEqual([]);
		for (const name of [
			"recording-100.mp4",
			"recording-100.mp4.cursor.json",
			"recording-100-webcam.webm",
			"recording-100.session.json",
		]) {
			expect(await exists(path.join(recordings, name)), name).toBe(false);
			expect(await exists(path.join(trashDir, name)), name).toBe(true);
		}
	});

	it("keeps a take another project still uses, sidecars and camera included", async () => {
		const shared = await take("recording-200");
		const own = await take("recording-201");
		const deleted = project("a", [shared, own]);
		// The other project only names the screen video: its camera and sidecars are its too.
		const other = project("b", [shared]);
		other.assets[0].cameraTrack = null;

		await trashDeletedProject(deps([other]), deleted);

		for (const name of [
			"recording-200.mp4",
			"recording-200-webcam.webm",
			"recording-200.session.json",
		]) {
			expect(await exists(path.join(recordings, name)), name).toBe(true);
		}
		expect(await exists(path.join(recordings, "recording-201.mp4"))).toBe(false);
	});

	it("protects a path any other project mentions anywhere, not only as an asset", async () => {
		const screen = await take("recording-300");
		const deleted = project("a", [screen]);
		const other = {
			...project("b", []),
			notes: { attachment: screen },
		} as unknown as AxcutDocument;

		await trashDeletedProject(deps([other]), deleted);

		expect(await exists(screen)).toBe(true);
	});

	it("never touches a file outside the recordings folder, nor the package outbox", async () => {
		const imported = await take("recording-400", path.join(root, "Desktop"));
		const outbox = await take("recording-401", path.join(recordings, "Πακέτα", "Pack"));
		const doc = project("a", [imported, outbox]);

		await trashDeletedProject(deps([]), doc);

		expect(await exists(imported)).toBe(true);
		expect(await exists(outbox)).toBe(true);
	});

	// The recordings folder is the user's to choose: on the Desktop it holds their own files too.
	it("never touches a file the app did not make, even in the recordings folder", async () => {
		const own = path.join(recordings, "my-intro-music.wav");
		await fs.writeFile(own, "x");
		const doc = project("a", []);
		doc.assets.push({
			...doc.assets[0],
			id: "asset_own",
			kind: "audio",
			label: "own",
			originalPath: own,
			cameraTrack: null,
		} as never);
		(doc.assets as unknown[]).splice(0, doc.assets.length - 1);

		await trashDeletedProject(deps([]), doc);

		expect(await exists(own)).toBe(true);
	});

	it("sends what a received package brought to the Trash with its project", async () => {
		const received = await take(
			"recording-450",
			path.join(recordings, "Παραλαβές", "From Nektarios", "media"),
		);
		const doc = project("a", [received]);

		await trashDeletedProject(deps([]), doc);

		expect(await exists(received)).toBe(false);
	});

	it("trashes nothing when another project file cannot be read", async () => {
		const screen = await take("recording-500");
		const doc = project("a", [screen]);
		const broken = deps([], {
			readAllProjectFilesRaw: async () => [{ filePath: "/x/b.openscreen", raw: "{ not json" }],
		});

		const result = await trashDeletedProject(broken, doc);

		expect(await exists(screen)).toBe(true);
		expect(result.trashed).toEqual([]);
		expect(result.failedClosed).toBe(true);
	});

	it("reports a file it could not trash and goes on with the rest", async () => {
		const first = await take("recording-600");
		const second = await take("recording-601");
		const doc = project("a", [first, second]);
		const stubborn = deps([], {
			trash: async (file) => {
				if (file === first) throw new Error("locked");
				await fs.rename(file, path.join(trashDir, path.basename(file)));
			},
		});

		const result = await trashDeletedProject(stubborn, doc);

		expect(result.kept).toContain(first);
		expect(await exists(second)).toBe(false);
	});
});

describe("unusedRecordingAssetIds", () => {
	// The reviewer's case: a take in the media library, or a fresh take whose import stopped
	// before its clip was placed, is not on the timeline either. Neither was deleted.
	it("leaves a take that only waits in the media library", async () => {
		const placed = await take("recording-730");
		const waiting = await take("recording-731");
		const doc = project("a", [placed, waiting], [placed], [waiting]);

		expect(unusedRecordingAssetIds(doc, recordings)).toEqual([]);
	});

	it("names a recording no clip, take or audio track uses any more", async () => {
		const used = await take("recording-700");
		const dropped = await take("recording-701");
		const doc = project("a", [used, dropped], [used]);

		expect(unusedRecordingAssetIds(doc, recordings)).toEqual(["asset_a_1"]);
	});

	it("counts a take kept as another attempt of a clip as used", async () => {
		const shown = await take("recording-710");
		const attempt = await take("recording-711");
		const doc = project("a", [shown, attempt], [shown]);
		(doc.timeline.clips[0] as { alternates?: unknown[] }).alternates = [
			{ assetId: "asset_a_1", sourceStartSec: 0, sourceEndSec: 3 },
		];

		expect(unusedRecordingAssetIds(doc, recordings)).toEqual([]);
	});

	it("leaves media imported from elsewhere alone", async () => {
		const imported = await take("recording-720", path.join(root, "Desktop"));
		const doc = project("a", [imported], []);

		expect(unusedRecordingAssetIds(doc, recordings)).toEqual([]);
	});
});

describe("sweepUnusedTakes", () => {
	it("takes an unused take out of its project and sends its files to the Trash", async () => {
		const used = await take("recording-800");
		const dropped = await take("recording-801");
		const doc = project("a", [used, dropped], [used]);
		const saved: AxcutDocument[] = [];

		const result = await sweepUnusedTakes({
			...deps([doc]),
			listProjects: async () => [doc],
			projectOpenInEditor: async () => null,
			saveIfUnchanged: async (next) => {
				saved.push(next);
				return true;
			},
		});

		expect(saved).toHaveLength(1);
		expect(saved[0].assets.map((asset) => asset.id)).toEqual(["asset_a_0"]);
		expect(await exists(dropped)).toBe(false);
		expect(await exists(path.join(recordings, "recording-801-webcam.webm"))).toBe(false);
		expect(await exists(used)).toBe(true);
		expect(result.trashed.length).toBeGreaterThan(0);
	});

	// A cleanup is not an edit: the project list is ordered by `updatedAt`, and the editor opens
	// the first one.
	it("keeps the project's place in the list, and reads the project files once", async () => {
		const used = await take("recording-840");
		const dropped = await take("recording-841");
		const doc = project("a", [used, dropped], [used]);
		const other = project("b", [used]);
		const saved: AxcutDocument[] = [];
		let reads = 0;
		const base = deps([doc, other]);

		await sweepUnusedTakes({
			...base,
			readAllProjectFilesRaw: async () => {
				reads += 1;
				return base.readAllProjectFilesRaw();
			},
			listProjects: async () => [doc, other],
			projectOpenInEditor: async () => null,
			saveIfUnchanged: async (next) => {
				saved.push(next);
				return true;
			},
		});

		expect(saved[0].project.updatedAt).toBe(doc.project.updatedAt);
		expect(reads).toBe(1);
	});

	it("leaves the project open in an editor alone", async () => {
		const dropped = await take("recording-810");
		const doc = project("a", [dropped], []);

		await sweepUnusedTakes({
			...deps([doc]),
			listProjects: async () => [doc],
			projectOpenInEditor: async () => "a",
			saveIfUnchanged: async () => true,
		});

		expect(await exists(dropped)).toBe(true);
	});

	it("trashes nothing for a project whose save lost a race", async () => {
		const dropped = await take("recording-820");
		const doc = project("a", [dropped], []);

		await sweepUnusedTakes({
			...deps([doc]),
			listProjects: async () => [doc],
			projectOpenInEditor: async () => null,
			saveIfUnchanged: async () => false,
		});

		expect(await exists(dropped)).toBe(true);
	});

	it("keeps an unused take another project still uses", async () => {
		const shared = await take("recording-830");
		const doc = project("a", [shared], []);
		const other = project("b", [shared]);

		await sweepUnusedTakes({
			...deps([doc, other]),
			listProjects: async () => [doc, other],
			projectOpenInEditor: async () => null,
			saveIfUnchanged: async () => true,
		});

		expect(await exists(shared)).toBe(true);
	});
});

describe("deleting a media item from disk (prepare, then commit)", () => {
	/** `saved` is what main's store holds for each project; the commit re-reads it. */
	function assetDeps(saved: Map<string, AxcutDocument>, trashed: string[] = []): AssetTrashDeps {
		const base = deps([...saved.values()]);
		return {
			...base,
			readAllProjectFilesRaw: async () =>
				[...saved.values()].map((doc) => ({
					filePath: path.join(root, "projects", `${doc.project.id}.openscreen`),
					raw: JSON.stringify(doc),
				})),
			trash: async (file) => {
				trashed.push(path.basename(file));
				await base.trash(file);
			},
			getProject: async (id) => {
				const doc = saved.get(id);
				if (!doc) throw new Error("no such project");
				return doc;
			},
			approvedPath: (file) => (/\.(mp4|webm|mov)$/.test(file) ? file : null),
		};
	}

	/** The project after the renderer removed the asset and saved. */
	const without = (doc: AxcutDocument, assetId: string): AxcutDocument =>
		({ ...doc, assets: doc.assets.filter((a) => a.id !== assetId) }) as AxcutDocument;

	it("sends a take and its sidecars to the Trash once the asset left the saved project", async () => {
		const screen = await take("recording-300");
		await fs.writeFile(path.join(recordings, "recording-300.mic.wav"), "x");
		const doc = project("a", [screen]);
		const saved = new Map([["a", doc]]);
		const trashed: string[] = [];
		const d = assetDeps(saved, trashed);

		const prepared = await prepareAssetTrash(d, "a", doc.assets[0].id);
		expect(prepared?.files.map((f) => path.basename(f)).sort()).toEqual(
			[
				"recording-300.mp4",
				"recording-300.mp4.cursor.json",
				"recording-300-webcam.webm",
				"recording-300.session.json",
				"recording-300.mic.wav",
			].sort(),
		);

		saved.set("a", without(doc, doc.assets[0].id));
		const result = await commitAssetTrash(d, prepared?.token ?? "");

		expect(result.shared).toBe(false);
		expect(trashed.sort()).toEqual(prepared?.files.map((f) => path.basename(f)).sort());
		expect(await exists(screen)).toBe(false);
	});

	it("refuses a commit before the asset has left the saved project", async () => {
		const screen = await take("recording-301");
		const doc = project("a", [screen]);
		const trashed: string[] = [];
		const d = assetDeps(new Map([["a", doc]]), trashed);
		const prepared = await prepareAssetTrash(d, "a", doc.assets[0].id);

		const result = await commitAssetTrash(d, prepared?.token ?? "");

		expect(result.refused).toBe(true);
		expect(trashed).toEqual([]);
		expect(await exists(screen)).toBe(true);
	});

	it("refuses a token it never issued, and a token used twice", async () => {
		const screen = await take("recording-302");
		const doc = project("a", [screen]);
		const saved = new Map([["a", doc]]);
		const d = assetDeps(saved);
		expect((await commitAssetTrash(d, "/etc/hosts")).refused).toBe(true);
		const prepared = await prepareAssetTrash(d, "a", doc.assets[0].id);
		saved.set("a", without(doc, doc.assets[0].id));
		await commitAssetTrash(d, prepared?.token ?? "");
		expect((await commitAssetTrash(d, prepared?.token ?? "")).refused).toBe(true);
	});

	it("prepares nothing for an asset the project does not have, or for another project's", async () => {
		const screen = await take("recording-303");
		const mine = project("a", [screen]);
		const theirs = project("b", [await take("recording-304")]);
		const d = assetDeps(
			new Map([
				["a", mine],
				["b", theirs],
			]),
		);
		expect(await prepareAssetTrash(d, "a", "not-an-asset")).toBeNull();
		expect(await prepareAssetTrash(d, "a", theirs.assets[0].id)).toBeNull();
		expect(await prepareAssetTrash(d, "nope", mine.assets[0].id)).toBeNull();
	});

	it("refuses a path that is not a regular media file: a folder, a link, an unapproved type", async () => {
		const folder = path.join(root, "Desktop", "clip.mp4");
		await fs.mkdir(folder, { recursive: true });
		const target = path.join(root, "Desktop", "real.mp4");
		await fs.writeFile(target, "x");
		const link = path.join(root, "Desktop", "link.mp4");
		await fs.symlink(target, link);
		const text = path.join(root, "Desktop", "notes.txt");
		await fs.writeFile(text, "x");
		const doc = project("a", [folder, link, text]);
		for (const asset of doc.assets) asset.cameraTrack = null;
		const d = assetDeps(new Map([["a", doc]]));

		for (const asset of doc.assets) {
			expect(await prepareAssetTrash(d, "a", asset.id), asset.originalPath).toBeNull();
		}
		expect(await exists(target)).toBe(true);
	});

	it("does not trash a file another project still uses", async () => {
		const screen = await take("recording-305");
		const mine = project("a", [screen]);
		const other = project("b", [screen]);
		const saved = new Map([
			["a", mine],
			["b", other],
		]);
		const trashed: string[] = [];
		const d = assetDeps(saved, trashed);
		const prepared = await prepareAssetTrash(d, "a", mine.assets[0].id);
		saved.set("a", without(mine, mine.assets[0].id));

		const result = await commitAssetTrash(d, prepared?.token ?? "");

		expect(result.shared).toBe(true);
		expect(trashed).toEqual([]);
		expect(await exists(screen)).toBe(true);
	});

	it("does not trash a file this project still uses through another asset", async () => {
		const screen = await take("recording-306");
		const doc = project("a", [screen, screen]);
		const saved = new Map([["a", doc]]);
		const d = assetDeps(saved);
		const prepared = await prepareAssetTrash(d, "a", doc.assets[0].id);
		saved.set("a", without(doc, doc.assets[0].id));
		expect((await commitAssetTrash(d, prepared?.token ?? "")).shared).toBe(true);
		expect(await exists(screen)).toBe(true);
	});

	it("moves exactly the named file when the app did not make it, and no neighbour", async () => {
		const dir = path.join(root, "Desktop");
		await fs.mkdir(dir, { recursive: true });
		const named = path.join(dir, "interview.mp4");
		const neighbours = ["interview-webcam.mp4", "interview.mic.wav", "interview.mp4.cursor.json"];
		await fs.writeFile(named, "x");
		for (const name of neighbours) await fs.writeFile(path.join(dir, name), "x");
		const doc = project("a", [named]);
		doc.assets[0].cameraTrack = null;
		const saved = new Map([["a", doc]]);
		const trashed: string[] = [];
		const d = assetDeps(saved, trashed);

		const prepared = await prepareAssetTrash(d, "a", doc.assets[0].id);
		expect(prepared?.files).toEqual([named]);
		saved.set("a", without(doc, doc.assets[0].id));
		await commitAssetTrash(d, prepared?.token ?? "");

		expect(trashed).toEqual(["interview.mp4"]);
		for (const name of neighbours) expect(await exists(path.join(dir, name)), name).toBe(true);
	});

	it("moves nothing when a project file cannot be read", async () => {
		const screen = await take("recording-307");
		const doc = project("a", [screen]);
		const saved = new Map([["a", doc]]);
		const d = assetDeps(saved);
		const prepared = await prepareAssetTrash(d, "a", doc.assets[0].id);
		saved.set("a", without(doc, doc.assets[0].id));
		const result = await commitAssetTrash(
			{
				...d,
				readAllProjectFilesRaw: async () => {
					throw new Error("unreadable");
				},
			},
			prepared?.token ?? "",
		);
		expect(result.failedClosed).toBe(true);
		expect(await exists(screen)).toBe(true);
	});
});
