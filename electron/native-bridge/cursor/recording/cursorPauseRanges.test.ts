import { describe, expect, it } from "vitest";
import type { CursorRecordingData } from "../../../../src/native/contracts";
import { compactCursorTelemetryPauseRanges, shiftCursorTelemetry } from "./cursorPauseRanges";

function recording(...times: number[]): CursorRecordingData {
	return {
		version: 2,
		provider: "none",
		samples: times.map((timeMs) => ({ timeMs, cx: 0.5, cy: 0.5 })),
		assets: [],
	};
}

describe("compactCursorTelemetryPauseRanges", () => {
	it("removes paused samples and shifts later samples across repeated pauses", () => {
		const compacted = compactCursorTelemetryPauseRanges(recording(100, 250, 500, 650, 900), [
			{ startMs: 200, endMs: 400 },
			{ startMs: 600, endMs: 800 },
		]);

		expect(compacted.samples.map((sample) => sample.timeMs)).toEqual([100, 300, 500]);
	});

	it("ignores invalid ranges without replacing the recording", () => {
		const input = recording(100, 200);

		expect(
			compactCursorTelemetryPauseRanges(input, [
				{ startMs: 100, endMs: 100 },
				{ startMs: Number.NaN, endMs: 200 },
			]),
		).toBe(input);
	});
});

describe("shiftCursorTelemetry", () => {
	const take: CursorRecordingData = {
		version: 2,
		provider: "native",
		samples: [
			{ timeMs: 100, cx: 0.1, cy: 0.1 },
			{ timeMs: 900, cx: 0.2, cy: 0.2, interactionType: "click" },
			{ timeMs: 2_500, cx: 0.3, cy: 0.3, interactionType: "move" },
			{ timeMs: 3_200, cx: 0.4, cy: 0.4 },
			{ timeMs: 4_000, cx: 0.5, cy: 0.5, interactionType: "click" },
		],
		assets: [],
		keys: [
			{ timeMs: 1_500, key: "Tab", modifiers: ["cmd"] },
			{ timeMs: 4_100, key: "S", modifiers: ["cmd"] },
		],
	};

	it("puts everything on the take's clock and drops what came before its t=0", () => {
		const shifted = shiftCursorTelemetry(take, 3_000);

		expect(shifted.samples).toEqual([
			// The pointer's last position before the take, as its start.
			{ timeMs: 0, cx: 0.3, cy: 0.3, interactionType: "move" },
			{ timeMs: 200, cx: 0.4, cy: 0.4 },
			{ timeMs: 1_000, cx: 0.5, cy: 0.5, interactionType: "click" },
		]);
		// Cmd+Tab during the countdown is not one of the take's shortcuts; Cmd+S is, on time.
		expect(shifted.keys).toEqual([{ timeMs: 1_100, key: "S", modifiers: ["cmd"] }]);
	});

	it("never turns a click before the take into one at its start", () => {
		const shifted = shiftCursorTelemetry(take, 1_000);

		expect(
			shifted.samples.filter((s) => s.interactionType === "click").map((s) => s.timeMs),
		).toEqual([3_000]);
		expect(shifted.samples[0]).toEqual({ timeMs: 0, cx: 0.1, cy: 0.1 });
	});

	it("leaves a recording that started with the take as it is", () => {
		expect(shiftCursorTelemetry(take, 0)).toBe(take);
		expect(shiftCursorTelemetry(take, Number.NaN)).toBe(take);
	});
});

describe("compactCursorTelemetryPauseRanges keys", () => {
	it("drops shortcuts pressed while paused and moves later ones up with the samples", () => {
		const compacted = compactCursorTelemetryPauseRanges(
			{
				...recording(100, 900),
				keys: [
					{ timeMs: 300, key: "P", modifiers: ["cmd"] },
					{ timeMs: 900, key: "S", modifiers: ["cmd"] },
				],
			},
			[{ startMs: 200, endMs: 600 }],
		);

		expect(compacted.keys).toEqual([{ timeMs: 500, key: "S", modifiers: ["cmd"] }]);
	});
});
