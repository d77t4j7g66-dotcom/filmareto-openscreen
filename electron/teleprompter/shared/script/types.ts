import type { Token } from "../normalize";

export type Mode = "talking-head" | "screen";
export type Format = "9:16" | "16:9" | "4:5";
export type Thumbnail = { text?: string; frame?: string; template?: string };
export type Platforms = {
	youtube?: { title?: string; description?: string };
	instagram?: { caption?: string };
	tiktok?: { caption?: string };
};
export type ScriptMeta = {
	version: 1;
	title: string;
	mode: Mode;
	format: Format;
	description?: string;
	thumbnail?: Thumbnail;
	platforms?: Platforms;
	language: string;
};
export type Cue = {
	type: string;
	known: boolean;
	anchor?: string;
	/** Index into the line's tokens where the anchor starts. */
	anchorIndex?: number;
	params: Record<string, string>;
	payload: string;
	sourceLine: number;
};
export type Line = {
	id: string;
	text: string;
	tokens: Token[];
	cues: Cue[];
	directions: string[];
	sourceLine: number;
};
export type Stage = {
	id: string;
	name: string;
	startCues: Cue[];
	startDirections: string[];
	lines: Line[];
	sourceLine: number;
};
export type Script = { meta: ScriptMeta; stages: Stage[] };
export type Issue = { line: number; message: string };
export type ParseResult = { script?: Script; errors: Issue[]; warnings: Issue[] };

export const KNOWN_CUE_TYPES = ["title", "zoom", "sfx", "broll", "meme", "cut"] as const;

export const FORMAT_SIZES: Record<Format, { width: number; height: number }> = {
	"9:16": { width: 1080, height: 1920 },
	"16:9": { width: 1920, height: 1080 },
	"4:5": { width: 1080, height: 1350 },
};
