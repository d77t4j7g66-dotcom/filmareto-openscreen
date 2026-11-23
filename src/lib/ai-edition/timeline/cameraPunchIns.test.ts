import { describe, expect, it } from "vitest";
import type { AxcutDocument } from "../schema";
import { CAMERA_PUNCH_IN_PREFIX, planCameraPunchIns, samePunchIns } from "./cameraPunchIns";

const clip = (id: string, assetId: string, startSec: number, endSec: number) => ({
	id,
	assetId,
	sourceStartSec: startSec,
	sourceEndSec: endSec,
	timelineStartSec: startSec,
	timelineEndSec: endSec,
	wordRefs: [],
	origin: "user" as const,
	reason: "",
});

const head = { id: "head", kind: "video", originalPath: "/tmp/recording-1.mov", cameraTrack: null };
const screen = {
	id: "screen",
	kind: "video",
	originalPath: "/tmp/recording-2.mp4",
	cameraTrack: null,
};

function doc(overrides: Record<string, unknown> = {}): AxcutDocument {
	return {
		schemaVersion: 8,
		assets: [head, screen],
		timeline: { clips: [], gaps: [], trimRanges: [] },
		zoomRanges: [],
		cameraZoomRanges: [],
		legacyEditor: null,
		...overrides,
	} as unknown as AxcutDocument;
}

const four = [
	clip("c1", "head", 0, 5),
	clip("c2", "head", 5, 9),
	clip("c3", "head", 9, 14),
	clip("c4", "head", 14, 20),
];

describe("planCameraPunchIns", () => {
	it("punches in every other clip of a talking head run, the first stays wide", () => {
		const zooms = planCameraPunchIns(doc({ timeline: { clips: four } }));
		expect(zooms.map((z) => z.clipId)).toEqual(["c2", "c4"]);
		expect(zooms.map((z) => [z.startMs, z.endMs])).toEqual([
			[5000, 9000],
			[14_000, 20_000],
		]);
		for (const z of zooms) {
			expect(z.id.startsWith(`${CAMERA_PUNCH_IN_PREFIX}_`)).toBe(true);
			expect(z).toMatchObject({ depth: 2, focusMode: "auto", source: "auto", motion: "hold" });
		}
	});

	it("gives nothing on a screen take with no full camera", () => {
		const clips = [clip("c1", "screen", 0, 5), clip("c2", "screen", 5, 9)];
		expect(planCameraPunchIns(doc({ timeline: { clips } }))).toEqual([]);
	});

	it("takes clips wholly inside a camera-fullscreen moment as a run", () => {
		const clips = [
			clip("c1", "screen", 0, 5),
			clip("c2", "screen", 5, 9),
			clip("c3", "screen", 9, 14),
			clip("c4", "screen", 14, 20),
		];
		const zooms = planCameraPunchIns(
			doc({
				timeline: { clips },
				legacyEditor: { cameraFullscreenRegions: [{ id: "f", startMs: 5000, endMs: 20_000 }] },
			}),
		);
		// The run is c2..c4: c2 is wide, c3 is punched in.
		expect(zooms.map((z) => z.clipId)).toEqual(["c3"]);
	});

	it("starts a new run where the clips do not touch or the picture is not the camera", () => {
		const clips = [
			clip("c1", "head", 0, 5),
			clip("c2", "screen", 5, 9),
			clip("c3", "head", 9, 14),
			clip("c4", "head", 14, 20),
		];
		const zooms = planCameraPunchIns(doc({ timeline: { clips } }));
		expect(zooms.map((z) => z.clipId)).toEqual(["c4"]);
	});

	it("leaves a clip with a camera zoom of its own and keeps the rhythm", () => {
		const manual = {
			id: "camzoom_1",
			startMs: 5500,
			endMs: 7000,
			depth: 3,
			focus: { cx: 0.5, cy: 0.4 },
			source: "manual",
		};
		const zooms = planCameraPunchIns(
			doc({ timeline: { clips: four }, cameraZoomRanges: [manual] }),
		);
		expect(zooms.map((z) => z.clipId)).toEqual(["c4"]);
	});

	it("does not count its own earlier zooms as the user's", () => {
		const own = {
			id: "cpunch_old",
			startMs: 5000,
			endMs: 9000,
			depth: 2,
			focus: { cx: 0.5, cy: 0.4 },
			source: "auto",
		};
		const zooms = planCameraPunchIns(doc({ timeline: { clips: four }, cameraZoomRanges: [own] }));
		expect(zooms.map((z) => z.clipId)).toEqual(["c2", "c4"]);
	});

	const manualAt = (startMs: number, endMs: number) => ({
		id: "camzoom_m",
		startMs,
		endMs,
		depth: 3,
		focus: { cx: 0.5, cy: 0.4 },
		source: "manual",
	});

	it("counts a skipped clip as pushed in: a zoom of yours on clip 3 leaves clip 4 wide", () => {
		const zooms = planCameraPunchIns(
			doc({ timeline: { clips: four }, cameraZoomRanges: [manualAt(10_000, 11_000)] }),
		);
		expect(zooms.map((z) => z.clipId)).toEqual(["c2"]);
	});

	it("counts a skipped first clip as pushed in: a zoom of yours on clip 1 gives clip 3 only", () => {
		const zooms = planCameraPunchIns(
			doc({ timeline: { clips: four }, cameraZoomRanges: [manualAt(500, 1500)] }),
		);
		expect(zooms.map((z) => z.clipId)).toEqual(["c3"]);
	});

	const trim = (id: string, clipId: string, startSec: number, endSec: number) => ({
		id,
		assetId: "head",
		clipId,
		startSec,
		endSec,
		reason: "",
		origin: "user" as const,
	});
	const spans = (zooms: Array<{ startMs: number; endMs: number }>) =>
		zooms.map((z) => [z.startMs, z.endMs]);

	it("counts a trim hole as a cut: one talking-head clip with two holes punches in its middle piece", () => {
		// Pieces on the ruler: 0-5, 7-12, 14-20 (a trim leaves its hole on the ruler).
		const zooms = planCameraPunchIns(
			doc({
				timeline: {
					clips: [clip("c1", "head", 0, 20)],
					gaps: [],
					trimRanges: [trim("t1", "c1", 5, 7), trim("t2", "c1", 12, 14)],
				},
			}),
		);
		expect(spans(zooms)).toEqual([[7000, 12_000]]);
		expect(zooms[0]).toMatchObject({ clipId: "c1", depth: 2, focusMode: "auto", motion: "hold" });
	});

	it("goes on across a trim hole into the next clip, and across a clip trimmed away whole", () => {
		// c1's pieces 0-4 and 6-10, then c2 (10-15) trimmed away whole, then c3 15-20.
		const zooms = planCameraPunchIns(
			doc({
				timeline: {
					clips: [
						clip("c1", "head", 0, 10),
						clip("c2", "head", 10, 15),
						clip("c3", "head", 15, 20),
					],
					gaps: [],
					trimRanges: [trim("t1", "c1", 4, 6), trim("t2", "c2", 10, 15)],
				},
			}),
		);
		// 0-4 wide, 6-10 in, c2 plays nothing, 15-20 wide.
		expect(spans(zooms)).toEqual([[6000, 10_000]]);
	});

	it("leaves a piece with a camera zoom of its own and keeps the rhythm across holes", () => {
		const zooms = planCameraPunchIns(
			doc({
				timeline: {
					clips: [clip("c1", "head", 0, 20)],
					gaps: [],
					trimRanges: [trim("t1", "c1", 5, 7), trim("t2", "c1", 12, 14)],
				},
				// Yours on the first piece: it counts as pushed in, so 7-12 is wide and 14-20 in.
				cameraZoomRanges: [manualAt(1000, 2000)],
			}),
		);
		expect(spans(zooms)).toEqual([[14_000, 20_000]]);
	});
});

describe("samePunchIns", () => {
	it("is true for the same punch-ins under new ids, false when one differs", () => {
		const document = doc({ timeline: { clips: four } });
		const first = planCameraPunchIns(document);
		const again = planCameraPunchIns(document);
		expect(again.map((z) => z.id)).not.toEqual(first.map((z) => z.id));
		expect(samePunchIns(first, again)).toBe(true);
		expect(samePunchIns(first, again.slice(1))).toBe(false);
		expect(samePunchIns(first, [{ ...again[0], depth: 3 }, again[1]])).toBe(false);
		expect(samePunchIns([], [])).toBe(true);
	});
});
