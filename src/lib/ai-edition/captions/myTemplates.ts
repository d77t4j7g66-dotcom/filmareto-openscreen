// Looks the user saved by name, on this Mac, for every project.
//
// shortcut: browser storage, so they stay on this machine and do not travel with a project. Move
// them to a file beside the style presets when they should be shared between machines.

import type { CaptionLook, CaptionSettingsPatch } from "./settings";

const KEY = "filmareto.captionTemplates";

export interface CaptionTemplate {
	name: string;
	settings: CaptionSettingsPatch;
}

/** The look and the fit: not whether captions are on, their language or lane. */
const SAVED: Array<
	keyof CaptionLook | "minWordsPerLine" | "maxWordsPerLine" | "insetY" | "anchorV"
> = [
	"fontFamily",
	"fontWeight",
	"fontSize",
	"color",
	"backgroundEnabled",
	"backgroundColor",
	"backgroundOpacity",
	"textCase",
	"activeWordColor",
	"activeWordPill",
	"emphasis",
	"emphasisColor",
	"emphasisFont",
	"emphasisItalic",
	"emphasisSize",
	"strokeEm",
	"strokeColor",
	"shadow",
	"pop",
	"dropPunctuation",
	"fx",
	"activeWordPop",
	"activeWordHold",
	"activeWordGlow",
	"pillSlides",
	"build",
	"pastWordColor",
	"futureWordColor",
	"twoLines",
	"emoji",
	"minWordsPerLine",
	"maxWordsPerLine",
	"insetY",
	"anchorV",
];

export function readCaptionTemplates(): CaptionTemplate[] {
	try {
		const stored = JSON.parse(localStorage.getItem(KEY) ?? "[]");
		return Array.isArray(stored) ? stored : [];
	} catch {
		return [];
	}
}

function write(templates: CaptionTemplate[]): CaptionTemplate[] {
	try {
		localStorage.setItem(KEY, JSON.stringify(templates));
	} catch {
		// Storage refused: the list still holds for this session.
	}
	return templates;
}

/** A name already taken is replaced, as saving over a file is. */
export function saveCaptionTemplate(
	name: string,
	settings: CaptionSettingsPatch,
): CaptionTemplate[] {
	const kept = Object.fromEntries(SAVED.map((key) => [key, settings[key]]));
	return write([
		...readCaptionTemplates().filter((template) => template.name !== name),
		{ name, settings: kept },
	]);
}

export function deleteCaptionTemplate(name: string): CaptionTemplate[] {
	return write(readCaptionTemplates().filter((template) => template.name !== name));
}
