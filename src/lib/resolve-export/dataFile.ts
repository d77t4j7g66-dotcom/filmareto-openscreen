export const DATA_STRIDE = 19;

export interface CursorKind {
	name: string;
	rect: [number, number, number, number];
	hotspot: [number, number];
}

export interface DataFileMeta {
	role: "screen" | "camera";
	fps: 30;
	/** Media-file frame index of the first sample. */
	frame0: number;
	shadow: { opacity: number; spread: number; offsetY: number };
	canvas: { w: number; h: number };
	mirror?: boolean;
	cursor?: { atlas: string; kinds: CursorKind[] };
}

const NUMBERS_PER_LINE = 190;

/** Lua number text: 5 decimals, trailing zeros trimmed, never an exponent, no "-0". */
export function luaNumber(v: number): string {
	if (!Number.isFinite(v)) return "0";
	const r = Math.round(v * 1e5) / 1e5;
	if (r === 0) return "0";
	// toFixed never emits an exponent below 1e21; these values are far smaller.
	const s = r.toFixed(5);
	return s.replace(/0+$/, "").replace(/\.$/, "");
}

/** Lua string literal: printable ASCII as is, everything else as `\ddd` UTF-8 bytes. */
export function luaString(value: string): string {
	let out = '"';
	for (const b of new TextEncoder().encode(value)) {
		if (b === 0x22) out += '\\"';
		else if (b === 0x5c) out += "\\\\";
		else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
		else out += `\\${String(b).padStart(3, "0")}`;
	}
	return `${out}"`;
}

function luaList(values: ReadonlyArray<number>): string {
	return `{ ${values.map(luaNumber).join(", ")} }`;
}

export function writeDataFile(meta: DataFileMeta, samples: Float32Array): string {
	if (samples.length % DATA_STRIDE !== 0) {
		throw new Error(`samples length ${samples.length} is not a multiple of ${DATA_STRIDE}`);
	}
	for (let i = 0; i < samples.length; i++) {
		if (!Number.isFinite(samples[i])) throw new Error(`non-finite sample at index ${i}`);
	}
	const n = samples.length / DATA_STRIDE;
	const lines: string[] = ["return {"];
	lines.push(`  format = 1, role = ${luaString(meta.role)}, fps = ${meta.fps},`);
	lines.push(`  frame0 = ${luaNumber(meta.frame0)},`);
	lines.push(`  n = ${n}, stride = ${DATA_STRIDE},`);
	lines.push("  s = {");
	for (let i = 0; i < samples.length; i += NUMBERS_PER_LINE) {
		const chunk: string[] = [];
		const end = Math.min(i + NUMBERS_PER_LINE, samples.length);
		for (let j = i; j < end; j++) chunk.push(luaNumber(samples[j]));
		lines.push(`    ${chunk.join(", ")},`);
	}
	lines.push("  },");
	const sh = meta.shadow;
	lines.push(
		`  shadow = { opacity = ${luaNumber(sh.opacity)}, spread = ${luaNumber(sh.spread)}, offsetY = ${luaNumber(sh.offsetY)} },`,
	);
	lines.push(`  canvas = { w = ${luaNumber(meta.canvas.w)}, h = ${luaNumber(meta.canvas.h)} },`);
	lines.push(`  mirror = ${meta.mirror ? "true" : "false"},`);
	if (meta.cursor) {
		const kinds = meta.cursor.kinds.map(
			(k) =>
				`{ name = ${luaString(k.name)}, rect = ${luaList(k.rect)}, hotspot = ${luaList(k.hotspot)} }`,
		);
		lines.push(
			`  cursor = { atlas = ${luaString(meta.cursor.atlas)}, kinds = { ${kinds.join(", ")} } },`,
		);
	}
	lines.push("}");
	return `${lines.join("\n")}\n`;
}
