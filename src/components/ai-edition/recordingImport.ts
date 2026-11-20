// Hand-off from the recorder to the editor.
//
// The HUD parks the recording it just finished in ONE main-process slot
// (`set/getCurrentRecordingSession`) and opens the editor, which imports it into
// a fresh project on mount. The slot has to be emptied once that project owns
// the file, because opening the editor destroys and recreates its window
// (`createEditorWindowWrapper` in electron/main.ts) — so a session left in place
// is imported AGAIN on the next open: a second project on the same recording,
// back at the default padding / roundness / wallpaper, while everything the user
// set and saved stays behind in the first project, which is no longer the one on
// screen. That reads exactly like "the editor forgot my settings" (#364).
//
// `setCurrentRecordingSession(null)` is the existing clear (it also drops the
// derived `currentVideoPath`); the only renderer that still needs the session
// after this point is the CLI runner, which lives in its own process.

import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { createId } from "@/lib/ai-edition/document/ids";
import { clipAwaitsProbedDuration, insertAssetClip, placeSceneTake } from "@/lib/ai-edition/document/timeline";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import {
	DOCUMENT_SAVES_WAIT_TIMEOUT_MS,
	saveWithDeadline,
	useProjectStore,
	waitForDocumentSaves,
} from "@/lib/ai-edition/store/projectStore";
import {
	appendAutoZoomSuggestions,
	collectAutoZoomSuggestionsForLatestDocument,
} from "@/lib/ai-edition/timeline/apply-auto-zooms";
import { probeVideoDuration } from "@/lib/ai-edition/timeline/duration";
import {
	type TakeMark,
	type TakeSegment,
	takeSegments,
} from "@/lib/ai-edition/timeline/takeSegments";
import { nativeBridgeClient } from "@/native/client";

// Fresh recordings used to get cursor-dwell zooms on load (legacy editor
// `autoZoomEnabled`, default on). The ai-edition import only seeded a clip, so
// the wand still worked but a new take landed un-zoomed. This flag is the
// one-shot hand-off: set as soon as the asset is on the document, then taken on
// the first pass that can give a real answer -- zooms written, no click in the
// sidecar, or the toggle is off. What keeps it set is only ever "not enough of
// the document yet" (no clips, still the placeholder duration), and the
// `loadedmetadata` write is what comes back when that resolves.
//
// The recording path is what scopes it: `importPendingRecording` always has one,
// and it is what stops a flag left over from a take with nothing to zoom from
// decorating the next document loaded in the same window. A successful save
// records the project id so a later undo or delete cannot silently re-seed it.
let pendingFreshRecordingAutoZoom = false;
let pendingFreshRecordingAutoZoomPath: string | null = null;
let appliedFreshRecordingAutoZoomProjectId: string | null = null;
let freshRecordingAutoZoomSaveChain: Promise<void> = Promise.resolve();

const TAKE_TARGET_KEY = "filmareto.takeTargetProject";

/**
 * The project the next recording joins as a take, or null for a project of its own. Stored rather
 * than held: the editor window is destroyed while the recording runs. It outlives one cancelled
 * start, and the next recording from the bar joins the same project, as it was asked to.
 */
export function setTakeTargetProject(projectId: string | null): void {
	try {
		if (projectId) localStorage.setItem(TAKE_TARGET_KEY, projectId);
		else localStorage.removeItem(TAKE_TARGET_KEY);
	} catch {
		// Without storage the take gets a project of its own, which loses nothing.
	}
}

function takeTargetProject(): string | null {
	try {
		const projectId = localStorage.getItem(TAKE_TARGET_KEY);
		localStorage.removeItem(TAKE_TARGET_KEY);
		return projectId;
	} catch {
		return null;
	}
}

/** Where the teleprompter changed segment during the take that just ended. */
async function readTakeMarks(): Promise<TakeMark[]> {
	const teleprompter = (
		window.electronAPI as unknown as
			| { teleprompter?: { takeMarks?: () => Promise<TakeMark[]> } }
			| undefined
	)?.teleprompter;
	try {
		return (await teleprompter?.takeMarks?.()) ?? [];
	} catch {
		// No teleprompter on this platform: the take stays one clip.
		return [];
	}
}

/** The take's clips at the end of the open project. Knows the real length, so records it too. */
async function placeTakeClips(
	assetId: string,
	durationSec: number,
	segments: {
		startSec: number;
		endSec: number;
		segment?: number;
		earlier?: { startSec: number; endSec: number }[];
	}[],
): Promise<boolean> {
	const current = useProjectStore.getState().document;
	if (!current) return false;
	let next: AxcutDocument = {
		...current,
		assets: current.assets.map((asset) =>
			asset.id === assetId ? { ...asset, durationSec } : asset,
		),
	};
	for (const { startSec, endSec, segment, earlier } of segments) {
		next = insertAssetClip(next, next.timeline.clips.length, {
			id: createId("clip"),
			assetId,
			sourceStartSec: startSec,
			sourceEndSec: endSec,
			origin: "user",
			reason: segment === undefined ? "New take" : `Segment ${segment + 1}`,
			...(segment === undefined ? {} : { segmentId: createId("segment") }),
			...(earlier?.length
				? {
						alternates: earlier.map((take) => ({
							sourceStartSec: take.startSec,
							sourceEndSec: take.endSec,
						})),
					}
				: {}),
		});
	}
	// Not an edit: the user finished a recording. An undo here would take the take away.
	return useProjectStore.getState().saveDocument(next, { history: false });
}

/** Puts the recording at the end of an existing project. False: no such project any more. */
async function appendTake(
	projectId: string,
	screenPath: string,
	label: string,
	segments: TakeSegment[],
): Promise<boolean> {
	await useProjectStore.getState().loadProject(projectId);
	const store = useProjectStore.getState();
	if (store.projectId !== projectId || !store.document) return false;
	const asset = await store.addAsset(screenPath, label);
	if (!asset) return false;
	const durationSec =
		segments.at(-1)?.endSec ??
		(await probeVideoDuration(toFileUrl(screenPath))) ??
		asset.durationSec ??
		60;
	return placeTakeClips(
		asset.id,
		durationSec,
		segments.length > 0 ? segments : [{ startSec: 0, endSec: durationSec }],
	);
}

/** The takes of a run of scenes, each in its scene's place. False: no such project any more. */
async function importSceneRun(run: {
	projectId: string | null;
	scenes: { id: string }[];
	takes: {
		session: { screenVideoPath?: string; cursorCaptureMode?: string } | null;
		marks: TakeMark[];
	}[];
}): Promise<boolean> {
	if (run.projectId) await useProjectStore.getState().loadProject(run.projectId);
	if (!useProjectStore.getState().document) return false;
	const sceneOrder = run.scenes.map((scene) => scene.id);
	for (const { session, marks } of run.takes) {
		const path = session?.screenVideoPath;
		if (!path) continue;
		const label = path.split(/[\\/]/).pop() || "Recording";
		const asset = await useProjectStore.getState().addAsset(path, label);
		if (!asset) continue;
		const durationSec = (await probeVideoDuration(toFileUrl(path))) ?? asset.durationSec ?? 60;
		const split = takeSegments(marks, durationSec);
		// One scene from start to stop, unless Next was pressed while it ran.
		const parts: TakeSegment[] =
			split.length > 0
				? split
				: [{ startSec: 0, endSec: durationSec, segment: marks[0]?.segment ?? 0, earlier: [] }];
		await waitForDocumentSaves();
		let next = useProjectStore.getState().document as AxcutDocument;
		// The editor's own background writes started before this file was added, and one landing
		// after it writes the project back without the file. An older take would then point at nothing.
		if (!next.assets.some((other) => other.id === asset.id)) {
			next = { ...next, assets: [...next.assets, asset] };
		}
		next = {
			...next,
			assets: next.assets.map((other) =>
				other.id === asset.id ? { ...other, durationSec } : other,
			),
		};
		for (const part of parts) {
			const sceneId = sceneOrder[part.segment];
			if (!sceneId) continue;
			next = placeSceneTake(
				next,
				{
					clipId: createId("clip"),
					sceneId,
					assetId: asset.id,
					startSec: part.startSec,
					endSec: part.endSec,
					earlier: part.earlier,
				},
				sceneOrder,
			);
		}
		await useProjectStore.getState().saveDocument(next, { history: false });
		if (session?.cursorCaptureMode !== "system") {
			markFreshRecordingAutoZoomPending(path);
			await maybeSaveFreshRecordingAutoZooms(next);
		}
	}
	await window.electronAPI.setCurrentRecordingSession(null);
	return true;
}

export function markFreshRecordingAutoZoomPending(assetPath: string): void {
	pendingFreshRecordingAutoZoom = true;
	pendingFreshRecordingAutoZoomPath = assetPath;
	appliedFreshRecordingAutoZoomProjectId = null;
}

function clearFreshRecordingAutoZoomPending(): void {
	pendingFreshRecordingAutoZoom = false;
	pendingFreshRecordingAutoZoomPath = null;
}

export function consumeFreshRecordingAutoZoomPending(): boolean {
	const was = pendingFreshRecordingAutoZoom;
	clearFreshRecordingAutoZoomPending();
	appliedFreshRecordingAutoZoomProjectId = null;
	freshRecordingAutoZoomSaveChain = Promise.resolve();
	return was;
}

export type ApplyFreshRecordingAutoZoomsDeps = {
	enabled?: boolean;
	getTelemetry?: (videoPath: string) => Promise<CursorTelemetryPoint[] | null | undefined>;
	createId?: (prefix: string) => string;
	/** Deadline for this path's own write. Tests use a short one. */
	saveTimeoutMs?: number;
	/** Deadline for waiting on writes somebody else started. Tests shorten it. */
	waitTimeoutMs?: number;
	/** Deadline for the auto-zoom preference read. Tests shorten it. */
	prefsTimeoutMs?: number;
};

/**
 * The user's standing answer, read fresh rather than cached: the toggle lives in the
 * editor's rec panel and the HUD publishes prefs changes across windows, so the value
 * can change between one take and the next within a single renderer.
 *
 * An unreachable or throwing bridge reads as ON, which is what every installation did
 * before the preference existed — a failed IPC call must not silently turn a feature off.
 *
 * Bounded for the same reason the write below is: this runs inside
 * `freshRecordingAutoZoomSaveChain`, which `runLoadedMetadataWrite` awaits, so a main
 * process that accepts the invoke and never answers would hold that queue slot — and
 * every metadata write behind it — for the life of the renderer. `invoke` rejects on a
 * throwing handler but never on a silent one, so the `catch` above cannot cover this.
 * A deadline that expires says only "no answer yet", which reads as ON like every other
 * unreadable answer.
 */
async function readAutoZoomPref(timeoutMs = DOCUMENT_SAVES_WAIT_TIMEOUT_MS): Promise<boolean> {
	try {
		const read = (async () => {
			const prefs = await window.electronAPI?.getRecordingPrefs?.();
			return prefs?.autoZoomEnabled !== false;
		})();
		const settled = await saveWithDeadline(read, timeoutMs);
		return settled === "timeout" ? true : settled;
	} catch {
		return true;
	}
}

function isPendingFreshRecordingAsset(asset: { originalPath?: string | null }): boolean {
	return asset.originalPath === pendingFreshRecordingAutoZoomPath;
}

function pendingFreshRecordingAsset(document: AxcutDocument) {
	return document.assets.find(isPendingFreshRecordingAsset);
}

/**
 * Whether the pending take's real length has landed yet.
 *
 * Not just `asset.durationSec != null`. A recording whose container reports no
 * duration (MediaRecorder WebM, until the EBML fix) still gets the placeholder
 * written to that field, because the timeline layer clamps every interval it
 * builds against `primaryAssetDuration` and would otherwise drop every clip. So
 * the asset says "60" for a take nothing has measured, and the clips are what
 * distinguish the two: one still sitting at the placeholder length is waiting.
 *
 * The cost is a take of exactly 60.000 s never being auto-zoomed. That is the
 * same ambiguity `applyProbedDuration` already lives with, and it is a far
 * smaller price than suggesting zooms against a length nothing measured.
 */
function hasProbedDurationForPendingAsset(document: AxcutDocument): boolean {
	const asset = pendingFreshRecordingAsset(document);
	if (
		asset == null ||
		asset.durationSec == null ||
		!Number.isFinite(asset.durationSec) ||
		asset.durationSec <= 0
	) {
		return false;
	}
	return !document.timeline.clips.some((clip) => clipAwaitsProbedDuration(clip, asset.id));
}

/** Whether this take already has zooms. A project's earlier takes keeping theirs does not count. */
function takeHasZooms(document: AxcutDocument): boolean {
	const zooms = document.zoomRanges ?? [];
	const asset = pendingFreshRecordingAsset(document);
	if (!asset) return zooms.length > 0;
	const others = new Set(
		document.timeline.clips.filter((clip) => clip.assetId !== asset.id).map((clip) => clip.id),
	);
	return zooms.some((zoom) => !zoom.clipId || !others.has(zoom.clipId));
}

function canApplyFreshRecordingAutoZooms(document: AxcutDocument): boolean {
	if (!pendingFreshRecordingAutoZoom) return false;
	if (appliedFreshRecordingAutoZoomProjectId === document.project.id) return false;
	if (takeHasZooms(document)) return false;
	if ((document.timeline?.clips?.length ?? 0) === 0) return false;
	if (!hasProbedDurationForPendingAsset(document)) return false;
	return document.assets.some(isPendingFreshRecordingAsset);
}

/** Zooms are on the document already -- the wand ran, or a redo brought them back.
 *  The take is decorated, so the hand-off is spent for this project. */
function markDecoratedIfZoomed(document: AxcutDocument): boolean {
	if (!takeHasZooms(document)) return false;
	clearFreshRecordingAutoZoomPending();
	appliedFreshRecordingAutoZoomProjectId = document.project.id;
	return true;
}

function liveDocument(fallback: AxcutDocument): AxcutDocument {
	return useProjectStore.getState().document ?? fallback;
}

export async function applyPendingFreshRecordingAutoZooms(
	document: AxcutDocument,
	deps: ApplyFreshRecordingAutoZoomsDeps = {},
): Promise<AxcutDocument> {
	if (!pendingFreshRecordingAutoZoom) return document;
	if (appliedFreshRecordingAutoZoomProjectId === document.project.id) {
		clearFreshRecordingAutoZoomPending();
		return document;
	}
	const enabled = deps.enabled ?? (await readAutoZoomPref(deps.prefsTimeoutMs));
	const start = liveDocument(document);
	// The read yields. A project opened meanwhile is not this take's to decorate, and
	// not the place to spend its hand-off either: the pass that comes back with it will.
	if (start.project.id !== document.project.id) return start;
	if (!enabled) {
		clearFreshRecordingAutoZoomPending();
		return start;
	}
	if (markDecoratedIfZoomed(start)) return start;
	if (!canApplyFreshRecordingAutoZooms(start)) return start;

	const inner =
		deps.getTelemetry ?? ((videoPath: string) => nativeBridgeClient.cursor.getTelemetry(videoPath));
	let telemetryFailed = false;
	const getTelemetry = async (videoPath: string) => {
		try {
			return await inner(videoPath);
		} catch {
			// An unreadable sidecar is NOT the same answer as an empty one: it says
			// nothing about whether this take has a click, so pending survives it and a
			// later `loadedmetadata` for the same take gets another go.
			telemetryFailed = true;
			return [];
		}
	};
	// The wand's own collect path, scoped to the take this hand-off is about: read the
	// document, collect, and collect again if the clips moved while the telemetry was
	// being read. Sharing it is the point -- the suggestions carry TIMELINE spans and
	// `appendAutoZoomSuggestions` anchors them against whatever the store holds at write
	// time, so the two callers must agree on when a collected set has gone stale.
	//
	// The reader re-runs every guard, so a project switch, a wand run or a delete
	// landing during the wait ends the pass exactly where the retry would have started.
	const collected = await collectAutoZoomSuggestionsForLatestDocument(
		() => {
			const live = liveDocument(start);
			if (live.project.id !== start.project.id) return null;
			if (markDecoratedIfZoomed(live)) return null;
			return canApplyFreshRecordingAutoZooms(live) ? live : null;
		},
		getTelemetry,
		isPendingFreshRecordingAsset,
	);
	if (!collected) return liveDocument(start);
	if (collected.suggestions.length === 0) {
		// A real answer, not a race: the stop handler awaits `writePendingCursorTelemetry`
		// BEFORE it publishes the session, so by the time the editor can import the take
		// its sidecar is on disk. An empty read therefore means this take has no click to
		// zoom, and no amount of retrying changes that -- consume the hand-off rather than
		// leaving it armed for the next document loaded in this window.
		if (!telemetryFailed) clearFreshRecordingAutoZoomPending();
		return collected.document;
	}
	return appendAutoZoomSuggestions(
		collected.document,
		collected.suggestions,
		deps.createId ?? createId,
	);
}

export async function maybeSaveFreshRecordingAutoZooms(
	document: AxcutDocument,
	deps: ApplyFreshRecordingAutoZoomsDeps = {},
): Promise<boolean> {
	/** `"contended"`: a user write landed on the snapshot this attempt built from, so
	 *  it decided nothing and is worth repeating against the settled document. */
	const writeFreshRecordingAutoZooms = async (): Promise<boolean | "contended"> => {
		try {
			// A wait that times out has told us nothing about what is on disk, so the
			// only safe move is to abandon this attempt with pending still set, and let
			// a later `loadedmetadata` for this take rebase onto whatever the stuck save
			// eventually leaves.
			if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return false;
			const latest = liveDocument(document);
			const next = await applyPendingFreshRecordingAutoZooms(latest, deps);
			if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return false;
			const current = liveDocument(document);
			if (current.project.id !== latest.project.id) return false;
			if (takeHasZooms(current)) {
				appliedFreshRecordingAutoZoomProjectId = current.project.id;
				clearFreshRecordingAutoZoomPending();
				return false;
			}
			// Contention means start over, not rebase. If the document moved while the
			// suggestion pass ran, this attempt is working from a snapshot that is
			// already history — writing `next` over the newer one would take the user's
			// edit with it. Drop it and let the repeat below re-collect from scratch,
			// after `waitForDocumentSaves` has seen that writer finish.
			if (current !== latest) return "contended";
			// Nothing to write: the pass returned the document it was given, because a
			// guard refused it or the take has no click.
			if (next === latest) return false;
			const saved = await saveWithDeadline(
				useProjectStore.getState().saveDocument(next, { history: true }),
				deps.saveTimeoutMs ?? DOCUMENT_SAVES_WAIT_TIMEOUT_MS,
			);
			// The write never answered. Keep pending and let go of the chain, so nothing
			// queues behind a promise that is not coming back.
			if (saved === "timeout") return false;
			// A trim (or any other edit) can start after this save was submitted and
			// still be in flight when it returns: `waitForDocumentSaves` before the
			// write only sees saves that have already begun. Wait again, then look at
			// the store — if that later write landed on the unzoomed snapshot, keep
			// pending. A timeout here says the same thing for a different reason: we
			// cannot tell what landed, so do not clear pending.
			if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return saved;
			const stored = useProjectStore.getState().document;
			if (saved && stored && takeHasZooms(stored)) {
				appliedFreshRecordingAutoZoomProjectId = stored.project.id;
				clearFreshRecordingAutoZoomPending();
			}
			return saved;
		} catch (error) {
			// `saveDocument` reports failure by returning false, so anything thrown
			// here came from the suggestion pass or a bridge call. Pending stays set and
			// the path goes quiet — log it, or it is invisible.
			console.warn("[recording] fresh-recording auto-zoom write failed:", error);
			return false;
		}
	};
	// One repeat, not a loop: a user who keeps editing through the telemetry wait keeps
	// invalidating the attempt, and the honest answer there is the wand, not spinning.
	const attemptFreshRecordingAutoZooms = async (): Promise<boolean> => {
		const first = await writeFreshRecordingAutoZooms();
		if (first !== "contended") return first;
		const second = await writeFreshRecordingAutoZooms();
		return second === "contended" ? false : second;
	};
	const done = freshRecordingAutoZoomSaveChain.then(
		attemptFreshRecordingAutoZooms,
		attemptFreshRecordingAutoZooms,
	);
	freshRecordingAutoZoomSaveChain = done.then(
		() => undefined,
		() => undefined,
	);
	return done;
}

/**
 * Imports the recording the HUD handed over into a new project, and consumes the
 * hand-off so it is imported exactly once.
 *
 * Returns false when there is nothing pending — the caller then falls back to
 * reopening the most recent project. "take" when it joined an existing project as a
 * take (`setTakeTargetProject`), which leaves the rest of that project as it was. Throws
 * if the import itself fails, leaving the session in place so a later mount can retry it.
 */
export async function importPendingRecording(
	/**
	 * Called once the import succeeded, with why the take ended before it was
	 * stopped when it did. The HUD that ran the stop closes as the editor opens, so
	 * the editor is the only window left to say it.
	 */
	onWarning?: (message: string) => void,
): Promise<boolean | "take"> {
	const api = window.electronAPI;
	if (!api) return false;

	const run = await api.teleprompter?.takeRun?.().catch(() => null);
	if (run?.takes.length && (await importSceneRun(run))) return "take";

	const result = await api.getCurrentRecordingSession();
	const screenPath = result.success ? result.session?.screenVideoPath : undefined;
	const takeTarget = takeTargetProject();
	if (!screenPath) return false;
	const cursorCaptureMode = result.success ? result.session?.cursorCaptureMode : undefined;
	const warning = result.success ? result.warning : undefined;

	const label = screenPath.split(/[\\/]/).pop() || "Recording";
	const marks = await readTakeMarks();
	const takeDurationSec = marks.length > 1 ? await probeVideoDuration(toFileUrl(screenPath)) : null;
	const segments = takeDurationSec ? takeSegments(marks, takeDurationSec) : [];
	if (takeTarget && (await appendTake(takeTarget, screenPath, label, segments))) {
		if (cursorCaptureMode !== "system") markFreshRecordingAutoZoomPending(screenPath);
		await api.setCurrentRecordingSession(null);
		const document = useProjectStore.getState().document;
		if (document) await maybeSaveFreshRecordingAutoZooms(document);
		if (warning) onWarning?.(warning);
		return "take";
	}
	await useProjectStore.getState().createProject(`Recording ${new Date().toLocaleString()}`);
	const asset = await useProjectStore.getState().addAsset(screenPath, label);
	// Mark before the video element can fire `loadedmetadata`. The asset path is
	// already on the document; waiting until the 60s seed finished let the first
	// metadata pass consume nothing and the second never arrive.
	//
	// Except for a system-cursor take, which writes no `.cursor.json` at all: the
	// toggle stays on in prefs (it is only disabled in the UI while that mode is
	// picked), so without this the flag is set for a recording that can never produce
	// a click. What governs is the mode THIS take was recorded in, not the current
	// preference.
	if (cursorCaptureMode !== "system") {
		markFreshRecordingAutoZoomPending(screenPath);
	}
	// Consumed: the recording now lives in a project. Cleared here rather than
	// after the timeline seed below so a failure down there can't hand the same
	// recording to the next editor window.
	await api.setCurrentRecordingSession(null);

	// ponytail: MediaRecorder WebMs ship with duration = NaN until
	// fix-webm-duration patches the EBML header; until that flows through the
	// asset, drop a default 60s clip into the timeline so the editor isn't stuck
	// on "No clips yet" the moment the user lands in the project. Real duration
	// overwrites this when handleLoadedMetadata fires with a finite value.
	if (asset && takeDurationSec && segments.length > 0) {
		await placeTakeClips(asset.id, takeDurationSec, segments);
	}
	const doc = useProjectStore.getState().document;
	if (doc && doc.timeline.clips.length === 0 && doc.assets.length > 0) {
		// `history: false`. Nothing here is an edit: the user finished a recording and the
		// editor built them a project around it, unattended, on mount. Recording it left a
		// brand-new project sitting at `past.length === 1` before the user had touched
		// anything, so their FIRST Ctrl+Z restored the state before the seed -- an empty
		// timeline -- and the persist that follows an undo wrote that empty timeline to disk.
		await useProjectStore
			.getState()
			.replaceTimeline([{ startSec: 0, endSec: 60 }], "Auto-imported recording", {
				history: false,
			});
	}
	const latest = useProjectStore.getState().document;
	if (latest) {
		await maybeSaveFreshRecordingAutoZooms(latest);
	}
	if (warning) {
		onWarning?.(warning);
	}
	return true;
}
