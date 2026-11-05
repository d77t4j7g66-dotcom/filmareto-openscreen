// The two looks this build starts with: a vertical video and a horizontal one. They are
// ordinary presets once written (rename, update or delete them like any other); they are only
// ever written once per profile, and never over a preset of the same name.

import type { StylePresetAppearance } from "@/lib/ai-edition/stylePresets";
import { factoryStylePresetAppearance } from "@/lib/ai-edition/stylePresetsEditor";

export interface BuiltInStylePreset {
	name: string;
	appearance: StylePresetAppearance;
}

export function builtInStylePresets(): BuiltInStylePreset[] {
	const base = factoryStylePresetAppearance();
	return [
		{
			name: "Vertical",
			appearance: {
				...base,
				aspectRatio: "9:16",
				screenAspect: "4:5",
				formatFollowCursor: true,
				webcamLayoutPreset: "cutout-stack",
				webcamBackgroundMode: "none",
				webcamStackSize: 100,
				webcamOverlap: 27,
				webcamRoundness: 0,
				webcamPadLeft: 0,
				webcamPadRight: 0,
				webcamPadBottom: 0,
				webcamPadLinkSides: true,
				webcamPadLinkAll: false,
				webcamPadMatchScreen: false,
				padding: 16,
				backgroundBlur: 0.63,
				shadowIntensity: 0,
				borderRadius: 17,
				motionBlurAmount: 0.44,
				depthOfField: true,
			},
		},
		{
			name: "Horizontal",
			appearance: {
				...base,
				aspectRatio: "16:9",
				screenAspect: "auto",
				formatFollowCursor: false,
				webcamLayoutPreset: "picture-in-picture",
				webcamMaskShape: "square",
				webcamRoundness: 0.58,
				webcamSizePreset: 41,
				webcamAnchor: "bottom-right",
				webcamMargin: 3,
				webcamOverlap: 50,
				webcamReactiveZoom: true,
				padding: 16,
				backgroundBlur: 0.63,
				shadowIntensity: 0,
				borderRadius: 17,
				motionBlurAmount: 0.44,
				depthOfField: true,
			},
		},
	];
}

const SEEDED_KEY = "filmareto.builtInStylePresets.v1";

/**
 * Writes the two built-in presets once for this profile. A name already taken is left alone, and
 * so is a user who deleted them: the flag is set even when there was nothing to write.
 */
export async function seedBuiltInStylePresets(presets: {
	list: () => Promise<Array<{ name: string }>>;
	create: (name: string, appearance: StylePresetAppearance) => Promise<unknown>;
}): Promise<boolean> {
	try {
		if (window.localStorage.getItem(SEEDED_KEY)) return false;
	} catch {
		return false;
	}
	let wrote = false;
	try {
		const taken = new Set((await presets.list()).map((preset) => preset.name.toLowerCase()));
		for (const preset of builtInStylePresets()) {
			if (taken.has(preset.name.toLowerCase())) continue;
			await presets.create(preset.name, preset.appearance);
			wrote = true;
		}
		window.localStorage.setItem(SEEDED_KEY, "1");
	} catch {
		// Not marked: the next opening tries again.
	}
	return wrote;
}
