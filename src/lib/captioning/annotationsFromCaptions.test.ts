import { describe, expect, it } from "vitest";

import {
	dedupeAdjacentCaptionRepeats,
	finalizeCaptionSegmentsForPlayback,
	groupPhraseCaptionSegmentsIntoLines,
	groupTimedCaptionWordsIntoLines,
} from "./annotationsFromCaptions";

describe("groupPhraseCaptionSegmentsIntoLines", () => {
	it("preserves phrase boundaries when formatting phrase-timestamp captions", () => {
		const lines = groupPhraseCaptionSegmentsIntoLines(
			[
				{ startSec: 0, endSec: 0.5, text: "alpha beta" },
				{ startSec: 0.62, endSec: 1.6, text: "gamma delta" },
			],
			2,
			2,
		);

		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({ text: "alpha beta", startSec: 0 });
		expect(lines[1]).toMatchObject({ text: "gamma delta", startSec: 0.62 });
		expect(lines[0]!.endSec).toBeLessThanOrEqual(0.62);
	});

	it("slices a single merged phrase into timed caption lines by word bounds", () => {
		const lines = groupPhraseCaptionSegmentsIntoLines(
			[{ startSec: 0, endSec: 1, text: "alpha beta gamma delta" }],
			2,
			2,
		);

		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({
			startSec: 0,
			endSec: 0.5,
			text: "alpha beta",
		});
		expect(lines[1]).toMatchObject({
			startSec: 0.5,
			endSec: 1,
			text: "gamma delta",
		});
	});
});

describe("groupTimedCaptionWordsIntoLines", () => {
	const spoken = (...texts: string[]) =>
		texts.map((text, i) => ({ startSec: i * 0.2, endSec: i * 0.2 + 0.19, text }));
	const lines = (words: string[], min: number, max: number) =>
		groupTimedCaptionWordsIntoLines(spoken(...words), min, max).map((line) => line.text);

	it("ends a line where a sentence ends", () => {
		expect(lines(["είναι", "άθλιο.", "Θα", "σου", "δείξω"], 2, 4)).toEqual([
			"είναι άθλιο.",
			"Θα σου δείξω",
		]);
		expect(lines(["πώς;", "Έτσι"], 2, 4)).toEqual(["πώς;", "Έτσι"]);
	});

	it("does not end a line on a little word", () => {
		expect(lines(["κάνεις", "καλύτερο", "με", "τρία", "κλικ", "μόνο"], 2, 3)).toEqual([
			"κάνεις καλύτερο",
			"με τρία κλικ μόνο",
		]);
		expect(lines(["καλύτερο", "με", "3", "μόνο", "κλικ"], 2, 3)).toEqual([
			"καλύτερο",
			"με 3 μόνο κλικ",
		]);
	});

	it("keeps a little word with the next one when a look shows one word at a time", () => {
		expect(lines(["το", "stabilization", "είναι", "άθλιο"], 1, 1)).toEqual([
			"το stabilization",
			"είναι",
			"άθλιο",
		]);
	});

	it("preserves empty timeline space when word timestamps contain a real pause", () => {
		const lines = groupTimedCaptionWordsIntoLines(
			[
				{ startSec: 0, endSec: 0.12, text: "first" },
				{ startSec: 0.13, endSec: 0.28, text: "caption" },
				{ startSec: 0.7, endSec: 0.83, text: "second" },
				{ startSec: 0.84, endSec: 0.98, text: "caption" },
			],
			2,
			2,
		);

		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({ startSec: 0, endSec: 0.28, text: "first caption" });
		expect(lines[1]).toMatchObject({ startSec: 0.7, endSec: 0.98, text: "second caption" });
	});

	it("preserves repeated words instead of collapsing them into one token", () => {
		const lines = groupTimedCaptionWordsIntoLines(
			[
				{ startSec: 0, endSec: 0.12, text: "I" },
				{ startSec: 0.13, endSec: 0.25, text: "I" },
			],
			2,
			2,
		);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ text: "I I" });
	});
});

describe("dedupeAdjacentCaptionRepeats", () => {
	it("merges the same line repeated across a chunk boundary", () => {
		const lines = dedupeAdjacentCaptionRepeats([
			{ startSec: 0, endSec: 1, text: "hello there" },
			{ startSec: 0.9, endSec: 1.8, text: "Hello there." },
		]);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ startSec: 0, endSec: 1.8 });
	});

	it("keeps the same line spoken again after a real silence", () => {
		const lines = dedupeAdjacentCaptionRepeats([
			{ startSec: 0, endSec: 1, text: "hello there" },
			{ startSec: 8, endSec: 9, text: "hello there" },
		]);

		expect(lines).toHaveLength(2);
	});
});

describe("finalizeCaptionSegmentsForPlayback", () => {
	it("ends a line where the next one starts so two never show at once", () => {
		const lines = finalizeCaptionSegmentsForPlayback([
			{ startSec: 0, endSec: 1.5, text: "first" },
			{ startSec: 1, endSec: 2, text: "second" },
		]);

		expect(lines[0]!.endSec).toBeCloseTo(1, 5);
		expect(lines[1]).toMatchObject({ startSec: 1, endSec: 2 });
	});
});
