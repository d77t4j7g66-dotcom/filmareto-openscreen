// Opens an editor package (a zip or an unzipped folder) on this Mac: checks it, moves it into the
// receive folder, and points the project at the received files. Nothing from the package is
// trusted: it was written on another machine.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createId } from "../../src/lib/ai-edition/document/ids";
import { type AxcutDocument, parseDocumentFile } from "../../src/lib/ai-edition/schema";
import { SEGMENT_LOOK_KEYS } from "../../src/lib/ai-edition/store/editorSettings";
import { COLOR_FUNC_RE, DEFAULT_WALLPAPER, GRADIENT_RE } from "../../src/lib/wallpaper";
import { registerMediaLinks } from "../media/mediaLinksRegistry";
import {
	PACKAGE_MANIFEST_NAME,
	PACKAGE_PROJECT_NAME,
	type PackageManifest,
	parsePackageManifest,
} from "./manifest";
import { rewriteDocumentPaths, sessionManifestPathForVideo } from "./packageReferences";
import { unzipTo } from "./zip";

export interface OpenPackageInput {
	/** A package zip, or an unzipped package folder. */
	source: string;
	receiveRoot: string;
	graphicsCacheRoot: string;
	registryDir: string;
	existingProjectIds: ReadonlySet<string>;
	mode?: "replace" | "copy";
}

export type OpenPackageResult =
	| { ok: true; doc: AxcutDocument; folderPath: string }
	| { ok: false; reason: "exists"; projectId: string; title: string }
	| { ok: false; reason: "not-a-package" | "damaged" | "missing-files"; detail?: string[] };

const GRAPHICS_CACHE_DIR = "graphics-cache";
const USER_TEMPLATE_PREFIX = "user:";
const CURSOR_SIDECAR_SUFFIX = ".cursor.json";
// Lives in the media-links registry module, which does not export it.
const REGISTRY_FILE_NAME = "media-links.registry.json";
const IGNORED_TOP_LEVEL = new Set(["__MACOSX", ".DS_Store"]);

type Fail = Extract<OpenPackageResult, { ok: false }>;

/** A relative POSIX path made of plain segments: nothing that can leave the folder it is joined to. */
function isSafeRelativePath(p: string): boolean {
	if (p === "" || p.startsWith("/") || path.isAbsolute(p) || p.includes("\\")) return false;
	return !p.split("/").some((s) => s === "" || s === "." || s === "..");
}

const isSafeSegment = (s: string) => isSafeRelativePath(s) && !s.includes("/");

function isInside(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function isFile(p: string): Promise<boolean> {
	try {
		return (await fs.stat(p)).isFile();
	} catch {
		return false;
	}
}

/** Relative paths of every symlink under `dir`: a link in a received package could point anywhere. */
async function findSymlinks(dir: string, base = dir): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) found.push(path.relative(base, full));
		else if (entry.isDirectory()) found.push(...(await findSymlinks(full, base)));
	}
	return found.sort();
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

async function freeFolderName(receiveRoot: string, base: string): Promise<string> {
	for (let n = 1; ; n++) {
		const name = n === 1 ? base : `${base} (${n})`;
		if (!(await exists(path.join(receiveRoot, name)))) return name;
	}
}

/** The folder inside `staging` that holds the manifest, and the name it should be received under. */
async function findPackageRoot(
	staging: string,
	fallbackName: string,
): Promise<{ dir: string; name: string } | null> {
	if (await exists(path.join(staging, PACKAGE_MANIFEST_NAME))) {
		return { dir: staging, name: fallbackName };
	}
	const entries = (await fs.readdir(staging, { withFileTypes: true })).filter(
		(e) => !IGNORED_TOP_LEVEL.has(e.name),
	);
	if (entries.length !== 1 || !entries[0].isDirectory()) return null;
	const dir = path.join(staging, entries[0].name);
	if (!(await exists(path.join(dir, PACKAGE_MANIFEST_NAME)))) return null;
	return { dir, name: entries[0].name };
}

/** Copies `from` to `to` unless `to` exists. Returns whether it created the file. */
async function copyIfAbsent(from: string, to: string, undo: Undo): Promise<boolean> {
	const firstDir = await fs.mkdir(path.dirname(to), { recursive: true });
	if (firstDir) undo.paths.push(firstDir);
	try {
		await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
		undo.paths.push(to);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

async function readManifest(dir: string): Promise<PackageManifest | null> {
	return parsePackageManifest(
		await fs.readFile(path.join(dir, PACKAGE_MANIFEST_NAME), "utf8").catch(() => ""),
	);
}

/** What a failed open must remove again from the shared folders. */
interface Undo {
	paths: string[];
	registrySnapshot: { text: string | null } | null;
}

interface Checked {
	doc: AxcutDocument;
	manifest: PackageManifest;
	/** Parsed session manifests, by package-relative path. */
	sessions: Map<string, Record<string, unknown>>;
}

const isDataUrl = (value: unknown): boolean =>
	typeof value === "string" && value.startsWith("data:");

// An image annotation that names a file on disk would read it from this Mac; only embedded images
// stay. A graphic (no source of its own, frames checked separately) is kept.
function isEmbeddedImage(annotation: AxcutDocument["annotations"][number]): boolean {
	if (annotation.type !== "image") return true;
	return [annotation.content, annotation.imageContent].every((v) => !v || isDataUrl(v));
}

const WALLPAPER_DATA_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const WALLPAPER_BUNDLED_RE = /^\/wallpapers\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const WALLPAPER_HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const WALLPAPER_CSS_CHARS_RE = /^[A-Za-z0-9#%.,()\s+-]+$/;

// A wallpaper survives only by matching one positive form: an embedded image, a bundled wallpaper,
// a hex colour, or a plain colour function / gradient. Everything else (a path, a URL, anything
// that could add a background layer) goes back to the default.
function isAllowedWallpaper(value: string): boolean {
	if (WALLPAPER_DATA_RE.test(value) || WALLPAPER_HEX_RE.test(value)) return true;
	if (WALLPAPER_BUNDLED_RE.test(value)) return !value.includes("..");
	if (!COLOR_FUNC_RE.test(value) && !GRADIENT_RE.test(value)) return false;
	const lower = value.toLowerCase();
	return (
		WALLPAPER_CSS_CHARS_RE.test(value) && !lower.includes("url(") && !lower.includes("image-set")
	);
}

const LOOK_KEYS: ReadonlySet<string> = new Set(SEGMENT_LOOK_KEYS);

// A clip's look is laid over the project's settings when it is shown, so it could carry a wallpaper
// the project-level check never saw. Only the keys a segment may own survive; the background is
// the project's, so a wallpaper in a look is dropped.
function sanitizeClipLooks(doc: AxcutDocument): void {
	for (const clip of doc.timeline.clips) {
		if (!clip.look) continue;
		clip.look = Object.fromEntries(Object.entries(clip.look).filter(([key]) => LOOK_KEYS.has(key)));
	}
}

/** Drops what would make the app read a file of its own accord from a document it did not write. */
function sanitize(doc: AxcutDocument): void {
	doc.annotations = doc.annotations.filter(isEmbeddedImage);
	sanitizeClipLooks(doc);
	const legacy = doc.legacyEditor;
	if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
		const settings = legacy as Record<string, unknown>;
		for (const key of ["wallpaper", "webcamWallpaper"]) {
			const value = settings[key];
			if (value === undefined) continue;
			const trimmed = typeof value === "string" ? value.trim() : null;
			settings[key] = trimmed !== null && isAllowedWallpaper(trimmed) ? trimmed : DEFAULT_WALLPAPER;
		}
	}
}

/** Reads and checks the package in `dir`; returns the failure to report, or what it holds. */
async function check(dir: string): Promise<Fail | Checked> {
	const manifest = await readManifest(dir);
	if (!manifest) return { ok: false, reason: "not-a-package" };
	const projectText = await fs
		.readFile(path.join(dir, PACKAGE_PROJECT_NAME), "utf8")
		.catch(() => null);
	if (projectText === null) return { ok: false, reason: "not-a-package" };

	const badManifest = manifest.files.map((f) => f.path).filter((p) => !isSafeRelativePath(p));
	if (badManifest.length > 0) return { ok: false, reason: "not-a-package", detail: badManifest };

	let doc: AxcutDocument;
	try {
		doc = parseDocumentFile(JSON.parse(projectText));
	} catch {
		return { ok: false, reason: "damaged" };
	}
	sanitize(doc);

	const bad: string[] = [];
	rewriteDocumentPaths(doc, (p) => {
		if (!isSafeRelativePath(p)) bad.push(p);
		else if (p.startsWith(`${GRAPHICS_CACHE_DIR}/`) && p.split("/").length !== 3) bad.push(p);
		return p;
	});
	for (const annotation of doc.annotations) {
		const templateId = annotation.graphicData?.templateId ?? "";
		if (!templateId.startsWith(USER_TEMPLATE_PREFIX)) continue;
		const folder = templateId.slice(USER_TEMPLATE_PREFIX.length);
		if (!isSafeSegment(folder)) bad.push(templateId);
	}
	if (bad.length > 0) return { ok: false, reason: "not-a-package", detail: bad };

	const present = (p: string) => isFile(path.join(dir, ...p.split("/")));
	const missing = new Set<string>();
	const damaged = new Set<string>();
	for (const file of manifest.files) {
		const stat = await fs.stat(path.join(dir, ...file.path.split("/"))).catch(() => null);
		if (!stat?.isFile()) missing.add(path.basename(file.path));
		else if (stat.size !== file.sizeBytes) damaged.add(path.basename(file.path));
	}
	// Media the project needs must be in the package; derived (ext:) clips and optional files may not be.
	for (const asset of doc.assets) {
		if (!asset.id.startsWith("ext:")) {
			if (!(await present(asset.originalPath))) missing.add(path.basename(asset.originalPath));
			const camera = asset.cameraTrack?.sourcePath;
			if (camera && !(await present(camera))) missing.add(path.basename(camera));
		}
		if (asset.proxyPath && !(await present(asset.proxyPath))) delete asset.proxyPath;
		if (asset.waveformPath && !(await present(asset.waveformPath))) delete asset.waveformPath;
	}
	for (const transcript of [doc.transcript, ...doc.transcripts]) {
		if (!transcript) continue;
		if (transcript.sourceDslPath && !(await present(transcript.sourceDslPath)))
			delete transcript.sourceDslPath;
		if (transcript.sourceJsonPath && !(await present(transcript.sourceJsonPath)))
			delete transcript.sourceJsonPath;
	}
	for (const annotation of doc.annotations) {
		for (const frame of annotation.graphicData?.frames ?? []) {
			if (!(await present(frame.path))) missing.add(path.basename(frame.path));
		}
	}
	if (damaged.size > 0) return { ok: false, reason: "damaged", detail: [...damaged] };
	if (missing.size > 0) return { ok: false, reason: "missing-files", detail: [...missing] };

	const sessions = new Map<string, Record<string, unknown>>();
	for (const asset of doc.assets) {
		if (asset.kind !== "video") continue;
		const rel = sessionManifestPathForVideo(asset.originalPath);
		if (sessions.has(rel)) continue;
		const full = path.join(dir, ...rel.split("/"));
		if (!(await exists(full))) continue;
		try {
			const parsed: unknown = JSON.parse(await fs.readFile(full, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
			sessions.set(rel, parsed as Record<string, unknown>);
		} catch {
			return { ok: false, reason: "damaged" };
		}
	}
	return { doc, manifest, sessions };
}

async function stage(source: string, staging: string): Promise<{ fallbackName: string } | Fail> {
	const stat = await fs.stat(source).catch(() => null);
	if (!stat) return { ok: false, reason: "not-a-package" };
	if (stat.isDirectory()) {
		const name = path.basename(source);
		if (!(await findPackageRoot(source, name))) return { ok: false, reason: "not-a-package" };
		await fs.cp(source, path.join(staging, name), { recursive: true, dereference: false });
		return { fallbackName: name };
	}
	try {
		await unzipTo(source, staging);
	} catch {
		return { ok: false, reason: "damaged" };
	}
	return { fallbackName: path.basename(source, path.extname(source)) };
}

export async function openEditorPackage(input: OpenPackageInput): Promise<OpenPackageResult> {
	const { source, receiveRoot, graphicsCacheRoot, registryDir } = input;
	await fs.mkdir(receiveRoot, { recursive: true });
	const staging = path.join(receiveRoot, `.partial-${randomUUID()}`);
	let finalFolder: string | null = null;
	const undo: Undo = { paths: [], registrySnapshot: null };
	try {
		await fs.mkdir(staging);
		const staged = await stage(source, staging);
		if ("ok" in staged) return staged;

		const found = await findPackageRoot(staging, staged.fallbackName);
		if (!found) return { ok: false, reason: "not-a-package" };
		const links = await findSymlinks(found.dir);
		if (links.length > 0) return { ok: false, reason: "not-a-package", detail: links };
		const checked = await check(found.dir);
		if ("ok" in checked) return checked;

		let doc = checked.doc;
		if (input.existingProjectIds.has(doc.project.id)) {
			if (!input.mode) {
				return { ok: false, reason: "exists", projectId: doc.project.id, title: doc.project.title };
			}
			if (input.mode === "copy") {
				doc = {
					...doc,
					project: { ...doc.project, id: createId("proj"), title: `${doc.project.title} (2)` },
				};
			}
		}

		const folderName = await freeFolderName(receiveRoot, found.name);
		const target = path.join(receiveRoot, folderName);
		if (!isInside(receiveRoot, target)) return { ok: false, reason: "not-a-package" };

		// Media paths resolve under the received folder; graphic frames go to the shared cache.
		const frameCopies = new Map<string, string>();
		doc = rewriteDocumentPaths(doc, (p) => {
			if (p.startsWith(`${GRAPHICS_CACHE_DIR}/`)) {
				const dest = path.join(graphicsCacheRoot, ...p.split("/").slice(1));
				frameCopies.set(path.join(target, ...p.split("/")), dest);
				return dest;
			}
			return path.join(target, ...p.split("/"));
		});
		const outside = [...doc.assets.map((a) => a.originalPath)].filter(
			(p) => !isInside(receiveRoot, p),
		);
		const badFrames = [...frameCopies.values()].filter((p) => !isInside(graphicsCacheRoot, p));
		if (outside.length > 0 || badFrames.length > 0) {
			return { ok: false, reason: "not-a-package", detail: [...outside, ...badFrames] };
		}

		// Written while the package is still in staging, where nothing else can see it.
		await rewriteSessions(found.dir, checked, target);
		await fs.rename(found.dir, target);
		finalFolder = target;

		// The shared folders come last; whatever lands in them is undone if a step fails.
		await writeShared({ doc, target, frameCopies, registryDir }, undo);

		finalFolder = null;
		return { ok: true, doc, folderPath: target };
	} catch (error) {
		await rollback(undo, registryDir);
		if (finalFolder) await fs.rm(finalFolder, { recursive: true, force: true });
		throw error;
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
}

async function rollback(undo: Undo, registryDir: string): Promise<void> {
	for (const p of [...undo.paths].reverse()) await fs.rm(p, { recursive: true, force: true });
	if (undo.registrySnapshot) {
		const file = path.join(registryDir, REGISTRY_FILE_NAME);
		if (undo.registrySnapshot.text === null) await fs.rm(file, { force: true });
		else await fs.writeFile(file, undo.registrySnapshot.text);
	}
}

// A copied session manifest still names the paths of the Mac it came from, and the app only trusts
// a manifest whose screen or webcam path is the video it was asked about.
async function rewriteSessions(dir: string, checked: Checked, target: string): Promise<void> {
	const absolute = (rel: string) => path.join(target, ...rel.split("/"));
	const done = new Set<string>();
	for (const asset of checked.doc.assets) {
		if (asset.kind !== "video") continue;
		const rel = sessionManifestPathForVideo(asset.originalPath);
		const session = checked.sessions.get(rel);
		if (!session || done.has(rel)) continue;
		done.add(rel);
		session.screenVideoPath = absolute(asset.originalPath);
		if (asset.cameraTrack) session.webcamVideoPath = absolute(asset.cameraTrack.sourcePath);
		await fs.writeFile(path.join(dir, ...rel.split("/")), JSON.stringify(session, null, 2));
	}
}

interface SharedWrites {
	doc: AxcutDocument;
	target: string;
	frameCopies: Map<string, string>;
	registryDir: string;
}

async function writeShared(w: SharedWrites, undo: Undo): Promise<void> {
	for (const [from, to] of w.frameCopies) await copyIfAbsent(from, to, undo);
	await registerRecordings(w.doc, w.registryDir, undo);
}

async function registerRecordings(
	doc: AxcutDocument,
	registryDir: string,
	undo: Undo,
): Promise<void> {
	for (const asset of doc.assets) {
		if (asset.kind !== "video") continue;
		const video = asset.originalPath;
		// A derived clip may be absent from the package: there is nothing to fingerprint.
		if (!(await isFile(video))) continue;
		const camera = asset.cameraTrack?.sourcePath;
		const webcam = camera && (await isFile(camera)) ? camera : undefined;
		const cursor = `${video}${CURSOR_SIDECAR_SUFFIX}`;
		const cursorTelemetryPath = (await isFile(cursor)) ? cursor : undefined;
		if (!webcam && !cursorTelemetryPath) continue;
		if (!undo.registrySnapshot) {
			const text = await fs
				.readFile(path.join(registryDir, REGISTRY_FILE_NAME), "utf8")
				.catch(() => null);
			undo.registrySnapshot = { text };
		}
		await registerMediaLinks(registryDir, video, {
			...(webcam ? { webcamVideoPath: webcam } : {}),
			...(cursorTelemetryPath ? { cursorTelemetryPath } : {}),
		});
	}
}
