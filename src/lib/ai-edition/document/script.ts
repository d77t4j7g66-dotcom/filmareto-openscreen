// The script of a project: its scenes, written before anything is recorded. Pure.

import type { AxcutClip, AxcutDocument } from "../schema";

export type Scene = { id: string; name: string; text: string };

export const scenesOf = (document: AxcutDocument | null | undefined): Scene[] =>
	document?.script?.scenes ?? [];

/**
 * The script as the teleprompter reads it, one segment per scene. A scene with nothing written yet
 * shows its name, so that every scene stays a segment and the numbering of the two stays the same.
 */
export function prompterTextOf(scenes: Scene[]): string {
	return scenes.map((scene) => scene.text.trim() || scene.name).join("\n/\n");
}

/** What pasting a whole script into one scene gives: a scene for every part split by a `/` line. */
export function splitPastedScript(pasted: string): string[] {
	return pasted
		.split(/(?:^|\n)\s*\/\s*(?=\n|$)/u)
		.map((part) => part.trim())
		.filter(Boolean);
}

/** What the menus and the timeline call a clip. */
export function clipLabel(
	document: AxcutDocument | null | undefined,
	clip: Pick<AxcutClip, "sceneId" | "reason">,
	index: number,
): string {
	const scene = clip.sceneId ? scenesOf(document).find((s) => s.id === clip.sceneId) : null;
	if (scene) return scene.name;
	return /^Segment \d+$/.test(clip.reason) ? clip.reason : `Clip ${index + 1}`;
}
