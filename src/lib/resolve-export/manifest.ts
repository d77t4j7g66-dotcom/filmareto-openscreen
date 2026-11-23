import { luaNumber, luaString } from "./dataFile";

export interface ManifestMedia {
	key: string;
	path: string;
	kind: "video" | "audio" | "still";
}

export interface ManifestClip {
	track: "video" | "audio";
	/** V1 = 1, V2 = 2 ... / A1 = 1 ... */
	index: number;
	/** A `media` key. */
	media: string;
	/** Media frames counted from 0 (passed through as given; the caller owns inclusive/exclusive). */
	start: number;
	finish: number;
	/** Timeline frame where the clip sits. */
	record: number;
	/** Fuse effect to attach; `data` is the data file's path. */
	effect?: { data: string; role: "screen" | "camera"; source: string; atlas?: string };
}

export interface ManifestInput {
	name: string;
	width: number;
	height: number;
	fps: 30;
	media: ManifestMedia[];
	clips: ManifestClip[];
}

export function writeTimelineManifest(input: ManifestInput): string {
	const L: string[] = ["return {"];
	L.push(
		`  format = 1, name = ${luaString(input.name)}, width = ${luaNumber(input.width)}, height = ${luaNumber(input.height)}, fps = ${input.fps},`,
	);
	L.push("  media = {");
	for (const m of input.media) {
		L.push(
			`    { key = ${luaString(m.key)}, path = ${luaString(m.path)}, kind = ${luaString(m.kind)} },`,
		);
	}
	L.push("  },");
	L.push("  clips = {");
	for (const c of input.clips) {
		let s = `    { track = ${luaString(c.track)}, index = ${luaNumber(c.index)}, media = ${luaString(c.media)}, start = ${luaNumber(c.start)}, finish = ${luaNumber(c.finish)}, record = ${luaNumber(c.record)}`;
		if (c.effect) {
			const e = c.effect;
			const atlas = e.atlas === undefined ? "" : `, atlas = ${luaString(e.atlas)}`;
			s += `, effect = { data = ${luaString(e.data)}, role = ${luaString(e.role)}, source = ${luaString(e.source)}${atlas} }`;
		}
		L.push(`${s} },`);
	}
	L.push("  },");
	L.push("}");
	return `${L.join("\n")}\n`;
}
