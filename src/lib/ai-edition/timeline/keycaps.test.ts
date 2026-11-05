import { describe, expect, it } from "vitest";
import type { CursorRecordingKey } from "@/native/contracts";
import type { AxcutClip } from "../schema";
import { keycapLabel, planKeycaps } from "./keycaps";

const key = (timeMs: number, k: string, modifiers: CursorRecordingKey["modifiers"] = []) => ({
	timeMs,
	key: k,
	modifiers,
});

const clip = (over: Partial<AxcutClip>): AxcutClip =>
	({
		id: "c",
		assetId: "a",
		sourceStartSec: 0,
		sourceEndSec: 100,
		timelineStartSec: 0,
		timelineEndSec: 100,
		wordRefs: [],
		origin: "user",
		reason: "",
		...over,
	}) as AxcutClip;

describe("keycapLabel", () => {
	it("writes modifiers in the macOS order, then the key", () => {
		expect(keycapLabel(key(0, "C", ["shift", "cmd"]))).toBe("⇧⌘ C");
		expect(keycapLabel(key(0, "K", ["cmd"]))).toBe("⌘ K");
		expect(keycapLabel(key(0, "K", ["cmd", "ctrl"]))).toBe("⌃⌘ K");
		expect(keycapLabel(key(0, "F1"))).toBe("F1");
	});
});

describe("planKeycaps", () => {
	it("puts each shortcut on the ruler through the clip that plays it", () => {
		// The clip plays source 10..20 s from ruler 0: a shortcut at source 12 s is at ruler 2 s.
		const plans = planKeycaps({
			keysByAssetId: new Map([["a", [key(12_000, "K", ["cmd"])]]]),
			clips: [
				clip({ sourceStartSec: 10, sourceEndSec: 20, timelineStartSec: 0, timelineEndSec: 10 }),
			],
		});
		expect(plans).toHaveLength(1);
		expect(plans[0].startMs).toBe(2000);
		expect(plans[0].endMs).toBe(3400);
		expect(plans[0].label).toBe("⌘ K");
	});

	it("drops a shortcut the edit cut out", () => {
		const plans = planKeycaps({
			keysByAssetId: new Map([["a", [key(5_000, "K", ["cmd"])]]]),
			clips: [
				clip({ sourceStartSec: 10, sourceEndSec: 20, timelineStartSec: 0, timelineEndSec: 10 }),
			],
		});
		expect(plans).toEqual([]);
	});

	it("ends a keycap when the next shortcut comes, but never under the minimum", () => {
		const plans = planKeycaps({
			keysByAssetId: new Map([
				["a", [key(1000, "A", ["cmd"]), key(1500, "B", ["cmd"]), key(1600, "C", ["cmd"])]],
			]),
			clips: [clip({})],
		});
		expect(plans.map((p) => [p.startMs, p.endMs])).toEqual([
			[1000, 1500],
			[1500, 1850],
			[1600, 3000],
		]);
	});
});

describe("planKeycaps plain keys", () => {
	const clips = [
		{
			id: "c1",
			assetId: "a1",
			sourceStartSec: 0,
			sourceEndSec: 60,
			timelineStartSec: 0,
			timelineEndSec: 60,
		},
	] as unknown as Parameters<typeof planKeycaps>[0]["clips"];
	const key = (timeMs: number, k: string, modifiers: Array<"cmd" | "shift"> = []) => ({
		timeMs,
		key: k,
		modifiers,
	});
	const run = (keys: ReturnType<typeof key>[], extra = {}) =>
		planKeycaps({ keysByAssetId: new Map([["a1", keys]]), clips, ...extra }).map((p) => p.label);

	it("shows a plain key pressed alone and not the ones typed in a run", () => {
		const typing = [key(10000, "H"), key(10120, "I"), key(10240, "!")];
		expect(run([key(2000, "E"), ...typing])).toEqual(["E"]);
	});

	it("can hide plain keys, or show all of them", () => {
		const keys = [key(2000, "E"), key(2100, "Q"), key(5000, "K", ["cmd"])];
		expect(run(keys, { plainKeys: "off" })).toEqual(["\u2318 K"]);
		expect(run(keys, { plainKeys: "all" })).toEqual(["E", "Q", "\u2318 K"]);
	});

	it("shows only the plain keys asked for, however fast they are pressed", () => {
		const keys = [key(2000, "E"), key(2100, "X"), key(2200, "Q"), key(5000, "K", ["cmd"])];
		expect(run(keys, { onlyKeys: ["e", "q"] })).toEqual(["E", "Q", "\u2318 K"]);
	});

	it("writes the caps with a + between them", () => {
		const [plan] = planKeycaps({
			keysByAssetId: new Map([["a1", [key(1000, "Z", ["cmd", "shift"])]]]),
			clips,
			labels: "words",
		});
		expect(plan.tokens).toEqual(["Shift", "+", "Cmd", "+", "Z"]);
	});
});
