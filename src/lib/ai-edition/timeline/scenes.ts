// A layout chosen for a clip, from the menu beside the program window. The frame's format is one
// for the whole project; only the layout inside it changes. Pure, so the rules can be tested
// without a document.

import type { SceneChoice } from "@/components/video-editor/types";

export const sceneOf = (pill: { scene?: SceneChoice }): SceneChoice => pill.scene ?? "camera";

/** The layouts a frame of this shape offers: both boxes stack in a tall frame, sit apart in a wide one. */
export const scenesForFormat = (portrait: boolean): SceneChoice[] => [
	"camera",
	"picture-in-picture",
	...(portrait ? (["vertical-stack", "cutout-stack"] as const) : (["dual-frame"] as const)),
	"free-layout",
	"screen",
];

/** A clip's layout through a change of format: "both boxes" follows the frame's shape. */
export function sceneForFormat(scene: SceneChoice, portrait: boolean): SceneChoice {
	if (scene === "vertical-stack" && !portrait) return "dual-frame";
	if (scene === "dual-frame" && portrait) return "vertical-stack";
	// A speaker standing under the screen needs a tall frame: the same rule as the project's layout.
	if (scene === "cutout-stack" && !portrait) return "picture-in-picture";
	return scene;
}
