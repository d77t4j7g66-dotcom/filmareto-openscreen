import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import { type CursorKind, DATA_STRIDE, writeDataFile } from "../../src/lib/resolve-export/dataFile";
import { type ManifestMedia, writeTimelineManifest } from "../../src/lib/resolve-export/manifest";
import {
	cameraFrame0,
	framesOfSeconds,
	planResolveExport,
	RESOLVE_FPS,
	resolveTimelineSize,
	segmentSourceTimes,
} from "../../src/lib/resolve-export/plan";
import {
	buildNativeClipList,
	buildSceneDescription,
	type SceneDescription,
} from "../../src/native/sceneDescription";
import { micWavPathForVideo } from "../package/packageReferences";
import { installResolveParts, writeLastExport } from "./install";
import { planToManifestClips } from "./manifestClips";
import {
	backgroundStill,
	canCloneVideo,
	cursorAtlas,
	NoAudioStreamError,
	prepareVideo,
	prepareWav,
	probeAudioFrames,
	probeFrameTiming,
} from "./media";

export interface ResolveExportProgress {
	step: string;
	done: number;
	total: number;
}

export interface SampleParams {
	renderW: number;
	renderH: number;
	screenW: number;
	screenH: number;
	webcamW: number;
	webcamH: number;
}

export interface BuildResolveExportDeps {
	sampleFrames(
		sceneJson: string,
		cursorPath: string | null,
		clipIndex: number,
		role: "screen" | "camera",
		sourceTimes: Float64Array,
		cursorKinds: string[],
		params: SampleParams,
	): Float32Array | null | Promise<Float32Array | null>;
	exportAlpha(
		clips: ReturnType<typeof buildNativeClipList>,
		outPath: string,
		sceneJson: string,
		params: { width: number; height: number; fps: number; ffmpegPath: string },
		onProgress?: (frames: number) => void,
	): Promise<unknown | null>;
	/** Resolves the cursor sprites and wallpapers of a scene JSON to paths on disk. */
	resolveScene(sceneJson: string): string;
	resolveImagePath(p: string): string | null;
	now(): Date;
}

export interface BuildResolveExportInput {
	doc: AxcutDocument;
	outRoot: string;
	ffmpegPath: string;
	/** Where FilmaretoScreen.fuse and the other Resolve parts ship. */
	resolveDir: string;
	/** `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion`. */
	resolveUserDir: string;
	deps: BuildResolveExportDeps;
	onProgress(p: ResolveExportProgress): void;
}

export type BuildResolveExportResult =
	| { ok: true; folder: string; restartNeeded: boolean; warnings: string[] }
	| { ok: false; reason: "no-clips" | "error"; message: string };

const FPS = RESOLVE_FPS;
const BLUR_WARNING = "Privacy blur is not in the Resolve export yet";
const AUDIO_TRACKS_WARNING = "Imported audio (voice-overs, music) is not in the Resolve export yet";
const CAMERA_EFFECT_WARNING =
	"The camera's background effect (cutout, blur or custom background) is not in the Resolve export yet: the camera comes in as filmed.";
const FRAME_WARNING =
	"The window or device frame around the recording is not in the Resolve export yet";
const ROTATION_WARNING = "Tilt and 3D zoom rotations are not in the Resolve export yet";
const SHADER_WARNING = "Shader effects are not in the Resolve export yet";
const PROBE_TIMEOUT_MS = 30_000;

type SceneJson = {
	cursor?: {
		cursorSprites?: Record<string, { path: string; hotspotX: number; hotspotY: number }>;
	};
	[key: string]: unknown;
};

/** A folder name part that is safe on every file system the export may be copied to. */
export function safeFileName(name: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
	const cleaned = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "-");
	const trimmed = cleaned.replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 80).trim();
	return trimmed || "Untitled";
}

const two = (n: number) => String(n).padStart(2, "0");

/** `yyyy-mm-dd HH.MM`, in local time. */
export function folderStamp(d: Date): string {
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}`;
}

function probeVideoSize(ffmpeg: string, file: string): Promise<{ w: number; h: number } | null> {
	return new Promise((resolve) => {
		// `-i` with no output always exits non-zero, with the listing on stderr: read it from the error.
		execFile(
			ffmpeg,
			["-hide_banner", "-i", file],
			{ timeout: PROBE_TIMEOUT_MS, maxBuffer: 1 << 20 },
			(error, _stdout, stderr) => {
				const text = `${stderr ?? ""}${(error as { stderr?: string } | null)?.stderr ?? ""}`;
				const m = /Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})[\s,[]/.exec(text);
				resolve(m ? { w: Number(m[1]), h: Number(m[2]) } : null);
			},
		);
	});
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Picks `base + ext` not yet used in `taken` (case-insensitive), adding " 2", " 3"... */
function uniqueName(taken: Set<string>, base: string, ext: string): string {
	let candidate = `${base}${ext}`;
	for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} ${n}${ext}`;
	taken.add(candidate.toLowerCase());
	return candidate;
}

async function uniqueFolder(root: string, name: string): Promise<string> {
	let candidate = path.join(root, name);
	for (let n = 2; existsSync(candidate); n++) candidate = path.join(root, `${name} ${n}`);
	return candidate;
}

export async function buildResolveExport(
	input: BuildResolveExportInput,
): Promise<BuildResolveExportResult> {
	const created: { folder: string | null } = { folder: null };
	try {
		return await run(input, created);
	} catch (error) {
		// A half-written export folder is worse than none: the import script would take it.
		if (created.folder) await rm(created.folder, { recursive: true, force: true }).catch(() => {});
		return { ok: false, reason: "error", message: messageOf(error) };
	}
}

/**
 * The document the export's scene is built from: no captions (Resolve exports carry no
 * subtitles). Stored caption annotations are removed, and the setting that derives
 * `caption-<n>` text from the transcript is turned off, so no caption piece is ever created
 * (a caption crossing a cut would otherwise come back under fresh `ann-` ids).
 */
function withoutCaptions(doc: AxcutDocument): AxcutDocument {
	const legacy = (doc.legacyEditor ?? {}) as Record<string, unknown>;
	const captions =
		legacy.captions && typeof legacy.captions === "object" && !Array.isArray(legacy.captions)
			? (legacy.captions as Record<string, unknown>)
			: {};
	return {
		...doc,
		annotations: doc.annotations.filter((a) => a.annotationSource !== "auto-caption"),
		legacyEditor: {
			...legacy,
			captions: { ...captions, enabled: false },
		} as AxcutDocument["legacyEditor"],
	};
}

async function run(
	input: BuildResolveExportInput,
	created: { folder: string | null },
): Promise<BuildResolveExportResult> {
	const { ffmpegPath: ffmpeg, deps, onProgress } = input;
	const doc = input.doc;
	const warnings: string[] = [];

	// 0. The Resolve parts first: with no Fuse to ship, nothing heavy runs and no folder exists yet.
	// `last-export.lua` is written at the very end, once the folder is complete.
	const install = await installResolveParts({
		resolveDir: input.resolveDir,
		resolveUserDir: input.resolveUserDir,
	});

	// 1. Scene and plan.
	const webcamSize = doc.assets.find(
		(a) => a.cameraTrack?.width && a.cameraTrack?.height,
	)?.cameraTrack;
	const built: SceneDescription = buildSceneDescription(
		withoutCaptions(doc),
		webcamSize?.width && webcamSize?.height
			? { width: webcamSize.width, height: webcamSize.height }
			: null,
	);
	// The timeline is the project's aspect with the short side at 1080: the data files, the
	// background, the overlay and the manifest all use this size, not the take's.
	const { width, height } = resolveTimelineSize(built.output);
	const scene: SceneDescription = { ...built, output: { ...built.output, width, height } };
	const sceneJson = deps.resolveScene(JSON.stringify(scene));
	const resolvedScene = JSON.parse(sceneJson) as SceneJson;
	if (scene.annotations.some((a) => a.kind === "blur")) warnings.push(BLUR_WARNING);
	if (doc.audioTracks.length > 0) warnings.push(AUDIO_TRACKS_WARNING);
	const overlayAnnotations = scene.annotations.filter((a) => a.kind !== "blur");
	const hasOverlay = overlayAnnotations.length > 0;

	const plan = planResolveExport(scene, {
		fps: FPS,
		micWavPathFor: (p) => {
			const wav = micWavPathForVideo(p);
			return existsSync(wav) ? wav : null;
		},
		overlay: hasOverlay,
	});
	if (plan.segments.length === 0) {
		return { ok: false, reason: "no-clips", message: "The project has no clip to export." };
	}

	// Looks the Fuse does not draw: said once each, not silently dropped.
	if (plan.segments.some((s) => s.camera)) {
		const mode = scene.webcamEffect?.mode;
		if (mode === "transparent" || mode === "blur" || mode === "custom") {
			warnings.push(CAMERA_EFFECT_WARNING);
		}
	}
	if (scene.effects.frame && (scene.effects.frame as string) !== "none")
		warnings.push(FRAME_WARNING);
	if (scene.zoomRegions.some((r) => r.rotation && (r.rotation as string) !== "none")) {
		warnings.push(ROTATION_WARNING);
	}
	if ((scene.shaderEffects?.length ?? 0) > 0) warnings.push(SHADER_WARNING);
	const noCursor = new Set<string>();
	for (const seg of plan.segments) {
		if (!(seg.cursorPath && existsSync(seg.cursorPath))) noCursor.add(seg.mediaSourcePath);
	}
	for (const take of noCursor) {
		warnings.push(
			`No cursor data for ${path.basename(take)}: no cursor, no cursor-follow zoom and no camera dodge in Resolve for it.`,
		);
	}

	// 2. Folder.
	const folder = await uniqueFolder(
		input.outRoot,
		`${folderStamp(deps.now())} ${safeFileName(doc.project.title)}`,
	);
	const mediaDir = path.join(folder, "media");
	const dataDir = path.join(folder, "data");
	created.folder = folder;
	await mkdir(mediaDir, { recursive: true });
	await mkdir(dataDir, { recursive: true });

	// Work items, for the progress bar: media files, data files, overlay.
	const screenSources = [
		...new Set(plan.segments.filter((s) => !s.retimed).map((s) => s.mediaSourcePath)),
	];
	const cameraSources = [
		...new Set(
			plan.segments.filter((s) => s.camera && !s.retimed).map((s) => s.camera?.mediaSourcePath),
		),
	] as string[];
	const audioSources = [...new Set(plan.audio.filter((a) => !a.retimed).map((a) => a.sourcePath))];
	const total =
		screenSources.length +
		cameraSources.length +
		audioSources.length +
		plan.segments.filter((s) => s.retimed).length * 2 +
		plan.audio.filter((a) => a.retimed).length +
		plan.segments.length * 2 +
		(hasOverlay ? 1 : 0) +
		3;
	let done = 0;
	const tick = (step: string) => {
		done += 1;
		onProgress({ step, done: Math.min(done, total), total });
	};
	onProgress({ step: "start", done: 0, total });

	// 3. Media.
	const names = new Set<string>(["background.png", "overlay.mov"]);
	const media: ManifestMedia[] = [];
	/** Paths in the manifest and the data files are relative to the export folder, with "/". */
	const rel = (p: string) => path.relative(folder, p).split(path.sep).join("/");
	const addMedia = (m: ManifestMedia) => {
		media.push({ ...m, path: rel(m.path) });
		return m.key;
	};
	/** Real frame counts of the prepared files that are not retimed (a retimed one is exact). */
	const fileFrames = new Map<string, number>();
	const videoMedia = async (
		src: string,
		prefix: string,
		opts: {
			speed: number;
			startSec?: number;
			endSec?: number;
			key?: string;
			frames?: number;
		},
	): Promise<string> => {
		const parsed = path.parse(src);
		if (opts.key) {
			const name = uniqueName(names, opts.key, ".mov");
			await prepareVideo(ffmpeg, src, path.join(mediaDir, name), opts);
			return addMedia({ key: name, path: path.join(mediaDir, name), kind: "video" });
		}
		// prepareVideo clones exactly when `canCloneVideo` says so: only then keep the extension.
		// The timing is probed once here and handed on, so the source is demuxed once.
		const timing = await probeFrameTiming(ffmpeg, src).catch(() => undefined);
		const clone =
			opts.speed === 1 &&
			opts.startSec === undefined &&
			opts.endSec === undefined &&
			canCloneVideo(timing ?? null);
		const name = uniqueName(names, `${prefix}${parsed.name}`, clone ? parsed.ext : ".mov");
		const dst = path.join(mediaDir, name);
		await prepareVideo(ffmpeg, src, dst, { ...opts, timing });
		// What Resolve will find in the prepared file, whatever the source's own duration said.
		const prepared = await probeFrameTiming(ffmpeg, dst).catch(() => undefined);
		if (prepared && prepared.frames > 0) fileFrames.set(name, prepared.frames);
		return addMedia({ key: name, path: dst, kind: "video" });
	};

	const screenMedia = new Map<string, string>();
	for (const src of screenSources) {
		screenMedia.set(src, await videoMedia(src, "", { speed: 1 }));
		tick("screen");
	}
	const cameraMedia = new Map<string, string>();
	for (const src of cameraSources) {
		cameraMedia.set(src, await videoMedia(src, "cam-", { speed: 1 }));
		tick("camera");
	}

	/** Per segment: the media key its V2 clip and V3 clip play. */
	const segScreenKey = new Map<string, string>();
	const segCameraKey = new Map<string, string>();
	for (const seg of plan.segments) {
		if (!seg.retimed) {
			segScreenKey.set(seg.key, screenMedia.get(seg.mediaSourcePath) as string);
			if (seg.camera)
				segCameraKey.set(seg.key, cameraMedia.get(seg.camera.mediaSourcePath) as string);
			continue;
		}
		// Never ask for a range past the take's own duration, when it is known.
		const takeDuration = doc.assets.find(
			(a) => a.originalPath === seg.mediaSourcePath,
		)?.durationSec;
		const rangeEnd = takeDuration ? Math.min(seg.srcEndSec, takeDuration) : seg.srcEndSec;
		segScreenKey.set(
			seg.key,
			await videoMedia(seg.mediaSourcePath, "", {
				speed: seg.speed,
				startSec: seg.srcStartSec,
				endSec: rangeEnd,
				key: seg.key,
				// Exactly the plan's frames: a piece one frame short or long would shift its neighbours.
				frames: seg.frames,
			}),
		);
		tick("retime");
		if (seg.camera) {
			const clip = scene.clips[seg.clipIndex];
			const camStart = seg.srcStartSec - clip.webcamOffsetSec;
			const camEnd = rangeEnd - clip.webcamOffsetSec;
			// A camera that starts after this piece began (or ends before it) cannot be retimed
			// into a render that lines up: leave it out of this piece and say so.
			if (camStart < 0 || camEnd <= camStart) {
				warnings.push(`The camera is left out of the sped-up piece ${seg.key}: it starts late`);
				tick("retime");
				continue;
			}
			segCameraKey.set(
				seg.key,
				await videoMedia(seg.camera.mediaSourcePath, "", {
					speed: seg.speed,
					startSec: camStart,
					endSec: camEnd,
					key: seg.camera.key,
					frames: seg.camera.frames,
				}),
			);
			tick("retime");
		}
	}

	// Audio. A take with no audio stream makes ffmpeg fail: that take just has no A1 clip.
	const audioMedia = new Map<string, string | null>();
	const audioFailed = new Set<string>();
	for (const src of audioSources) {
		try {
			const name = uniqueName(names, path.parse(src).name, ".wav");
			const dst = path.join(mediaDir, name);
			await prepareWav(ffmpeg, src, dst, { speed: 1 });
			const frames = await probeAudioFrames(ffmpeg, dst).catch(() => 0);
			if (frames > 0) fileFrames.set(name, frames);
			audioMedia.set(src, addMedia({ key: name, path: dst, kind: "audio" }));
		} catch (error) {
			if (!(error instanceof NoAudioStreamError)) throw error;
			audioMedia.set(src, null);
			audioFailed.add(src);
			warnings.push(`No audio could be read from ${path.basename(src)}`);
		}
		tick("audio");
	}
	const audioKeyOf = new Map<string, string>();
	for (const a of plan.audio) {
		if (!a.retimed) {
			const key = audioMedia.get(a.sourcePath);
			if (key) audioKeyOf.set(a.key, key);
			continue;
		}
		if (audioFailed.has(a.sourcePath)) continue;
		try {
			const name = uniqueName(names, a.key, ".wav");
			// The voice piece knows its take, hence the take's duration.
			const takeDuration = doc.assets.find((x) => x.originalPath === a.takePath)?.durationSec;
			await prepareWav(ffmpeg, a.sourcePath, path.join(mediaDir, name), {
				speed: a.speed,
				startSec: a.srcStartSec,
				endSec: takeDuration ? Math.min(a.srcEndSec, takeDuration) : a.srcEndSec,
				frames: a.frames,
			});
			audioKeyOf.set(
				a.key,
				addMedia({ key: name, path: path.join(mediaDir, name), kind: "audio" }),
			);
		} catch (error) {
			if (!(error instanceof NoAudioStreamError)) throw error;
			audioFailed.add(a.sourcePath);
			warnings.push(`No audio could be read from ${path.basename(a.sourcePath)}`);
		}
		tick("audio");
	}

	// Background.
	const backgroundPath = path.join(mediaDir, "background.png");
	try {
		await backgroundStill(ffmpeg, scene.background, width, height, backgroundPath, {
			blur: scene.effects.blur > 0,
			resolveImagePath: deps.resolveImagePath,
		});
	} catch (error) {
		warnings.push(`The background could not be rendered (${messageOf(error)}); it is black`);
		await backgroundStill(
			ffmpeg,
			{ kind: "color", color: "#000000" },
			width,
			height,
			backgroundPath,
			{ blur: false, resolveImagePath: () => null },
		);
	}
	addMedia({ key: "background.png", path: backgroundPath, kind: "still" });
	tick("background");

	// Cursor atlas. No sprites (a stubbed or unresolved theme) means no atlas and no cursor.
	const sprites = Object.entries(resolvedScene.cursor?.cursorSprites ?? {})
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, s]) => ({
			name,
			path: s.path,
			hotspot: [s.hotspotX, s.hotspotY] as [number, number],
		}));
	const cursorsPng = path.join(folder, "cursors.png");
	let atlasPath: string | null = null;
	let kinds: CursorKind[] = [];
	if (sprites.length > 0) {
		try {
			kinds = (await cursorAtlas(ffmpeg, sprites, cursorsPng)).kinds;
			atlasPath = cursorsPng;
		} catch (error) {
			warnings.push(`The cursor could not be exported (${messageOf(error)})`);
		}
	}
	const kindNames = kinds.map((k) => k.name);
	tick("cursor");

	// 4. Data.
	const sizeCache = new Map<string, { w: number; h: number }>();
	const sizeOf = async (
		file: string,
		known: { width?: number; height?: number } | null | undefined,
	): Promise<{ w: number; h: number }> => {
		if (known?.width && known?.height) return { w: known.width, h: known.height };
		const cached = sizeCache.get(file);
		if (cached) return cached;
		const probed = (await probeVideoSize(ffmpeg, file)) ?? { w: 0, h: 0 };
		sizeCache.set(file, probed);
		return probed;
	};

	const screenDataPaths = new Map<string, string>();
	const cameraDataPaths = new Map<string, string>();
	const clipLayout = (clipIndex: number) => scene.layout.layoutByClip?.[clipIndex] ?? null;

	for (const seg of plan.segments) {
		const asset = doc.assets.find((a) => a.originalPath === seg.mediaSourcePath);
		const screenSize = await sizeOf(seg.mediaSourcePath, asset?.video);
		let camSize = { w: 0, h: 0 };
		if (seg.camera) {
			const camAsset = doc.assets.find(
				(a) => a.cameraTrack?.sourcePath === seg.camera?.mediaSourcePath,
			);
			camSize = await sizeOf(seg.camera.mediaSourcePath, camAsset?.cameraTrack);
		}
		const { frame0, times } = segmentSourceTimes(
			seg,
			FPS,
			seg.handleFrames,
			// The prepared file's real length when known, else the take's duration.
			fileFrames.get(segScreenKey.get(seg.key) ?? "") ??
				(asset?.durationSec ? framesOfSeconds(asset.durationSec, FPS) : undefined),
		);
		const cursorPath = seg.cursorPath && existsSync(seg.cursorPath) ? seg.cursorPath : null;
		const params: SampleParams = {
			renderW: width,
			renderH: height,
			screenW: screenSize.w,
			screenH: screenSize.h,
			webcamW: camSize.w,
			webcamH: camSize.h,
		};
		const sample = async (role: "screen" | "camera"): Promise<Float32Array> => {
			const out = await deps.sampleFrames(
				sceneJson,
				// Both roles: the camera steps aside when the pointer nears it.
				cursorPath,
				seg.clipIndex,
				role,
				times,
				kindNames,
				params,
			);
			if (!out || out.length !== times.length * DATA_STRIDE) {
				throw new Error(
					out
						? `The compositor returned ${out.length} numbers for ${times.length} frames of ${seg.key}`
						: "This build of the compositor cannot sample frames for the Resolve export",
				);
			}
			return out;
		};

		const layout = clipLayout(seg.clipIndex);
		const screenShadow = layout?.screenShadow ?? scene.effects.shadow;
		const screenData = writeDataFile(
			{
				role: "screen",
				fps: FPS,
				frame0,
				shadow: { opacity: 0.45 * screenShadow, spread: 40 / 1080, offsetY: 16 / 1080 },
				canvas: { w: width, h: height },
				...(atlasPath ? { cursor: { atlas: rel(atlasPath), kinds } } : {}),
			},
			await sample("screen"),
		);
		const screenDataPath = path.join(dataDir, `${seg.key}.lua`);
		await writeFile(screenDataPath, screenData, "utf8");
		tick("data");

		screenDataPaths.set(seg.key, rel(screenDataPath));

		if (seg.camera && segCameraKey.has(seg.key)) {
			const samples = await sample("camera");
			const frame0Cam = cameraFrame0(seg, frame0);
			// Samples for frames before the camera file starts do not exist.
			const drop = Math.max(0, -frame0Cam);
			// The compositor's own rule (compositor_macos.rs, camera shadow): no shadow under a block
			// preset, which welds the camera to the screen, nor under a cutout camera
			// ("transparent"). `screenCover` is not a block signal: format fill sets it on every
			// clip. A per-segment scene preset (segment looks) is not visible here: v1 uses the
			// project preset.
			const blockPreset =
				scene.layout.preset === "dual-frame" || scene.layout.preset === "vertical-stack";
			const cutout = scene.webcamEffect?.mode === "transparent";
			const hasCamera = layout ? layout.webcamRect != null : true;
			const pip = hasCamera && !blockPreset && !cutout;
			const camShadow = layout?.webcamShadow ?? scene.layout.webcamShadow ?? 0.35;
			const camData = writeDataFile(
				{
					role: "camera",
					fps: FPS,
					frame0: frame0Cam + drop,
					shadow: pip
						? { opacity: camShadow, spread: 32 / 1080, offsetY: 12 / 1080 }
						: { opacity: 0, spread: 32 / 1080, offsetY: 12 / 1080 },
					canvas: { w: width, h: height },
					mirror: layout?.webcamMirror ?? scene.layout.webcamMirror,
				},
				samples.subarray(Math.min(drop, times.length) * DATA_STRIDE),
			);
			const camDataPath = path.join(dataDir, `${seg.camera.key}.lua`);
			await writeFile(camDataPath, camData, "utf8");
			cameraDataPaths.set(seg.key, rel(camDataPath));
		}
		tick("data");
	}

	// 5. Overlay.
	let overlayKey: string | null = null;
	if (hasOverlay) {
		const overlayPath = path.join(mediaDir, "overlay.mov");
		try {
			const result = await deps.exportAlpha(
				buildNativeClipList(doc),
				overlayPath,
				JSON.stringify({ ...resolvedScene, overlayOnly: true, annotations: overlayAnnotations }),
				{ width, height, fps: FPS, ffmpegPath: ffmpeg },
				(frames) =>
					onProgress({
						step: "overlay",
						done: Math.min(done + frames / Math.max(1, plan.durationFrames), total),
						total,
					}),
			);
			if (result) overlayKey = addMedia({ key: "overlay.mov", path: overlayPath, kind: "video" });
			else warnings.push("The overlay (text and images) could not be exported; it is left out");
		} catch (error) {
			warnings.push(`The overlay could not be exported (${messageOf(error)}); it is left out`);
		}
		tick("overlay");
	}

	// 6. Manifest.
	const clips = planToManifestClips(plan, {
		backgroundKey: "background.png",
		screenKey: (seg) => segScreenKey.get(seg.key) as string,
		cameraKey: (seg) => segCameraKey.get(seg.key) ?? null,
		screenData: (seg) => screenDataPaths.get(seg.key) as string,
		cameraData: (seg) => cameraDataPaths.get(seg.key) ?? null,
		atlas: atlasPath ? rel(atlasPath) : null,
		overlayKey,
		audioKey: (a) => audioKeyOf.get(a.key) ?? null,
		mediaFrames: (key) => fileFrames.get(key),
	});
	await writeFile(
		path.join(folder, "timeline.lua"),
		writeTimelineManifest({
			name: doc.project.title,
			width,
			height,
			fps: FPS,
			media,
			clips,
		}),
		"utf8",
	);
	tick("manifest");

	// 7. Note the folder for the import script: only now that it is complete.
	await writeLastExport({ resolveUserDir: input.resolveUserDir, exportFolder: folder });
	onProgress({ step: "done", done: total, total });
	return { ok: true, folder, restartNeeded: install.restartNeeded, warnings };
}
