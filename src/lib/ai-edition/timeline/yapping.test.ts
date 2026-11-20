import { describe, expect, it } from "vitest";
import {
	coverAxis,
	faceUnderPlayhead,
	focusForZoom,
	LEVELS_PER_SEC,
	planYapping,
	planZooms,
	soundOf,
	speechPieces,
	spotBadPieces,
	subtractSpans,
	YAPPING,
} from "./yapping";

/** Levels from spans of [seconds, dB]. */
function levels(...parts: Array<[number, number]>): Float32Array {
	const out: number[] = [];
	for (const [seconds, db] of parts) {
		for (let i = 0; i < Math.round(seconds * LEVELS_PER_SEC); i += 1) out.push(db);
	}
	return Float32Array.from(out);
}

const spoken = (start: number, end: number, sentence: string) => {
	const parts = sentence.split(" ");
	const step = (end - start) / parts.length;
	return parts.map((text, i) => ({
		text,
		start: start + i * step,
		end: start + (i + 1) * step,
	}));
};

describe("speechPieces", () => {
	it("cuts a long quiet run and leaves air either side", () => {
		const pieces = speechPieces(levels([2, -20], [1, -60], [2, -20]));
		expect(pieces).toHaveLength(2);
		expect(pieces[0].end).toBeCloseTo(2 + YAPPING.padSec, 5);
		expect(pieces[1].start).toBeCloseTo(3 - YAPPING.padSec, 5);
	});

	it("leaves a short pause alone", () => {
		expect(speechPieces(levels([2, -20], [0.3, -60], [2, -20]))).toHaveLength(1);
	});

	it("takes a breath between two lines: quiet next to the speech, though not silent", () => {
		expect(speechPieces(levels([2, -18], [0.8, -36], [2, -18]))).toHaveLength(2);
	});

	it("judges silence by the clip's own speech, not a fixed level", () => {
		expect(speechPieces(levels([2, -44], [1, -70], [2, -44]))).toHaveLength(2);
	});
});

describe("soundOf", () => {
	it("hears a Greek spelling and its digraphs", () => {
		expect(soundOf("Ούτε")).toBe("ute");
		expect(soundOf("και")).toBe("ke");
	});

	it("does not read a digraph where an accent splits it", () => {
		expect(soundOf("τάιμλαϊν")).toBe("taimlain");
	});
});

describe("spotBadPieces", () => {
	const pieces = [
		{ start: 0, end: 1 },
		{ start: 2, end: 6 },
	];

	it("cuts an unfinished line said again straight after", () => {
		const words = [
			...spoken(0, 1, "Σήμερα θα δούμε"),
			...spoken(2, 6, "Σήμερα θα δούμε πώς κόβουμε ένα βίντεο."),
		];
		expect(spotBadPieces(pieces, words)).toEqual(["false start", null]);
	});

	it("keeps only the last take of Tutorial 5, as the app's transcriber heard each piece", () => {
		const heard: Array<[number, number, string]> = [
			[
				2.77,
				7.77,
				"Το 'Stabilization' το Premiere είναι άθλιο. Πάμε να σου δείξω όμως πώς μπορείτε να το κάνεις καλύτερο με Μ3.",
			],
			[
				10.83,
				16.13,
				"Τις ταπελαϊζέσουν το Premiere είναι άθυλαιο. Θα σου δείξω όμως πως να το κάνεις καλύτερο με 3 μόνο κλικ.",
			],
			[
				17.3,
				22.57,
				"Το Stabilization του Premiere είναι άθλιο. Θα σου δείξω όμως πώς να το κάνεις καλύτερο με 3 monoclicks.",
			],
			[43.5, 46.83, "Την ώρα του πρεμιέρ θα κάνει μεν περισσότερη ώρα για να αναλύσει το κλειπ."],
			[50.33, 51.8, "αλλά θα δεις βελτίωση όσον;"],
			[52, 53.33, "αλλά θα δεις βελτίωση"],
			[54.03, 57.77, "αλλά θα δεις βελτίωση όσον αφορά το Google που κάνει πολλές φορές η εικόνα."],
			[
				59.27,
				62.6,
				"Εράψε μου στα σχόλια μας δουλέψε και κάνε φόλου το φίλμα ρέτο για περισσότερα...",
			],
			[63.17, 63.67, "Καρά!"],
			[
				64.47,
				68.97,
				"Γράψε μου στα σχόλια Μαδού Λεψέ και κάνε φόλου το φιλμαρέτο για περισσότερα editing tips.",
			],
		];
		const why = spotBadPieces(
			heard.map(([start, end]) => ({ start, end })),
			heard.flatMap(([start, end, line]) => spoken(start, end, line)),
		);
		expect(why.map((reason) => reason === null)).toEqual([
			false,
			false,
			true,
			true,
			false,
			false,
			true,
			false,
			false,
			true,
		]);
	});

	it("takes the sentence a transcriber makes up on a sliver of sound", () => {
		const words = spoken(0, 0.5, "Εγώ πιστεύω ότι είναι ένας τελειώτης που έχω να πω.");
		expect(spotBadPieces([{ start: 0, end: 0.5 }], words)).toEqual(["made up"]);
	});

	it("keeps a short word on its own and a line that only starts alike", () => {
		const pieces = [
			{ start: 0, end: 0.4 },
			{ start: 1, end: 5 },
			{ start: 6, end: 10 },
		];
		const words = [
			...spoken(0, 0.4, "Ναι."),
			...spoken(1, 5, "Το πρώτο που κάνουμε είναι να ανοίξουμε το project."),
			...spoken(6, 10, "Το δεύτερο που κάνουμε είναι να βάλουμε τα clips στο timeline."),
		];
		expect(spotBadPieces(pieces, words)).toEqual([null, null, null]);
	});

	it("keeps a short line that ends a sentence, whatever comes next", () => {
		const words = [
			...spoken(0, 1, "Σήμερα θα δούμε."),
			...spoken(2, 6, "Σήμερα θα δούμε πώς κόβουμε ένα βίντεο."),
		];
		expect(spotBadPieces(pieces, words)[0]).not.toBe("false start");
	});

	it("keeps two different lines", () => {
		const words = [
			...spoken(0, 1, "Πάμε τώρα"),
			...spoken(2, 6, "Ανοίγουμε το πρόγραμμα και βάζουμε το αρχείο."),
		];
		expect(spotBadPieces(pieces, words)).toEqual([null, null]);
	});

	it("cuts a run-up, however long, when most of it comes back fuller", () => {
		const longer = [
			{ start: 0, end: 3 },
			{ start: 4, end: 9 },
		];
		const words = [
			...spoken(0, 3, "Το πρώτο πράγμα που κάνουμε είναι το κόψιμο."),
			...spoken(
				4,
				9,
				"Λοιπόν το πρώτο πράγμα που κάνουμε είναι το κόψιμο των σιωπών στο βίντεο, γιατί έτσι κρατάμε τον θεατή μέχρι το τέλος του.",
			),
		];
		expect(spotBadPieces(longer, words)).toEqual(["run-up", null]);
	});

	it("cuts a piece that holds only a filler, and a sliver with no words", () => {
		const three = [
			{ start: 0, end: 1 },
			{ start: 2, end: 2.2 },
			{ start: 3, end: 6 },
		];
		const words = [...spoken(0, 1, "Εεε"), ...spoken(3, 6, "Πάμε στο επόμενο βήμα.")];
		expect(spotBadPieces(three, words)).toEqual(["filler", "too short", null]);
	});

	it("keeps a long piece nobody wrote words for", () => {
		expect(spotBadPieces([{ start: 0, end: 4 }], [])).toEqual([null]);
	});
});

describe("planZooms", () => {
	const longCut = (start: number) => ({ start, end: start + 4 });
	const shortCut = (start: number) => ({ start, end: start + 2 });

	it("drifts in then out on the long cuts, as the chain does", () => {
		const zooms = planZooms([longCut(0), longCut(5), longCut(10)], [-20, -20, -20]);
		expect(zooms.map((z) => z.motion)).toEqual(["in", "out", "in"]);
		expect(zooms.every((z) => z.scale === 1.2)).toBe(true);
	});

	it("never gives two short cuts in a row the same level", () => {
		const pieces = Array.from({ length: 30 }, (_, i) => shortCut(i * 3));
		const zooms = planZooms(
			pieces,
			pieces.map(() => -20),
		);
		const level = (i: number) =>
			zooms.find((z) => z.start === pieces[i].start)?.scale ?? YAPPING.zooms[0];
		for (let i = 1; i < pieces.length; i += 1) expect(level(i)).not.toBe(level(i - 1));
		expect(new Set(pieces.map((_, i) => level(i))).size).toBe(3);
	});

	it("is the same every time", () => {
		const pieces = Array.from({ length: 12 }, (_, i) => shortCut(i * 3));
		const loud = pieces.map(() => -20);
		expect(planZooms(pieces, loud)).toEqual(planZooms(pieces, loud));
	});

	it("goes up and back on the line said loudest, not on one too short to move", () => {
		const pieces = [
			shortCut(0),
			shortCut(3),
			shortCut(6),
			shortCut(9),
			{ start: 12, end: 12.5 },
			shortCut(13),
			shortCut(16),
			shortCut(19),
		];
		const zooms = planZooms(pieces, [-20, -20, -14, -20, -10, -20, -20, -20]);
		const emphasis = zooms.filter((z) => z.motion === "emphasis");
		expect(emphasis.map((z) => z.start)).toEqual([6]);
		expect(emphasis[0].scale).toBe(YAPPING.emphasisZoom);
	});

	it("finds no emphasis in a flat voice", () => {
		const pieces = Array.from({ length: 8 }, (_, i) => shortCut(i * 3));
		const zooms = planZooms(
			pieces,
			pieces.map(() => -20),
		);
		expect(zooms.some((z) => z.motion === "emphasis")).toBe(false);
	});
});

describe("focusForZoom", () => {
	const onScreen = (eye: number, centre: number, scale: number) => 0.5 + (eye - centre) * scale;

	it("puts the eyes on the eye line at the strongest zoom", () => {
		const face = { x: 0.55, y: 0.33 };
		const top = Math.max(...YAPPING.zooms);
		const { cx, cy } = focusForZoom(face, top);
		expect(onScreen(face.y, cy, top)).toBeCloseTo(YAPPING.eyeLine, 5);
		expect(onScreen(face.x, cx, top)).toBeCloseTo(face.x, 5);
	});

	it("keeps the view inside the picture", () => {
		for (const scale of [1.2, 1.5]) {
			const { cx, cy } = focusForZoom({ x: 0.02, y: 0.05 }, scale);
			expect(cx).toBeGreaterThanOrEqual(0.5 / scale);
			expect(cy).toBeGreaterThanOrEqual(0.5 / scale);
		}
	});

	it("centres the zoom with no face", () => {
		expect(focusForZoom(null, 1.5)).toEqual({ cx: 0.5, cy: 0.5 });
	});
});

describe("zooming on a face in a filled format", () => {
	it("sends the window to the face along the axis the fill cuts", () => {
		const face = { x: 0.533, y: 0.743 };
		expect(focusForZoom(face, 1.5, "x").cx).toBe(0.533);
		expect(focusForZoom(face, 1.5).cx).toBeCloseTo(0.511, 3);
		expect(focusForZoom(face, 1.5, "y").cy).toBe(0.743);
	});

	it("knows which axis a frame cuts", () => {
		expect(coverAxis(16 / 9, 9 / 16)).toBe("x");
		expect(coverAxis(9 / 16, 16 / 9)).toBe("y");
		expect(coverAxis(9 / 16, 9 / 16)).toBeNull();
	});
});

describe("faceUnderPlayhead", () => {
	const document = {
		assets: [
			{ id: "a", face: { x: 0.4, y: 0.3 } },
			{ id: "b", face: null },
		],
		timeline: {
			clips: [
				{ assetId: "a", timelineStartSec: 0, timelineEndSec: 5 },
				{ assetId: "b", timelineStartSec: 5, timelineEndSec: 9 },
			],
		},
	};

	it("reads the face of the take the playhead is on", () => {
		expect(faceUnderPlayhead(document, 2)).toEqual({ x: 0.4, y: 0.3 });
		expect(faceUnderPlayhead(document, 6)).toBeNull();
		expect(faceUnderPlayhead(document, 20)).toBeNull();
	});
});

describe("planYapping", () => {
	const take = levels([4, -20], [2, -70], [4, -20], [2, -70], [4, -20]);

	it("cuts between the pieces and stays inside what the timeline plays", () => {
		const { cuts } = planYapping({
			levelsDb: take,
			words: [],
			windows: [{ start: 1, end: 15 }],
			zoom: true,
		});
		expect(cuts).toHaveLength(2);
		expect(cuts[0].start).toBeGreaterThanOrEqual(1);
		expect(cuts[1].end).toBeLessThanOrEqual(15);
		expect(cuts[0].start).toBeCloseTo(4 + YAPPING.padSec, 5);
	});

	it("keeps segments apart: a piece crossing two clips is two cuts of the edit", () => {
		const { zooms } = planYapping({
			levelsDb: levels([8, -20]),
			words: [],
			windows: [
				{ start: 0, end: 4 },
				{ start: 4, end: 8 },
			],
			zoom: true,
		});
		expect(zooms.map((z) => [z.start, z.end])).toEqual([
			[0, 4],
			[4, 8],
		]);
	});

	it("cuts a bad piece out and does not zoom it", () => {
		const { cuts, zooms, stats } = planYapping({
			levelsDb: levels([1, -20], [2, -70], [4, -20]),
			words: [
				...spoken(0, 1, "Σήμερα θα δούμε"),
				...spoken(3, 7, "Σήμερα θα δούμε πώς κόβουμε ένα βίντεο."),
			],
			windows: [{ start: 0, end: 7 }],
			zoom: true,
		});
		expect(stats.badPieces).toBe(1);
		expect(cuts[0].start).toBe(0);
		expect(zooms).toHaveLength(1);
		expect(zooms[0].start).toBeGreaterThan(2);
	});

	it("does not zoom a recording with no talking head in the picture", () => {
		const { cuts, zooms } = planYapping({
			levelsDb: take,
			words: [],
			windows: [{ start: 0, end: 16 }],
			zoom: false,
		});
		expect(cuts.length).toBeGreaterThan(0);
		expect(zooms).toEqual([]);
	});
});

describe("what is left to edit", () => {
	it("takes the cuts made by hand out of a clip", () => {
		const span = { start: 0, end: 10 };
		expect(subtractSpans(span, [])).toEqual([span]);
		expect(
			subtractSpans(span, [
				{ start: 2, end: 3 },
				{ start: 9, end: 12 },
				{ start: 20, end: 21 },
			]),
		).toEqual([
			{ start: 0, end: 2 },
			{ start: 3, end: 9 },
		]);
	});
});
