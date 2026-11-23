import { describe, expect, it } from "vitest";
import { DATA_STRIDE, luaNumber, luaString, writeDataFile } from "./dataFile";
import { type LuaTable, parseLuaChunk } from "./luaSubset.testutil";
import { writeTimelineManifest } from "./manifest";

const baseMeta = {
	role: "screen" as const,
	fps: 30 as const,
	frame0: 12,
	shadow: { opacity: 0.27, spread: 40 / 1080, offsetY: 16 / 1080 },
	canvas: { w: 1080, h: 1920 },
};

function samples(n: number): Float32Array {
	const a = new Float32Array(n * DATA_STRIDE);
	for (let i = 0; i < a.length; i++) a[i] = (i % 7) * 0.123456789 - 0.4;
	return a;
}

describe("luaNumber", () => {
	it("rounds to 5 decimals, never uses an exponent and has no negative zero", () => {
		expect(luaNumber(0.123456789)).toBe("0.12346");
		expect(luaNumber(1e-9)).toBe("0");
		expect(luaNumber(-1e-9)).toBe("0");
		expect(luaNumber(1)).toBe("1");
		expect(luaNumber(-2.5)).toBe("-2.5");
		expect(luaNumber(123456789.5)).toBe("123456789.5");
		expect(luaNumber(Number.NaN)).toBe("0");
		for (const v of [3e-7, 1.5e-5, 2e10]) expect(luaNumber(v)).not.toMatch(/e/i);
	});
});

describe("writeDataFile", () => {
	it("round-trips n*stride numbers through a Lua parser", () => {
		const s = samples(40);
		const lua = writeDataFile(
			{
				...baseMeta,
				cursor: {
					atlas: "cursors.png",
					kinds: [
						{ name: "arrow", rect: [0, 0, 32, 32], hotspot: [3, 2] },
						{ name: "ibeam", rect: [32, 0, 16, 32], hotspot: [8, 16] },
					],
				},
			},
			s,
		);
		const t = parseLuaChunk(lua);
		expect(t.map.format).toBe(1);
		expect(t.map.role).toBe("screen");
		expect(t.map.fps).toBe(30);
		expect(t.map.frame0).toBe(12);
		expect(t.map.n).toBe(40);
		expect(t.map.stride).toBe(19);
		const arr = (t.map.s as LuaTable).array as number[];
		expect(arr).toHaveLength(40 * 19);
		arr.forEach((v, i) => expect(v).toBeCloseTo(s[i], 4));
		const shadow = (t.map.shadow as LuaTable).map;
		expect(shadow.opacity).toBe(0.27);
		expect(shadow.spread).toBeCloseTo(40 / 1080, 5);
		expect(((t.map.canvas as LuaTable).map as Record<string, unknown>).h).toBe(1920);
		expect(t.map.mirror).toBe(false);
		const cursor = (t.map.cursor as LuaTable).map;
		expect(cursor.atlas).toBe("cursors.png");
		const kinds = (cursor.kinds as LuaTable).array as LuaTable[];
		expect(kinds).toHaveLength(2);
		expect(kinds[1].map.name).toBe("ibeam");
		expect((kinds[1].map.rect as LuaTable).array).toEqual([32, 0, 16, 32]);
		expect((kinds[1].map.hotspot as LuaTable).array).toEqual([8, 16]);
	});

	it("keeps lines short, uses no exponent and omits the cursor for a camera", () => {
		const s = new Float32Array(DATA_STRIDE * 50);
		s.fill(1e-8);
		s[3] = 123456.5;
		const lua = writeDataFile({ ...baseMeta, role: "camera", mirror: true }, s);
		for (const line of lua.split("\n")) {
			expect(line.split(",").length).toBeLessThanOrEqual(200);
		}
		expect(lua).not.toMatch(/\de-?\d/i);
		const t = parseLuaChunk(lua);
		expect(t.map.role).toBe("camera");
		expect(t.map.mirror).toBe(true);
		expect(t.map.cursor).toBeUndefined();
		expect(((t.map.s as LuaTable).array as number[])[3]).toBe(123456.5);
	});

	it("writes n = 0 with an empty table and rejects a ragged sample array", () => {
		const t = parseLuaChunk(writeDataFile(baseMeta, new Float32Array(0)));
		expect(t.map.n).toBe(0);
		expect((t.map.s as LuaTable).array).toEqual([]);
		expect(() => writeDataFile(baseMeta, new Float32Array(20))).toThrow();
		const bad = new Float32Array(DATA_STRIDE);
		bad[4] = Number.NaN;
		expect(() => writeDataFile(baseMeta, bad)).toThrow(/non-finite/);
	});
});

describe("luaString", () => {
	const nasty = [
		'/Users/Κώστας/Ηχογράφηση "A" \\ B\nγραμμή 2\t.mov',
		'say "hi" \\n \\"',
		"]] ]=] --[[ \0 end",
		"emoji 🎬",
	];
	it.each(nasty)("round-trips %j", (value) => {
		const lit = luaString(value);
		expect(lit).not.toContain("\n");
		expect(lit).toMatch(/^"[\x20-\x7e]*"$/);
		expect(parseLuaChunk(`return { ${lit} }`).array[0]).toBe(value);
	});
});

describe("writeTimelineManifest", () => {
	it("lists media and the V1..V4 / A1 clips with their frames", () => {
		const lua = writeTimelineManifest({
			name: 'Μάθημα "1"',
			width: 1080,
			height: 1920,
			fps: 30,
			media: [
				{ key: "bg", path: "/tmp/bg.png", kind: "still" },
				{ key: "m1", path: '/Users/Κώστας/rec "x".mov', kind: "video" },
				{ key: "cam1", path: "/rec/cam.mov", kind: "video" },
				{ key: "ov", path: "/tmp/overlay.mov", kind: "video" },
				{ key: "v1", path: "/rec/mic.wav", kind: "audio" },
			],
			clips: [
				{ track: "video", index: 1, media: "bg", start: 0, finish: 299, record: 0 },
				{
					track: "video",
					index: 2,
					media: "m1",
					start: 60,
					finish: 359,
					record: 0,
					effect: {
						data: "/tmp/data/seg-001.lua",
						role: "screen",
						source: "m1",
						atlas: "/tmp/cursors.png",
					},
				},
				{
					track: "video",
					index: 3,
					media: "cam1",
					start: 45,
					finish: 344,
					record: 0,
					effect: { data: "/tmp/data/cam-001.lua", role: "camera", source: "cam1" },
				},
				{ track: "video", index: 4, media: "ov", start: 0, finish: 299, record: 0 },
				{ track: "audio", index: 1, media: "v1", start: 60, finish: 359, record: 0 },
			],
		});
		const t = parseLuaChunk(lua);
		expect(t.map.format).toBe(1);
		expect(t.map.name).toBe('Μάθημα "1"');
		expect(t.map.width).toBe(1080);
		expect(t.map.height).toBe(1920);
		expect(t.map.fps).toBe(30);
		const media = (t.map.media as LuaTable).array as LuaTable[];
		expect(media.map((m) => m.map.kind)).toEqual(["still", "video", "video", "video", "audio"]);
		expect(media[1].map.path).toBe('/Users/Κώστας/rec "x".mov');
		const clips = (t.map.clips as LuaTable).array as LuaTable[];
		expect(clips.map((c) => `${c.map.track}${c.map.index}`)).toEqual([
			"video1",
			"video2",
			"video3",
			"video4",
			"audio1",
		]);
		const v2 = clips[1].map;
		expect([v2.start, v2.finish, v2.record]).toEqual([60, 359, 0]);
		const fx = (v2.effect as LuaTable).map;
		expect(fx).toEqual({
			data: "/tmp/data/seg-001.lua",
			role: "screen",
			source: "m1",
			atlas: "/tmp/cursors.png",
		});
		expect(
			((clips[2].map.effect as LuaTable).map as Record<string, unknown>).atlas,
		).toBeUndefined();
		expect(clips[0].map.effect).toBeUndefined();
		expect([...lua].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
	});
});
