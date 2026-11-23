// Tiny parser for the Lua subset the writers emit: `return { ... }` with nested tables,
// `key = value` and positional entries, numbers, booleans and quoted strings (\" \\ \ddd).
// Test-only. Strings decode to UTF-8 text.

export type LuaValue = number | boolean | string | LuaTable;
export interface LuaTable {
	array: LuaValue[];
	map: Record<string, LuaValue>;
}

export function parseLuaChunk(src: string): LuaTable {
	let i = 0;
	const ws = () => {
		while (i < src.length && /\s/.test(src[i])) i++;
	};
	const fail = (m: string): never => {
		throw new Error(`lua parse: ${m} at ${i}: ${src.slice(i, i + 30)}`);
	};
	const str = (): string => {
		i++; // opening quote
		const bytes: number[] = [];
		const enc = new TextEncoder();
		while (i < src.length && src[i] !== '"') {
			if (src[i] === "\n") fail("raw newline in string");
			if (src[i] === "\\") {
				i++;
				if (/\d/.test(src[i])) {
					let d = "";
					while (d.length < 3 && /\d/.test(src[i])) d += src[i++];
					bytes.push(Number(d));
				} else if (src[i] === '"' || src[i] === "\\") {
					bytes.push(src.charCodeAt(i++));
				} else fail("bad escape");
			} else {
				bytes.push(...enc.encode(src[i++]));
			}
		}
		if (src[i] !== '"') fail("unterminated string");
		i++;
		return new TextDecoder().decode(new Uint8Array(bytes));
	};
	const value = (): LuaValue => {
		ws();
		const c = src[i];
		if (c === "{") return table();
		if (c === '"') return str();
		if (src.startsWith("true", i)) {
			i += 4;
			return true;
		}
		if (src.startsWith("false", i)) {
			i += 5;
			return false;
		}
		const m = /^-?\d+(\.\d+)?/.exec(src.slice(i));
		if (!m) return fail("value");
		i += m[0].length;
		if (/[eE]/.test(src[i] ?? "")) fail("exponent notation");
		return Number(m[0]);
	};
	const table = (): LuaTable => {
		i++; // {
		const t: LuaTable = { array: [], map: {} };
		for (;;) {
			ws();
			if (src[i] === "}") {
				i++;
				return t;
			}
			const m = /^([A-Za-z_]\w*)\s*=/.exec(src.slice(i));
			if (m) {
				i += m[0].length;
				t.map[m[1]] = value();
			} else {
				t.array.push(value());
			}
			ws();
			if (src[i] === "," || src[i] === ";") i++;
			else if (src[i] !== "}") fail("expected , or }");
		}
	};
	ws();
	if (!src.startsWith("return", i)) fail("expected return");
	i += 6;
	const t = value();
	ws();
	if (i !== src.length) fail("trailing text");
	return t as LuaTable;
}
