import { describe, expect, it } from "vitest";
import { duckDbAt, findSpeechRegions, isDuckRegions } from "./recordingDuck";

const RATE = 8000;
function tone(parts: Array<[seconds: number, amplitude: number]>): Float32Array {
	const out = new Float32Array(parts.reduce((sum, [s]) => sum + Math.round(s * RATE), 0));
	let at = 0;
	for (const [seconds, amplitude] of parts) {
		for (let i = 0; i < Math.round(seconds * RATE); i += 1) out[at++] = amplitude;
	}
	return out;
}

describe("findSpeechRegions", () => {
	it("finds one stretch where the voice is loud", () => {
		expect(
			findSpeechRegions(
				tone([
					[1, 0],
					[2, 0.3],
					[1, 0],
				]),
				RATE,
			),
		).toEqual([[1, 3]]);
	});

	it("joins stretches separated by less than the hold, keeps the rest apart", () => {
		const regions = findSpeechRegions(
			tone([
				[1, 0.3],
				[0.3, 0],
				[1, 0.3],
				[2, 0],
				[1, 0.3],
			]),
			RATE,
		);
		expect(regions).toEqual([
			[0, 2.3],
			[4.3, 5.3],
		]);
	});

	it("ignores a blip shorter than a word and background noise", () => {
		expect(
			findSpeechRegions(
				tone([
					[1, 0.001],
					[0.05, 0.5],
					[1, 0.001],
				]),
				RATE,
			),
		).toEqual([]);
	});
});

describe("duckDbAt", () => {
	const regions: Array<[number, number]> = [[2, 3]];
	it("is untouched far from speech", () => {
		expect(duckDbAt(regions, 0, 12)).toBe(0);
		expect(duckDbAt(regions, 9, 12)).toBe(0);
	});
	it("is the full depth from the first word through the hold", () => {
		expect(duckDbAt(regions, 2, 12)).toBeCloseTo(-12);
		expect(duckDbAt(regions, 2.5, 12)).toBeCloseTo(-12);
		expect(duckDbAt(regions, 3.4, 12)).toBeCloseTo(-12);
	});
	it("ramps in before the word and back out after the hold", () => {
		expect(duckDbAt(regions, 2 - 0.125, 12)).toBeCloseTo(-6);
		expect(duckDbAt(regions, 3 + 0.5 + 0.3, 12)).toBeCloseTo(-6);
	});
});

describe("isDuckRegions", () => {
	it("accepts well-formed stretches and refuses anything else", () => {
		expect(isDuckRegions([[0, 1]])).toBe(true);
		expect(isDuckRegions([])).toBe(true);
		expect(isDuckRegions([[2, 1]])).toBe(false);
		expect(isDuckRegions([[0]])).toBe(false);
		expect(isDuckRegions(null)).toBe(false);
	});
});
