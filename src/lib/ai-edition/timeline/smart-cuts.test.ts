import { describe, expect, it } from "vitest";
import { changingPicture, mergeSpans, planSmartCuts, pointerActivity } from "./smart-cuts";

describe("mergeSpans", () => {
	it("joins overlapping and nearly touching spans and drops empty ones", () => {
		expect(
			mergeSpans(
				[
					{ start: 5, end: 6 },
					{ start: 1, end: 2 },
					{ start: 2.2, end: 3 },
					{ start: 9, end: 9 },
				],
				0.5,
			),
		).toEqual([
			{ start: 1, end: 3 },
			{ start: 5, end: 6 },
		]);
	});
});

describe("pointerActivity", () => {
	it("marks where the pointer moves or clicks and ignores where it rests", () => {
		const samples = [
			{ timeMs: 0, cx: 0.5, cy: 0.5 },
			{ timeMs: 1000, cx: 0.5, cy: 0.5 },
			{ timeMs: 2000, cx: 0.6, cy: 0.5 },
			{ timeMs: 3000, cx: 0.6, cy: 0.5 },
			{ timeMs: 9000, cx: 0.6, cy: 0.5, interactionType: "click" },
		];
		const spans = pointerActivity(samples, [], { padSec: 0.4 });
		expect(spans).toEqual([
			{ start: 1.6, end: 2.4 },
			{ start: 8.6, end: 9.4 },
		]);
	});

	it("counts a shortcut as doing something", () => {
		expect(pointerActivity([], [{ timeMs: 5000 }], { padSec: 0.5 })).toEqual([
			{ start: 4.5, end: 5.5 },
		]);
	});
});

describe("changingPicture", () => {
	it("is everything the frozen spans are not", () => {
		expect(changingPicture([{ start: 4, end: 8 }], 12)).toEqual([
			{ start: 0, end: 4 },
			{ start: 8, end: 12 },
		]);
		expect(changingPicture([], 5)).toEqual([{ start: 0, end: 5 }]);
	});
});

describe("planSmartCuts", () => {
	it("keeps speech, speeds up doing, cuts idle", () => {
		const plan = planSmartCuts({
			durationSec: 40,
			// Talks 0-8 s and 30-40 s.
			speech: [
				{ start: 0, end: 8 },
				{ start: 30, end: 40 },
			],
			// Types and moves 10-18 s.
			pointer: [{ start: 10, end: 18 }],
			picture: [{ start: 10, end: 18 }],
		});
		// 18..30 is idle: cut, but with a pad kept at both ends (speech pad 0.3 protects the 30 side).
		expect(plan.cuts).toHaveLength(2);
		const [early, late] = plan.cuts;
		// 8.3..10 is idle too: 1.7 s, long enough to cut.
		expect(early.start).toBeCloseTo(8.55, 1);
		expect(early.end).toBeCloseTo(9.75, 1);
		expect(late.start).toBeGreaterThan(18);
		expect(late.end).toBeLessThan(30);
		expect(plan.speeds).toEqual([{ start: 10, end: 18, speed: 4 }]);
		expect(plan.stats.cutSec).toBeGreaterThan(10);
	});

	it("leaves a short pause alone", () => {
		const plan = planSmartCuts({
			durationSec: 10,
			speech: [
				{ start: 0, end: 4 },
				{ start: 5, end: 10 },
			],
			pointer: [],
			picture: null,
		});
		expect(plan.cuts).toEqual([]);
		expect(plan.speeds).toEqual([]);
	});

	it("does not speed up a short burst of doing", () => {
		const plan = planSmartCuts({
			durationSec: 20,
			speech: [
				{ start: 0, end: 8 },
				{ start: 12, end: 20 },
			],
			pointer: [{ start: 9, end: 10 }],
			picture: null,
		});
		expect(plan.speeds).toEqual([]);
	});

	it("treats a screen that cannot be measured as only the pointer counting", () => {
		const withPicture = planSmartCuts({
			durationSec: 30,
			speech: [{ start: 0, end: 5 }],
			pointer: [],
			picture: [{ start: 10, end: 20 }],
		});
		const without = planSmartCuts({
			durationSec: 30,
			speech: [{ start: 0, end: 5 }],
			pointer: [],
			picture: null,
		});
		// With the picture known, the changing 10-20 is sped up; without it, all of it is idle.
		expect(withPicture.speeds).toHaveLength(1);
		expect(without.speeds).toHaveLength(0);
		expect(without.stats.cutSec).toBeGreaterThan(withPicture.stats.cutSec);
	});

	it("cuts a leading idle stretch from the very start", () => {
		const plan = planSmartCuts({
			durationSec: 20,
			speech: [{ start: 8, end: 20 }],
			pointer: [],
			picture: null,
		});
		expect(plan.cuts[0].start).toBe(0);
		expect(plan.cuts[0].end).toBeGreaterThan(6);
		expect(plan.cuts[0].end).toBeLessThan(8);
	});
});
