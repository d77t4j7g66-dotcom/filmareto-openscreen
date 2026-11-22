import { describe, expect, it } from "vitest";
import { segmentAttempt } from "./takeMarks";

describe("segmentAttempt", () => {
	it("is the first attempt when the take starts on the segment", () => {
		expect(segmentAttempt([{ atMs: 0, segment: 0 }], 0)).toBe(1);
	});

	it("counts each time the segment was said again", () => {
		const marks = [
			{ atMs: 0, segment: 0 },
			{ atMs: 6000, segment: 0 },
			{ atMs: 17000, segment: 0 },
		];
		expect(segmentAttempt(marks, 0)).toBe(3);
	});

	it("starts again at 1 on the next segment, and counts a return to an earlier one", () => {
		const marks = [
			{ atMs: 0, segment: 0 },
			{ atMs: 5000, segment: 1 },
			{ atMs: 9000, segment: 0 },
		];
		expect(segmentAttempt(marks, 1)).toBe(1);
		expect(segmentAttempt(marks, 0)).toBe(2);
	});

	it("is 1 with no marks at all", () => {
		expect(segmentAttempt([], 2)).toBe(1);
	});
});
