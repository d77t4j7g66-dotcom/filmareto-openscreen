import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { usedAssetIds } from "../../src/lib/ai-edition/document/discardedTakes";
import {
	type AxcutAsset,
	type AxcutDocument,
	createEmptyDocument,
} from "../../src/lib/ai-edition/schema";
import { documentWithoutAsset } from "../ai-edition/document-service";
import { collectPackageRefs } from "../package/packageReferences";
/**
 * Recordings leave the disk with their project (docs/superpowers/specs/2026-11-22-recordings-
 * cleanup-design.md). Deleting a project sends its takes to the Trash at once, and a take the user
 * deleted from the timeline goes there at the next start. The Trash is the undo: Put Back.
 *
 * Protect wide, delete narrow. A file goes only when the app made it (a take and its sidecars, a
 * voiceover, what a received package brought) inside the recordings folder, outside the package
 * outbox, and no other project mentions it, or any file of the same take, anywhere in its file.
 * If one project file cannot be read, nothing goes: deciding without it could trash a take it uses.
 */

/** The outbox Package for Editing writes into, inside the recordings folder. Never swept. */
export const PACKAGES_OUTBOX = "Πακέτα";
/** Where Open Package unpacks what it receives, inside the recordings folder. */
export const PACKAGES_INBOX = "Παραλαβές";

export interface CleanupDeps {
	recordingsDir: string;
	/** Every project file's raw text. Throws when one cannot be read. */
	readAllProjectFilesRaw(): Promise<{ filePath: string; raw: string }[]>;
	/** Moves a file to the Trash (`shell.trashItem`). */
	trash(file: string): Promise<void>;
	log(message: string): void;
}

export interface CleanupResult {
	trashed: string[];
	/** Files that should have gone but could not be moved. */
	kept: string[];
	/** True when a project file could not be read and nothing was touched. */
	failedClosed: boolean;
}

type RawProject = { filePath: string; raw: string };

/** A comparison key: macOS volumes are case-insensitive, and a path can arrive decomposed. */
function pathKey(file: string): string {
	return path.resolve(file).normalize("NFC").toLowerCase();
}

function isInside(dir: string, file: string): boolean {
	const relative = path.relative(pathKey(dir), pathKey(file));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The take a file belongs to: its folder and `recording-<id>`, which every sidecar shares. */
function takeKey(file: string): string | null {
	const match = path.basename(file).match(/^(recording-\d+)/);
	return match ? pathKey(path.join(path.dirname(file), match[1])) : null;
}

/**
 * A file the app made, in the recordings folder: a take or a sidecar of one, a voiceover, or
 * anything a received package brought. The folder is the user's choice and may hold their own
 * files too (the Desktop, a footage drive), so being in it is no proof.
 */
function isSweepable(recordingsDir: string, file: string): boolean {
	if (!path.isAbsolute(file) || !isInside(recordingsDir, file)) return false;
	if (isInside(path.join(recordingsDir, PACKAGES_OUTBOX), file)) return false;
	if (isInside(path.join(recordingsDir, PACKAGES_INBOX), file)) return true;
	return /^(recording-\d+|voiceover-)/.test(path.basename(file));
}

/** Every path inside the recordings folder a project file mentions, in any field. */
function mentionedPaths(raw: string, recordingsDir: string | null): string[] {
	const found: string[] = [];
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			let candidate = value;
			if (candidate.startsWith("file://")) {
				try {
					candidate = fileURLToPath(candidate);
				} catch {
					return;
				}
			}
			if (
				path.isAbsolute(candidate) &&
				(recordingsDir === null || isInside(recordingsDir, candidate))
			)
				found.push(candidate);
		} else if (Array.isArray(value)) {
			for (const item of value) visit(item);
		} else if (value && typeof value === "object") {
			for (const item of Object.values(value)) visit(item);
		}
	};
	visit(JSON.parse(raw));
	return found;
}

/** What protects a file: the files other projects mention, and every take they belong to. */
interface Protection {
	files: Set<string>;
	takes: Set<string>;
}

function protects(protection: Protection, file: string): boolean {
	const take = takeKey(file);
	return protection.files.has(pathKey(file)) || (take !== null && protection.takes.has(take));
}

/** Throws on a file that is not JSON, which the callers take as "decide nothing". */
function protectionFrom(
	recordingsDir: string | null,
	files: RawProject[],
	isOther: (raw: string) => boolean,
	alsoProtect: AxcutDocument[] = [],
): Protection {
	const protection: Protection = { files: new Set(), takes: new Set() };
	const add = (file: string) => {
		protection.files.add(pathKey(file));
		const take = takeKey(file);
		if (take) protection.takes.add(take);
	};
	for (const { raw } of files) {
		if (!isOther(raw)) continue;
		for (const file of mentionedPaths(raw, recordingsDir)) add(file);
	}
	for (const doc of alsoProtect) {
		for (const file of mentionedPaths(JSON.stringify(doc), recordingsDir)) add(file);
	}
	return protection;
}

/** The files a project owns on disk: its media and their sidecars, as Package for Editing sees them. */
function ownedFiles(doc: AxcutDocument, recordingsDir: string): string[] {
	const files = new Map<string, string>();
	for (const ref of collectPackageRefs(doc)) {
		if (isSweepable(recordingsDir, ref.sourcePath))
			files.set(pathKey(ref.sourcePath), ref.sourcePath);
	}
	return [...files.values()];
}

async function trashAll(
	deps: CleanupDeps,
	files: string[],
): Promise<Pick<CleanupResult, "trashed" | "kept">> {
	const trashed: string[] = [];
	const kept: string[] = [];
	for (const file of files) {
		const present = await fs.access(file).then(
			() => true,
			() => false,
		);
		if (!present) continue;
		try {
			await deps.trash(file);
			trashed.push(file);
		} catch (error) {
			kept.push(file);
			deps.log(`could not move ${file} to the Trash: ${String(error)}`);
		}
	}
	return { trashed, kept };
}

function projectIdOf(raw: string): string | null {
	try {
		const parsed = JSON.parse(raw) as { project?: { id?: unknown } };
		return typeof parsed.project?.id === "string" ? parsed.project.id : null;
	} catch {
		return null;
	}
}

/** Reads every project file once, and checks each is JSON. Throws otherwise: decide nothing. */
async function readAll(deps: CleanupDeps): Promise<RawProject[]> {
	const files = await deps.readAllProjectFilesRaw();
	for (const { raw } of files) JSON.parse(raw);
	return files;
}

/** After a project's delete: its takes to the Trash, those of them no other project uses. */
export async function trashDeletedProject(
	deps: CleanupDeps,
	deleted: AxcutDocument,
): Promise<CleanupResult> {
	let protection: Protection;
	try {
		protection = protectionFrom(
			deps.recordingsDir,
			await readAll(deps),
			(raw) => projectIdOf(raw) !== deleted.project.id,
		);
	} catch (error) {
		deps.log(`a project file could not be read, so no recording was moved: ${String(error)}`);
		return { trashed: [], kept: [], failedClosed: true };
	}
	const files = ownedFiles(deleted, deps.recordingsDir).filter(
		(file) => !protects(protection, file),
	);
	return { ...(await trashAll(deps, files)), failedClosed: false };
}

/**
 * The takes the user deleted from the timeline (`discardedAt`, set with the delete and undone with
 * it) that nothing uses since. A take merely waiting in the media library, or one whose import was
 * cut short, carries no mark and stays. Only what the app recorded or received.
 */
export function unusedRecordingAssetIds(doc: AxcutDocument, recordingsDir: string): string[] {
	const used = usedAssetIds(doc);
	return doc.assets
		.filter(
			(asset) =>
				asset.discardedAt !== undefined &&
				!used.has(asset.id) &&
				isSweepable(recordingsDir, asset.originalPath),
		)
		.map((asset) => asset.id);
}

export interface SweepDeps extends CleanupDeps {
	listProjects(): Promise<AxcutDocument[]>;
	projectOpenInEditor(): Promise<string | null>;
	/**
	 * Saves `next` over `previous` only if the file has not changed since it was read, keeping
	 * `next`'s `updatedAt`: a cleanup is not an edit, and the list is ordered by it.
	 */
	saveIfUnchanged(next: AxcutDocument, previous: AxcutDocument): Promise<boolean>;
}

/** At start: every take the user deleted from a timeline leaves its project for the Trash. */
export async function sweepUnusedTakes(deps: SweepDeps): Promise<CleanupResult> {
	const result: CleanupResult = { trashed: [], kept: [], failedClosed: false };
	const open = await deps.projectOpenInEditor();
	const docs = (await deps.listProjects()).filter(
		(doc) => doc.project.id !== open && unusedRecordingAssetIds(doc, deps.recordingsDir).length > 0,
	);
	if (docs.length === 0) return result;
	let files: RawProject[];
	try {
		files = await readAll(deps);
	} catch (error) {
		deps.log(`a project file could not be read, so no recording was moved: ${String(error)}`);
		return { ...result, failedClosed: true };
	}
	for (const doc of docs) {
		const unused = unusedRecordingAssetIds(doc, deps.recordingsDir);
		const without = unused.reduce(
			(current, assetId) => documentWithoutAsset(current, assetId),
			doc,
		);
		const next = { ...without, project: { ...without.project, updatedAt: doc.project.updatedAt } };
		// The project itself, as saved without them, protects what it still holds.
		const protection = protectionFrom(
			deps.recordingsDir,
			files,
			(raw) => projectIdOf(raw) !== doc.project.id,
			[next],
		);
		if (!(await deps.saveIfUnchanged(next, doc))) {
			deps.log(`${doc.project.id} changed while it was being cleaned; left as it is`);
			continue;
		}
		const removed = new Set(unused);
		const owned = ownedFiles(
			{ ...doc, assets: doc.assets.filter((asset) => removed.has(asset.id)) },
			deps.recordingsDir,
		).filter((file) => !protects(protection, file));
		const moved = await trashAll(deps, owned);
		result.trashed.push(...moved.trashed);
		result.kept.push(...moved.kept);
	}
	return result;
}

export interface TrashAssetResult {
	/** Files moved to the Trash: the media file and its sidecars. */
	trashed: string[];
	/** Files that should have gone but could not be moved. */
	kept: string[];
	/** The media file is still used by a project (this one through another asset, or another one): nothing moved. */
	shared: boolean;
	/** True when a project file could not be read and nothing was touched. */
	failedClosed: boolean;
	/** The request was not honoured: unknown token, or the asset is still in the saved project. */
	refused?: boolean;
}

export interface AssetTrashDeps extends CleanupDeps {
	/** The saved project, read by main from its own store. */
	getProject(projectId: string): Promise<AxcutDocument>;
	/** The path when the app may read it as media (`readableApprovedPath`), else null. */
	approvedPath(file: string): string | null;
}

/**
 * The files of one media item. Only a take the app made (`recording-<id>`, the package inbox)
 * brings its sidecars: `<file>.cursor.json`, the take's `.session.json` and `.mic.wav`, its
 * camera video and a `-webcam.*` beside it. Any other file is exactly the one the project names,
 * so a neighbour such as `interview-webcam.mp4` is never touched.
 */
export async function mediaFilesOf(asset: AxcutAsset, recordingsDir: string): Promise<string[]> {
	if (!isSweepable(recordingsDir, asset.originalPath)) return [asset.originalPath];
	const doc = { ...createEmptyDocument({ projectId: "trash", title: "trash" }), assets: [asset] };
	const files = new Map<string, string>();
	for (const ref of collectPackageRefs(doc)) {
		if (ref.kind === "derived" || ref.kind === "graphic-frame") continue;
		if (isSweepable(recordingsDir, ref.sourcePath))
			files.set(pathKey(ref.sourcePath), ref.sourcePath);
	}
	const parsed = path.parse(asset.originalPath);
	const base = parsed.name.endsWith("-webcam")
		? parsed.name.slice(0, -"-webcam".length)
		: parsed.name;
	try {
		for (const name of await fs.readdir(parsed.dir)) {
			if (name.startsWith(`${base}-webcam.`)) {
				const file = path.join(parsed.dir, name);
				files.set(pathKey(file), file);
			}
		}
	} catch {
		// A folder that is gone has nothing more to move.
	}
	return [...files.values()];
}

/** A regular file: not a link, not a folder. */
async function isRegularFile(file: string): Promise<boolean> {
	try {
		return (await fs.lstat(file)).isFile();
	} catch {
		return false;
	}
}

interface PendingTrash {
	projectId: string;
	asset: AxcutAsset;
	files: string[];
}
const pendingTrashes = new Map<string, PendingTrash>();

/**
 * Step one of "Delete from disk", before the asset leaves the project: main reads the saved
 * project itself and resolves the asset's files from it (the renderer names only ids), then
 * returns the list for the confirm dialog with a token. Null when the asset is not in that
 * project or its media file is not an approved regular file.
 */
export async function prepareAssetTrash(
	deps: AssetTrashDeps,
	projectId: string,
	assetId: string,
): Promise<{ token: string; files: string[] } | null> {
	let doc: AxcutDocument;
	try {
		doc = await deps.getProject(projectId);
	} catch {
		return null;
	}
	const asset = doc.assets.find((candidate) => candidate.id === assetId);
	if (!asset || !path.isAbsolute(asset.originalPath)) return null;
	if (!deps.approvedPath(asset.originalPath) || !(await isRegularFile(asset.originalPath))) {
		return null;
	}
	const files: string[] = [];
	for (const file of await mediaFilesOf(asset, deps.recordingsDir)) {
		if (path.isAbsolute(file) && (await isRegularFile(file))) files.push(file);
	}
	const token = randomUUID();
	pendingTrashes.set(token, { projectId, asset, files });
	return { token, files };
}

/** Forget a prepared trash (the dialog was cancelled). */
export function cancelAssetTrash(token: string): void {
	pendingTrashes.delete(token);
}

/**
 * Step two, after the renderer removed the asset and saved: re-reads the saved project, refuses
 * unless the asset is gone from it, then moves the prepared files to the Trash, unless any
 * project file still mentions the file or its take (this project's included).
 */
export async function commitAssetTrash(
	deps: AssetTrashDeps,
	token: string,
): Promise<TrashAssetResult> {
	const pending = pendingTrashes.get(token);
	const refused = { trashed: [], kept: [], shared: false, failedClosed: false, refused: true };
	if (!pending) return refused;
	try {
		const doc = await deps.getProject(pending.projectId);
		if (doc.assets.some((asset) => asset.id === pending.asset.id)) return refused;
	} catch {
		return refused;
	}
	pendingTrashes.delete(token);
	let protection: Protection;
	try {
		protection = protectionFrom(null, await readAll(deps), () => true);
	} catch (error) {
		deps.log(`a project file could not be read, so no media file was moved: ${String(error)}`);
		return { trashed: [], kept: [], shared: false, failedClosed: true };
	}
	if (protects(protection, pending.asset.originalPath)) {
		return { trashed: [], kept: [], shared: true, failedClosed: false };
	}
	const movable: string[] = [];
	for (const file of pending.files) {
		if (!protects(protection, file) && (await isRegularFile(file))) movable.push(file);
	}
	return { ...(await trashAll(deps, movable)), shared: false, failedClosed: false };
}
