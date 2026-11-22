// What a project document points at, and how to rewrite those paths. Pure: no file access, so the
// pack and unpack steps can be tested without a disk.

import path from "node:path";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";

export type PackageRefKind =
	| "asset"
	| "camera"
	| "cursor"
	| "session"
	| "graphic-frame"
	| "derived";

export interface PackageRef {
	sourcePath: string;
	packagePath: string;
	kind: PackageRefKind;
	required: boolean;
}

export const RECORDING_SESSION_SUFFIX = ".session.json";
const CURSOR_SIDECAR_SUFFIX = ".cursor.json";
const GENERATED_ASSET_PREFIX = "ext:";
const MAX_FOLDER_NAME_LENGTH = 80;

function sessionManifestPathWith(pathApi: typeof path.posix, videoPath: string): string {
	const parsedPath = pathApi.parse(videoPath);
	const baseName = parsedPath.name.endsWith("-webcam")
		? parsedPath.name.slice(0, -"-webcam".length)
		: parsedPath.name;
	return pathApi.join(parsedPath.dir, `${baseName}${RECORDING_SESSION_SUFFIX}`);
}

/** The recording-session manifest that sits next to a video (a `-webcam` file shares its screen's). */
export function sessionManifestPathForVideo(videoPath: string): string {
	return sessionManifestPathWith(path, videoPath);
}

// Two names are the same file on a case-insensitive, normalisation-insensitive volume (APFS).
const nameKey = (name: string) => name.normalize("NFC").toLowerCase();

// Packages carry rendered graphic frames only: a user graphic template (HTML and scripts) is never
// packed, so a received package cannot make this app run code it brought along.
export function collectPackageRefs(doc: AxcutDocument): PackageRef[] {
	const refs = new Map<string, PackageRef>();
	const mediaNames = new Map<string, string>();
	const taken = new Set<string>();
	const recordingPrefixes = new Map<string, number>();

	const add = (ref: PackageRef) => {
		const existing = refs.get(ref.sourcePath);
		if (!existing) {
			refs.set(ref.sourcePath, ref);
		} else if (ref.required && !existing.required) {
			refs.set(ref.sourcePath, { ...existing, kind: ref.kind, required: true });
		}
	};

	const safeBase = (sourcePath: string) => path.basename(sourcePath).replace(/\\/g, "_");

	// Every media file lands in media/, named after its basename, with a counter on a clash. A video
	// brings its sidecars along, so the counter is chosen so that none of their names clash either.
	const mediaName = (sourcePath: string, withSidecars = false): string => {
		const known = mediaNames.get(sourcePath);
		if (known) return known;
		const base = safeBase(sourcePath);
		// The screen and webcam videos of one recording share its session manifest, so they share
		// one prefix too: that keeps the manifest found from either final name.
		const recording = sessionManifestPathForVideo(sourcePath);
		const recordingPrefix = recordingPrefixes.get(recording);
		for (let n = recordingPrefix ?? 1; ; n++) {
			const name = n === 1 ? base : `${n}-${base}`;
			const owned = [`media/${name}`];
			if (withSidecars) {
				owned.push(`media/${name}${CURSOR_SIDECAR_SUFFIX}`);
				// A session manifest already claimed is shared, not a second file.
				if (recordingPrefix !== n) owned.push(sessionManifestPathWith(path.posix, `media/${name}`));
			}
			if (owned.some((p) => taken.has(nameKey(p)))) continue;
			for (const p of owned) taken.add(nameKey(p));
			mediaNames.set(sourcePath, name);
			if (withSidecars) recordingPrefixes.set(recording, n);
			return name;
		}
	};
	const media = (sourcePath: string, kind: PackageRefKind, required: boolean) =>
		add({ sourcePath, packagePath: `media/${mediaName(sourcePath)}`, kind, required });

	const isGenerated = (id: string) => id.startsWith(GENERATED_ASSET_PREFIX);
	const hasSidecars = (asset: AxcutDocument["assets"][number]) =>
		asset.kind === "video" && !isGenerated(asset.id);

	// Videos first, so their sidecar names are reserved before anything else takes them.
	for (const asset of doc.assets) {
		if (!hasSidecars(asset)) continue;
		const finalName = `media/${mediaName(asset.originalPath, true)}`;
		add({
			sourcePath: asset.originalPath,
			packagePath: finalName,
			kind: "asset",
			required: true,
		});
		add({
			sourcePath: `${asset.originalPath}${CURSOR_SIDECAR_SUFFIX}`,
			packagePath: `${finalName}${CURSOR_SIDECAR_SUFFIX}`,
			kind: "cursor",
			required: false,
		});
		add({
			sourcePath: sessionManifestPathForVideo(asset.originalPath),
			packagePath: sessionManifestPathWith(path.posix, finalName),
			kind: "session",
			required: false,
		});
	}

	for (const asset of doc.assets) {
		const generated = isGenerated(asset.id);
		media(asset.originalPath, generated ? "derived" : "asset", !generated);
		if (asset.cameraTrack) media(asset.cameraTrack.sourcePath, "camera", true);
		if (asset.proxyPath) media(asset.proxyPath, "derived", false);
		if (asset.waveformPath) media(asset.waveformPath, "derived", false);
	}

	for (const transcript of [doc.transcript, ...doc.transcripts]) {
		if (transcript?.sourceDslPath) media(transcript.sourceDslPath, "derived", false);
		if (transcript?.sourceJsonPath) media(transcript.sourceJsonPath, "derived", false);
	}

	for (const annotation of doc.annotations) {
		const graphic = annotation.graphicData;
		if (!graphic) continue;
		for (const frame of graphic.frames) {
			// <userData>/graphics-cache/<sha>/fNNNNN.png keeps its last two segments.
			const dir = path.basename(path.dirname(frame.path));
			add({
				sourcePath: frame.path,
				packagePath: `graphics-cache/${dir}/${path.basename(frame.path)}`,
				kind: "graphic-frame",
				required: true,
			});
		}
	}

	return [...refs.values()];
}

/** A copy of the document with every path it holds run through `map`. The input is untouched. */
export function rewriteDocumentPaths(
	doc: AxcutDocument,
	map: (p: string) => string,
): AxcutDocument {
	const out = structuredClone(doc);
	for (const asset of out.assets) {
		asset.originalPath = map(asset.originalPath);
		if (asset.cameraTrack) asset.cameraTrack.sourcePath = map(asset.cameraTrack.sourcePath);
		if (asset.proxyPath) asset.proxyPath = map(asset.proxyPath);
		if (asset.waveformPath) asset.waveformPath = map(asset.waveformPath);
	}
	for (const transcript of [out.transcript, ...out.transcripts]) {
		if (!transcript) continue;
		if (transcript.sourceDslPath) transcript.sourceDslPath = map(transcript.sourceDslPath);
		if (transcript.sourceJsonPath) transcript.sourceJsonPath = map(transcript.sourceJsonPath);
	}
	for (const annotation of out.annotations) {
		for (const frame of annotation.graphicData?.frames ?? []) frame.path = map(frame.path);
	}
	return out;
}

/** `2026-11-20 <title>`, safe as a folder name: no separators, at most 80 characters. */
export function packageFolderName(title: string, date: Date): string {
	// The day on this machine's clock, not UTC: a package made late in the evening keeps that date.
	const pad = (n: number) => String(n).padStart(2, "0");
	const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	const cleaned = title
		.replace(/\s*:\s*/g, " - ")
		.replace(/[/\\]/g, "-")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are not allowed in a name
		.replace(/[\u0000-\u001f*?"<>|]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "");
	let name = `${day} ${cleaned || "Untitled"}`;
	if (name.length > MAX_FOLDER_NAME_LENGTH) {
		let cut = "";
		for (const ch of name) {
			if (cut.length + ch.length > MAX_FOLDER_NAME_LENGTH) break;
			cut += ch;
		}
		name = cut.trimEnd();
	}
	return name;
}
