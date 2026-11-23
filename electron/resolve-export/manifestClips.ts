import type { ManifestClip } from "../../src/lib/resolve-export/manifest";
import type {
	ResolveAudioClip,
	ResolvePlan,
	ResolveSegment,
} from "../../src/lib/resolve-export/plan";

/**
 * What the plan does not know: the files each clip plays and the data written for it. Every path
 * is relative to the export folder (the folder can be moved or renamed; the import script joins
 * them to it).
 */
export interface ManifestLookup {
	screenKey(seg: ResolveSegment): string;
	cameraKey(seg: ResolveSegment): string | null;
	screenData(seg: ResolveSegment): string;
	cameraData(seg: ResolveSegment): string | null;
	/** Path of cursors.png, when the atlas was made. */
	atlas: string | null;
	/** Media key of the overlay file, when it was exported. */
	overlayKey: string | null;
	audioKey(a: ResolveAudioClip): string | null;
	backgroundKey: string;
	/**
	 * Real frame counts of the prepared files, by media key (absent: not known, no clamp). A clip's
	 * `finish` never goes past its file.
	 */
	mediaFrames?(key: string): number | undefined;
}

/** `finish` (exclusive), cut to the file's real length; null when nothing of the clip is left. */
function clampFinish(start: number, finish: number, fileFrames: number | undefined): number | null {
	const end = fileFrames === undefined ? finish : Math.min(finish, fileFrames);
	return end > start ? end : null;
}

/**
 * The plan as timeline clips: V1 background, V2 screen, V3 camera, V4 overlay, A1 voice.
 * `finish` is exclusive (start + frames, clamped to the prepared file); the import script
 * converts it.
 */
export function planToManifestClips(plan: ResolvePlan, lookup: ManifestLookup): ManifestClip[] {
	const frames = (key: string) => lookup.mediaFrames?.(key);
	const clips: ManifestClip[] = [
		{
			track: "video",
			index: 1,
			media: lookup.backgroundKey,
			start: 0,
			finish: plan.backgroundSpan.frames,
			record: 0,
		},
	];
	for (const seg of plan.segments) {
		const screenKey = lookup.screenKey(seg);
		const screenFinish = clampFinish(
			seg.mediaStartFrame,
			seg.mediaStartFrame + seg.frames,
			frames(screenKey),
		);
		if (screenFinish !== null) {
			clips.push({
				track: "video",
				index: 2,
				media: screenKey,
				start: seg.mediaStartFrame,
				finish: screenFinish,
				record: seg.recordFrame,
				effect: {
					data: lookup.screenData(seg),
					role: "screen",
					source: screenKey,
					...(lookup.atlas ? { atlas: lookup.atlas } : {}),
				},
			});
		}
		const cam = seg.camera;
		const camKey = lookup.cameraKey(seg);
		const camData = lookup.cameraData(seg);
		if (cam && cam.frames > 0 && camKey && camData) {
			const camFinish = clampFinish(
				cam.mediaStartFrame,
				cam.mediaStartFrame + cam.frames,
				frames(camKey),
			);
			if (camFinish !== null) {
				clips.push({
					track: "video",
					index: 3,
					media: camKey,
					start: cam.mediaStartFrame,
					finish: camFinish,
					record: cam.recordFrame,
					effect: { data: camData, role: "camera", source: camKey },
				});
			}
		}
	}
	if (lookup.overlayKey && plan.overlaySpan) {
		clips.push({
			track: "video",
			index: 4,
			media: lookup.overlayKey,
			start: 0,
			finish: plan.overlaySpan.frames,
			record: 0,
		});
	}
	for (const a of plan.audio) {
		const key = lookup.audioKey(a);
		if (!key) continue;
		const finish = clampFinish(a.mediaStartFrame, a.mediaStartFrame + a.frames, frames(key));
		if (finish === null) continue;
		clips.push({
			track: "audio",
			index: 1,
			media: key,
			start: a.mediaStartFrame,
			finish,
			record: a.recordFrame,
		});
	}
	return clips;
}
