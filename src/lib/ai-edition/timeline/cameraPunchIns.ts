// The camera's auto zooms: at each cut inside a stretch where the camera fills the frame, every
// other clip is pushed in. Pure: it reads the document and returns the zooms to add.

import { mainTakeIsCamera } from "../document/cameraTake";
import { cameraMomentsOf, clipSceneIsCamera } from "../document/cameraZooms";
import { createId } from "../document/ids";
import type { AxcutClip, AxcutDocument, AxcutZoomRegion } from "../schema";
import { keptRawSpans, type RawSpan } from "./programme-time";
import { anchorRegionsWithDerivedMs } from "./timelineMap";

/** How this rule's zooms are told from yours, so that a second run replaces only them. */
export const CAMERA_PUNCH_IN_PREFIX = "cpunch";

/** 1.5×. */
const PUNCH_IN_DEPTH = 2 as const;
/** Two clips touch when the ruler gap between them is under this (whole-ms storage). */
const TOUCH_SEC = 0.002;

export const isCameraPunchIn = (zoom: { id: string }): boolean =>
	zoom.id.startsWith(`${CAMERA_PUNCH_IN_PREFIX}_`);

/**
 * A run is consecutive pieces of footage, end to start, whose picture is the camera filling the
 * frame: a talking head, a clip whose scene is the camera, or a clip wholly inside a
 * camera-fullscreen moment. A piece is a clip, or the stretch of one between two trim holes: the
 * ruler pieces `keptRawSpans` gives. Yapping, smart cuts and trims cut inside a clip, and a trim
 * hole is a cut like the one between two clips, so the run goes on across it, and across a clip
 * trimmed away whole. The first piece of a run stays wide; the 2nd, 4th... are pushed in, each for
 * exactly its own ruler span, held at full scale (`motion: "hold"`) so it cuts in and out with its
 * piece. A piece that already has a camera zoom not made by this rule is left as it is, and the
 * rhythm goes on as if it had been pushed in.
 */
export function planCameraPunchIns(
	document: AxcutDocument,
	makeId: () => string = () => createId(CAMERA_PUNCH_IN_PREFIX),
): AxcutZoomRegion[] {
	const clips = [...document.timeline.clips].sort(
		(a, b) => a.timelineStartSec - b.timelineStartSec,
	);
	const trims = document.timeline.trimRanges ?? [];
	const assetById = new Map(document.assets.map((asset) => [asset.id, asset]));
	const legacy = (document.legacyEditor ?? null) as Record<string, unknown> | null;
	const moments = cameraMomentsOf(legacy);
	const theirs = (document.cameraZoomRanges ?? []).filter((zoom) => !isCameraPunchIn(zoom));

	const fillsTheFrame = (clip: AxcutClip): boolean => {
		if (mainTakeIsCamera(assetById.get(clip.assetId))) return true;
		if (clipSceneIsCamera(clip as unknown as Record<string, unknown>, legacy)) return true;
		const startMs = Math.round(clip.timelineStartSec * 1000);
		const endMs = Math.round(clip.timelineEndSec * 1000);
		return moments.some((m) => startMs >= m.startMs - 1 && endMs <= m.endMs + 1);
	};
	const hasZoomOfItsOwn = (piece: RawSpan): boolean => {
		const startMs = piece.startSec * 1000;
		const endMs = piece.endSec * 1000;
		return theirs.some((zoom) => zoom.startMs < endMs && zoom.endMs > startMs);
	};

	const out: AxcutZoomRegion[] = [];
	// Whether the previous piece of the run is pushed in, or skipped because it has a zoom of its
	// own: a skipped piece counts as pushed in, so the rhythm goes on.
	let previousPushed = false;
	// The last clip of the run, pieces or none: where the next clip has to start to go on with it.
	let previous: AxcutClip | null = null;
	for (const clip of clips) {
		if (!fillsTheFrame(clip) || clip.timelineEndSec <= clip.timelineStartSec) {
			previousPushed = false;
			previous = null;
			continue;
		}
		const touches: boolean =
			previous !== null && clip.timelineStartSec - previous.timelineEndSec <= TOUCH_SEC;
		previous = clip;
		keptRawSpans([clip], trims).forEach((piece, index) => {
			// Inside a clip, the piece before is always the run's: a trim hole is a cut.
			const continues = index > 0 || touches;
			const wantsPunch = continues && !previousPushed;
			if (hasZoomOfItsOwn(piece)) {
				previousPushed = true;
				return;
			}
			previousPushed = wantsPunch;
			if (!wantsPunch) return;
			out.push(
				...(anchorRegionsWithDerivedMs(
					[
						{
							id: makeId(),
							startMs: Math.round(piece.startSec * 1000),
							endMs: Math.round(piece.endSec * 1000),
							depth: PUNCH_IN_DEPTH,
							focus: { cx: 0.5, cy: 0.4 },
							focusMode: "auto" as const,
							motion: "hold" as const,
							source: "auto" as const,
						},
					],
					clips,
					makeId,
				) as AxcutZoomRegion[]),
			);
		});
	}
	return out;
}

/** A value written with its keys in order, so two zooms built apart compare as text. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * The punch-ins already there are the ones a run would write: same spans, anchors and look, the
 * ids aside (a run makes new ones). A run that would change nothing need not be saved.
 */
export function samePunchIns(
	current: readonly AxcutZoomRegion[],
	planned: readonly AxcutZoomRegion[],
): boolean {
	const keys = (zooms: readonly AxcutZoomRegion[]) =>
		zooms.map(({ id: _id, ...rest }) => canonical(rest)).sort();
	const a = keys(current);
	const b = keys(planned);
	return a.length === b.length && a.every((key, i) => key === b[i]);
}
