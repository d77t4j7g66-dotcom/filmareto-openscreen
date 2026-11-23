import { describe, expect, it } from "vitest";
import { clipTakes, takeSegments } from "./takeSegments";

describe("takeSegments", () => {
	it("splits the take end to end where the segment changed", () => {
		const marks = [
			{ atMs: 0, segment: 0 },
			{ atMs: 4000, segment: 1 },
			{ atMs: 9000, segment: 2 },
		];
		expect(takeSegments(marks, 12)).toEqual([
			{ startSec: 0, endSec: 4, segment: 0, earlier: [] },
			{ startSec: 4, endSec: 9, segment: 1, earlier: [] },
			{ startSec: 9, endSec: 12, segment: 2, earlier: [] },
		]);
	});

	it("leaves a take that never changed segment as one clip", () => {
		expect(takeSegments([{ atMs: 0, segment: 0 }], 12)).toEqual([]);
		expect(takeSegments([], 12)).toEqual([]);
	});

	it("puts the last attempt of a retried segment on the timeline and keeps the earlier as takes", () => {
		const marks = [
			{ atMs: 0, segment: 0 },
			{ atMs: 3000, segment: 0 },
			{ atMs: 7000, segment: 0 },
			{ atMs: 9000, segment: 1 },
		];
		expect(takeSegments(marks, 12)).toEqual([
			{
				startSec: 7,
				endSec: 9,
				segment: 0,
				earlier: [
					{ startSec: 0, endSec: 3 },
					{ startSec: 3, endSec: 7 },
				],
			},
			{ startSec: 9, endSec: 12, segment: 1, earlier: [] },
		]);
	});

	it("retries a segment gone back to, in its place in the script", () => {
		const marks = [
			{ atMs: 0, segment: 0 },
			{ atMs: 4000, segment: 1 },
			{ atMs: 8000, segment: 0 },
		];
		expect(takeSegments(marks, 12).map((s) => [s.segment, s.startSec, s.earlier.length])).toEqual([
			[0, 8, 1],
			[1, 4, 0],
		]);
	});

	it("cuts a one-segment take that was retried, instead of leaving it whole", () => {
		const marks = [
			{ atMs: 0, segment: 0 },
			{ atMs: 5000, segment: 0 },
		];
		expect(takeSegments(marks, 9)).toEqual([
			{ startSec: 5, endSec: 9, segment: 0, earlier: [{ startSec: 0, endSec: 5 }] },
		]);
	});

	it("ignores a segment passed through in a blink, leaving no gap", () => {
		const marks = [
			{ atMs: 0, segment: 0 },
			{ atMs: 4000, segment: 1 },
			{ atMs: 4100, segment: 2 },
		];
		expect(takeSegments(marks, 10)).toEqual([
			{ startSec: 0, endSec: 4.1, segment: 0, earlier: [] },
			{ startSec: 4.1, endSec: 10, segment: 2, earlier: [] },
		]);
	});

	it("ignores a mark at the very end of the take", () => {
		const marks = [
			{ atMs: 0, segment: 0 },
			{ atMs: 5000, segment: 1 },
			{ atMs: 9900, segment: 2 },
		];
		expect(takeSegments(marks, 10).at(-1)).toEqual({
			startSec: 5,
			endSec: 10,
			segment: 1,
			earlier: [],
		});
	});

	it("covers the whole take when the first mark comes late", () => {
		const marks = [
			{ atMs: 200, segment: 0 },
			{ atMs: 5000, segment: 1 },
		];
		expect(takeSegments(marks, 10)[0].startSec).toBe(0);
	});
});

describe("clipTakes", () => {
	it("numbers the takes as they were said and says which is showing", () => {
		const clip = {
			sourceStartSec: 7,
			sourceEndSec: 9,
			alternates: [
				{ sourceStartSec: 0, sourceEndSec: 3 },
				{ sourceStartSec: 3, sourceEndSec: 7 },
			],
		};
		const { takes, current } = clipTakes(clip);
		expect(takes.map((t) => t.sourceStartSec)).toEqual([0, 3, 7]);
		expect(current).toBe(2);
	});
});
