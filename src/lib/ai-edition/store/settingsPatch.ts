// A settings patch applied to a document, with what it implies for the rest of it. Pure, so the
// editor's hook and the agent's tools apply a setting through the same code.

import { type MeasureText, refitFrameAnnotations } from "../annotations/placement";
import { resolveAspectRatioValue } from "../document/outputFormat";
import type { AxcutDocument } from "../schema";
import {
	clipUnderPlayhead,
	type EditorSettingsPatch,
	getEditorSettings,
	patchClipLook,
	patchEditorSettings,
	splitLookPatch,
} from "./editorSettings";

/**
 * `patchEditorSettings`, plus what a new frame shape does to the annotations placed on the frame:
 * each keeps its centre, and a text its fit to its words (`refitFrameAnnotations`), in the same
 * write, so one undo takes both back. The shape is the resolved one, not the `aspectRatio` key:
 * under Auto a device frame, a padding or a camera layout reshapes the frame as surely as a
 * format pick. `measure` measures those words: the renderer's canvas by default, the font files
 * where there is no canvas (the agent, in the main process).
 */
export function applySettingsPatch(
	doc: AxcutDocument,
	patch: EditorSettingsPatch,
	measure?: MeasureText,
): AxcutDocument {
	const next = patchEditorSettings(doc, patch);
	// ponytail: only a settings patch refits. Under Auto the frame can also reshape when clips
	// change (a crop, a new first clip), and those annotations keep their shares of the frame;
	// refit there too if that shows up in practice.
	// Every slider move lands here, and resolving Auto's shape costs up to ~55 µs with a device
	// frame: skip it when nothing sits on the frame.
	if (!next.annotations.some((annotation) => annotation.space === "frame")) return next;
	const annotations = refitFrameAnnotations(
		next.annotations,
		resolveAspectRatioValue(doc, getEditorSettings(doc).aspectRatio),
		resolveAspectRatioValue(next, getEditorSettings(next).aspectRatio),
		measure,
	);
	return annotations === next.annotations ? next : { ...next, annotations };
}

/**
 * A control moved with the playhead at `timeSec`: what belongs to a segment goes to the clip the
 * program is showing, the rest to the project. A project of one clip keeps it all on the project,
 * so splitting that clip later gives both halves the same look.
 */
export function applySegmentSettingsPatch(
	doc: AxcutDocument,
	patch: EditorSettingsPatch,
	timeSec: number,
	measure?: MeasureText,
): AxcutDocument {
	const clip = clipUnderPlayhead(doc, timeSec);
	if (!clip || (doc.timeline.clips.length < 2 && !clip.look)) {
		return applySettingsPatch(doc, patch, measure);
	}
	const { look, rest } = splitLookPatch(patch);
	const next = Object.keys(rest).length > 0 ? applySettingsPatch(doc, rest, measure) : doc;
	return Object.keys(look).length > 0 ? patchClipLook(next, clip.id, look) : next;
}
