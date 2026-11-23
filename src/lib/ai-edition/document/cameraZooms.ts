/**
 * The camera lane's zooms, split once out of a document that has only the one list.
 *
 * Before the camera had a lane of its own, every zoom lived in `zoomRanges`, and a zoom on a
 * talking head or inside a camera-fullscreen moment was already a zoom of the camera. Those move
 * to `cameraZoomRanges`; the rest stay on the screen. Runs on RAW, untrusted input, so every
 * read is guarded, and only when the document has no `cameraZoomRanges` key at all (an empty
 * list counts as the answer), so a second load finds nothing to do. No `schemaVersion` bump.
 */

import type { AxcutAsset, AxcutDocument, AxcutZoomRegion } from "../schema";
import { coalesceRegionsForRuler } from "../timeline/timelineMap";
import { clipOfRegion, mainTakeIsCamera, regionOnTalkingHead } from "./cameraTake";

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec =>
	!!value && typeof value === "object" && !Array.isArray(value);

const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

/** A clip's look (or, without one, the project's) puts the camera on the whole frame. */
export function clipSceneIsCamera(clip: Rec, legacy: Rec | null): boolean {
	const look = isRec(clip.look) ? clip.look : null;
	const scene = look && "segmentScene" in look ? look.segmentScene : legacy?.segmentScene;
	return scene === "camera";
}

/**
 * The camera-fullscreen moments of `legacyEditor`, in ruler ms: the ones that say "camera",
 * touching ones merged into one. One row per clip a moment crosses is how they are stored.
 */
export function cameraMomentsOf(legacy: Rec | null): Array<{ startMs: number; endMs: number }> {
	const rawMoments = (
		Array.isArray(legacy?.cameraFullscreenRegions) ? legacy.cameraFullscreenRegions : []
	)
		.filter(isRec)
		// A region says "camera" unless it says otherwise (`CameraFullscreenRegion.scene`).
		.filter((region) => region.scene === undefined || region.scene === "camera")
		.filter((region) => finite(region.startMs) && finite(region.endMs))
		.map((region) => ({ startMs: region.startMs as number, endMs: region.endMs as number }))
		.sort((a, b) => a.startMs - b.startMs);
	const moments: Array<{ startMs: number; endMs: number }> = [];
	for (const m of rawMoments) {
		const last = moments.at(-1);
		if (last && m.startMs <= last.endMs + 1) last.endMs = Math.max(last.endMs, m.endMs);
		else moments.push({ ...m });
	}
	return moments;
}

/**
 * Where a zoom of the camera layer looks until it is told otherwise: the face, else the upper
 * middle, where the camera closed in before it had a lane of its own. A fresh object each time.
 */
export function cameraZoomDefaultFocus(): { focus: { cx: number; cy: number }; focusMode: "auto" } {
	return { focus: { cx: 0.5, cy: 0.4 }, focusMode: "auto" };
}

export function splitZoomsIntoCameraLane(raw: Rec): Rec {
	if ("cameraZoomRanges" in raw) return raw;
	if (!Array.isArray(raw.zoomRanges)) return { ...raw, cameraZoomRanges: [] };

	const assets = new Map<string, Rec>();
	for (const asset of Array.isArray(raw.assets) ? raw.assets : []) {
		if (isRec(asset) && typeof asset.id === "string") assets.set(asset.id, asset);
	}
	const timeline = isRec(raw.timeline) ? raw.timeline : {};
	const clips = (Array.isArray(timeline.clips) ? timeline.clips : []).filter(isRec);
	const legacy = isRec(raw.legacyEditor) ? raw.legacyEditor : null;

	const clipIsTalkingHead = (clip: Rec): boolean =>
		typeof clip.assetId === "string" &&
		assets.has(clip.assetId) &&
		// Only the fields the rule reads, taken as they are stored.
		mainTakeIsCamera(assets.get(clip.assetId) as unknown as AxcutAsset);

	const clipShowsCamera = (clip: Rec): boolean => clipSceneIsCamera(clip, legacy);

	// A zoom and a moment are stored as one row per clip they cross, so they are judged as the
	// pills the ruler draws: whole, never row by row.
	const moments = cameraMomentsOf(legacy);

	const clipOf = (zoom: Rec): Rec | undefined => {
		if (typeof zoom.clipId === "string") {
			const anchored = clips.find((clip) => clip.id === zoom.clipId);
			if (anchored) return anchored;
		}
		if (!finite(zoom.startMs)) return undefined;
		const sec = zoom.startMs / 1000;
		return clips.find(
			(clip) =>
				finite(clip.timelineStartSec) &&
				finite(clip.timelineEndSec) &&
				clip.timelineStartSec <= sec &&
				sec < clip.timelineEndSec,
		);
	};

	const onCameraClip = (zoom: Rec): boolean => {
		const clip = clipOf(zoom);
		return !!clip && (clipIsTalkingHead(clip) || clipShowsCamera(clip));
	};

	const zoomRows = raw.zoomRanges.filter(
		(zoom): zoom is Rec => isRec(zoom) && finite(zoom.startMs) && finite(zoom.endMs),
	);
	const cameraIds = new Set<string>();
	for (const pill of coalesceRegionsForRuler(
		zoomRows as unknown as Array<{ id: string; startMs: number; endMs: number }>,
	)) {
		const rows = zoomRows.filter((zoom) => pill.ids.includes(zoom.id as string));
		const startMs = Math.round(pill.start * 1000);
		const endMs = Math.round(pill.end * 1000);
		const camera =
			rows.every(onCameraClip) ||
			moments.some((moment) => startMs >= moment.startMs && endMs <= moment.endMs);
		if (camera) for (const id of pill.ids) cameraIds.add(id);
	}

	const screen: unknown[] = [];
	const camera: unknown[] = [];
	for (const zoom of raw.zoomRanges) {
		if (!(isRec(zoom) && typeof zoom.id === "string" && cameraIds.has(zoom.id))) {
			screen.push(zoom);
			continue;
		}
		// While the camera filled the frame it ignored a zoom's focus (a screen point, often a
		// click) and closed in on the upper middle: that is what it keeps doing, on Auto. A talking
		// head's zoom already zoomed that picture, on its own focus, and keeps it.
		const clip = clipOf(zoom);
		camera.push(clip && clipIsTalkingHead(clip) ? zoom : { ...zoom, ...cameraZoomDefaultFocus() });
	}
	return { ...raw, zoomRanges: screen, cameraZoomRanges: camera };
}

/**
 * A take that turns out to be a talking head once its face is first written (`face` goes from
 * absent to a value, `null` included): its picture is the camera, and the scene drops a screen
 * zoom over it. Its screen zooms move to the camera lane, as the load-time split moves a talking
 * head's: whole pills that sit only on these takes, with their focus, which already framed that
 * picture. A pill that would overlap a camera zoom already there stays where it is: two camera
 * zooms never overlap. Returns the document itself when nothing moves.
 */
export function moveTakesZoomsToCameraLane(
	document: AxcutDocument,
	assetIds: ReadonlySet<string>,
): AxcutDocument {
	// Only a take that is now a talking head: a screen take's zooms never go to the camera.
	const heads = new Set(
		document.assets
			.filter((asset) => assetIds.has(asset.id) && mainTakeIsCamera(asset))
			.map((asset) => asset.id),
	);
	if (heads.size === 0 || document.zoomRanges.length === 0) return document;
	const clips = document.timeline.clips;
	const onTheseTakes = (zoom: AxcutZoomRegion): boolean => {
		const clip = clipOfRegion(clips, zoom);
		return !!clip && heads.has(clip.assetId);
	};
	const camera = coalesceRegionsForRuler(document.cameraZoomRanges ?? []);
	const moving = new Set<string>();
	for (const pill of coalesceRegionsForRuler(document.zoomRanges)) {
		const rows = document.zoomRanges.filter((zoom) => pill.ids.includes(zoom.id));
		if (!rows.every(onTheseTakes)) continue;
		if (camera.some((other) => other.start < pill.end && other.end > pill.start)) continue;
		for (const id of pill.ids) moving.add(id);
	}
	if (moving.size === 0) return document;
	return {
		...document,
		zoomRanges: document.zoomRanges.filter((zoom) => !moving.has(zoom.id)),
		cameraZoomRanges: [
			...(document.cameraZoomRanges ?? []),
			...document.zoomRanges.filter((zoom) => moving.has(zoom.id)),
		] as AxcutDocument["cameraZoomRanges"],
	};
}

/**
 * A 3D-tilted zoom (`rotationPreset`) is in the project: a screen zoom's, or a camera zoom on a
 * talking head, which renders on the main picture and keeps its rotation. A zoom of the camera
 * layer has none (`sceneDescription` sends it flat). What offers the depth of field.
 */
export function documentHasTiltedZoom(document: AxcutDocument): boolean {
	return (
		document.zoomRanges.some((zoom) => zoom.rotationPreset != null) ||
		(document.cameraZoomRanges ?? []).some(
			(zoom) => zoom.rotationPreset != null && regionOnTalkingHead(document, zoom),
		)
	);
}
