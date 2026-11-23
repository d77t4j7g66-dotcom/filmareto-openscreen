import { describe, expect, it } from "vitest";
import type { AxcutDocument } from "../schema";
import { migrateRawDocumentToCurrent } from "../schema";
import {
	documentHasTiltedZoom,
	moveTakesZoomsToCameraLane,
	splitZoomsIntoCameraLane,
} from "./cameraZooms";

const zoom = (id: string, startMs: number, endMs: number, extra: Record<string, unknown> = {}) => ({
	id,
	startMs,
	endMs,
	depth: 3,
	focus: { cx: 0.5, cy: 0.5 },
	...extra,
});

const clip = (id: string, assetId: string, startSec: number, endSec: number, extra = {}) => ({
	id,
	assetId,
	sourceStartSec: startSec,
	sourceEndSec: endSec,
	timelineStartSec: startSec,
	timelineEndSec: endSec,
	...extra,
});

const screenAsset = { id: "screen", kind: "video", originalPath: "/tmp/recording-2.mp4" };
const headAsset = { id: "head", kind: "video", originalPath: "/tmp/recording-1.mov" };

function doc(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		schemaVersion: 8,
		assets: [screenAsset, headAsset],
		timeline: { clips: [] },
		...overrides,
	};
}

const ids = (list: unknown) => (list as Array<{ id: string }>).map((z) => z.id);

describe("splitZoomsIntoCameraLane", () => {
	it("moves a talking head's zooms to the camera lane", () => {
		const raw = doc({
			timeline: { clips: [clip("c1", "head", 0, 10), clip("c2", "head", 10, 20)] },
			zoomRanges: [
				zoom("z1", 1000, 2000, { clipId: "c1" }),
				zoom("z2", 12_000, 13_000, { clipId: "c2" }),
			],
		});
		const out = splitZoomsIntoCameraLane(raw);
		expect(out.zoomRanges).toEqual([]);
		expect(ids(out.cameraZoomRanges)).toEqual(["z1", "z2"]);
	});

	it("moves a zoom inside a camera-fullscreen moment, keeps one that crosses its edge", () => {
		const raw = doc({
			timeline: { clips: [clip("c1", "screen", 0, 30)] },
			legacyEditor: { cameraFullscreenRegions: [{ id: "cf", startMs: 5000, endMs: 10_000 }] },
			zoomRanges: [
				zoom("inside", 6000, 9000),
				zoom("exact", 5000, 10_000, { depth: 4 }),
				zoom("crosses", 9000, 11_000, { depth: 5 }),
			],
		});
		const out = splitZoomsIntoCameraLane(raw);
		expect(ids(out.cameraZoomRanges)).toEqual(["inside", "exact"]);
		expect(ids(out.zoomRanges)).toEqual(["crosses"]);
	});

	it("judges a zoom whole across a clip boundary, not row by row", () => {
		// Moment 5-10s, clips cut at 8s. A zoom 6-11s is stored as 6-8 and 8-11 and sticks out of
		// the moment, so both rows stay; a zoom 6-9s inside it moves with both rows.
		const raw = doc({
			timeline: { clips: [clip("c1", "screen", 0, 8), clip("c2", "screen", 8, 20)] },
			legacyEditor: {
				cameraFullscreenRegions: [
					{ id: "cf1", startMs: 5000, endMs: 8000, clipId: "c1" },
					{ id: "cf2", startMs: 8000, endMs: 10_000, clipId: "c2" },
				],
			},
			zoomRanges: [
				zoom("out1", 6000, 8000, { clipId: "c1" }),
				zoom("out2", 8000, 11_000, { clipId: "c2" }),
				zoom("in1", 6000, 8000, { clipId: "c1", depth: 5 }),
				zoom("in2", 8000, 9000, { clipId: "c2", depth: 5 }),
			],
		});
		const out = splitZoomsIntoCameraLane(raw);
		expect(ids(out.zoomRanges)).toEqual(["out1", "out2"]);
		expect(ids(out.cameraZoomRanges)).toEqual(["in1", "in2"]);
	});

	it("treats a clip whose look is the camera scene as one long moment", () => {
		const raw = doc({
			timeline: {
				clips: [
					clip("c1", "screen", 0, 10, { look: { segmentScene: "camera" } }),
					clip("c2", "screen", 10, 20),
				],
			},
			zoomRanges: [zoom("a", 1000, 2000, { clipId: "c1" }), zoom("b", 12_000, 13_000)],
		});
		const out = splitZoomsIntoCameraLane(raw);
		expect(ids(out.cameraZoomRanges)).toEqual(["a"]);
		expect(ids(out.zoomRanges)).toEqual(["b"]);
	});

	it("finds the clip from the ruler time when the zoom has no anchor", () => {
		const raw = doc({
			timeline: { clips: [clip("c1", "screen", 0, 10), clip("c2", "head", 10, 20)] },
			zoomRanges: [zoom("a", 1000, 2000), zoom("b", 12_000, 13_000)],
		});
		const out = splitZoomsIntoCameraLane(raw);
		expect(ids(out.cameraZoomRanges)).toEqual(["b"]);
		expect(ids(out.zoomRanges)).toEqual(["a"]);
	});

	it("leaves a screen take's zooms on the screen", () => {
		const raw = doc({
			timeline: { clips: [clip("c1", "screen", 0, 10)] },
			zoomRanges: [zoom("z1", 1000, 2000, { clipId: "c1" })],
		});
		const out = splitZoomsIntoCameraLane(raw);
		expect(ids(out.zoomRanges)).toEqual(["z1"]);
		expect(out.cameraZoomRanges).toEqual([]);
	});

	it("keeps a screen take with a camera beside it on the screen", () => {
		const withCamera = { ...headAsset, id: "both", cameraTrack: { path: "/tmp/x-webcam.mov" } };
		const raw = doc({
			assets: [withCamera],
			timeline: { clips: [clip("c1", "both", 0, 10)] },
			zoomRanges: [zoom("z1", 1000, 2000, { clipId: "c1" })],
		});
		expect(ids(splitZoomsIntoCameraLane(raw).zoomRanges)).toEqual(["z1"]);
	});

	it("runs once: a document that has cameraZoomRanges, even empty, is untouched", () => {
		const raw = doc({
			timeline: { clips: [clip("c1", "head", 0, 10)] },
			zoomRanges: [zoom("z1", 1000, 2000, { clipId: "c1" })],
			cameraZoomRanges: [],
		});
		expect(splitZoomsIntoCameraLane(raw)).toBe(raw);
		expect(migrateRawDocumentToCurrent(raw)).toMatchObject({
			zoomRanges: [{ id: "z1" }],
			cameraZoomRanges: [],
		});
	});

	it("adds an empty list to a document with no zooms at all", () => {
		expect(splitZoomsIntoCameraLane({ schemaVersion: 8 })).toEqual({
			schemaVersion: 8,
			cameraZoomRanges: [],
		});
	});

	it("a zoom moved by a camera moment or a camera scene closes in on the upper middle, on Auto", () => {
		// Before the split the full camera ignored the zoom's focus (here a click on the screen) and
		// closed in on [0.5, 0.4]: the camera lane keeps that, as Auto with that fallback point.
		const click = { focus: { cx: 0.85, cy: 0.15 }, focusMode: "manual" };
		const raw = doc({
			timeline: {
				clips: [
					clip("c1", "screen", 0, 10),
					clip("c2", "screen", 10, 20, { look: { segmentScene: "camera" } }),
				],
			},
			legacyEditor: { cameraFullscreenRegions: [{ id: "cf", startMs: 2000, endMs: 8000 }] },
			zoomRanges: [
				zoom("moment", 3000, 5000, { clipId: "c1", ...click }),
				zoom("scene", 12_000, 14_000, { clipId: "c2", ...click }),
			],
		});
		const out = splitZoomsIntoCameraLane(raw);
		expect(out.cameraZoomRanges).toEqual([
			expect.objectContaining({ id: "moment", focus: { cx: 0.5, cy: 0.4 }, focusMode: "auto" }),
			expect.objectContaining({ id: "scene", focus: { cx: 0.5, cy: 0.4 }, focusMode: "auto" }),
		]);
		// Nothing else about it changes.
		expect(out.cameraZoomRanges).toEqual([
			expect.objectContaining({ startMs: 3000, endMs: 5000, depth: 3 }),
			expect.objectContaining({ startMs: 12_000, endMs: 14_000, depth: 3 }),
		]);
	});

	it("a talking head's zoom keeps its own focus, even inside a camera moment", () => {
		const own = { focus: { cx: 0.7, cy: 0.25 }, focusMode: "manual" };
		const raw = doc({
			timeline: { clips: [clip("c1", "head", 0, 10)] },
			legacyEditor: { cameraFullscreenRegions: [{ id: "cf", startMs: 0, endMs: 10_000 }] },
			zoomRanges: [
				zoom("z1", 1000, 2000, { clipId: "c1", ...own }),
				zoom("z2", 4000, 5000, { clipId: "c1" }),
			],
		});
		const out = splitZoomsIntoCameraLane(raw);
		expect(out.cameraZoomRanges).toEqual([
			zoom("z1", 1000, 2000, { clipId: "c1", ...own }),
			zoom("z2", 4000, 5000, { clipId: "c1" }),
		]);
	});

	it("is chained into the load-time migration", () => {
		const raw = doc({
			timeline: { clips: [clip("c1", "head", 0, 10)] },
			zoomRanges: [zoom("z1", 1000, 2000, { clipId: "c1" })],
		});
		const out = migrateRawDocumentToCurrent(raw) as Record<string, unknown>;
		expect(ids(out.cameraZoomRanges)).toEqual(["z1"]);
		expect(out.zoomRanges).toEqual([]);
	});
});

describe("moveTakesZoomsToCameraLane", () => {
	const typed = (overrides: Record<string, unknown>) =>
		({ cameraZoomRanges: [], ...doc(overrides) }) as unknown as AxcutDocument;
	const clips = [
		clip("c1", "head", 0, 10),
		clip("c2", "head", 10, 20),
		clip("c3", "screen", 20, 30),
	];

	it("moves the take's whole pills to the camera lane, focus and all", () => {
		const own = { focus: { cx: 0.7, cy: 0.2 }, focusMode: "manual" };
		const document = typed({
			timeline: { clips },
			zoomRanges: [
				zoom("a", 1000, 2000, { clipId: "c1", ...own }),
				// One pill across the cut between two clips of the take.
				zoom("b1", 8000, 10_000, { clipId: "c1" }),
				zoom("b2", 10_000, 12_000, { clipId: "c2" }),
				zoom("screen", 22_000, 24_000, { clipId: "c3" }),
				// Across the take and the screen take: it stays whole, on the screen.
				zoom("x1", 18_000, 20_000, { clipId: "c2", depth: 5 }),
				zoom("x2", 20_000, 21_000, { clipId: "c3", depth: 5 }),
			],
		});
		const out = moveTakesZoomsToCameraLane(document, new Set(["head"]));
		expect(ids(out.cameraZoomRanges)).toEqual(["a", "b1", "b2"]);
		expect(out.cameraZoomRanges?.[0]).toEqual(zoom("a", 1000, 2000, { clipId: "c1", ...own }));
		expect(ids(out.zoomRanges)).toEqual(["screen", "x1", "x2"]);
	});

	it("leaves a pill that would overlap a camera zoom on the screen, and the document as it was when nothing moves", () => {
		const document = typed({
			timeline: { clips },
			zoomRanges: [zoom("a", 1000, 3000, { clipId: "c1" })],
			cameraZoomRanges: [zoom("cam", 2000, 4000, { clipId: "c1" })],
		});
		expect(moveTakesZoomsToCameraLane(document, new Set(["head"]))).toBe(document);
		expect(moveTakesZoomsToCameraLane(document, new Set())).toBe(document);
	});

	it("never moves a screen take's zooms, even when asked to", () => {
		const document = typed({
			timeline: { clips },
			zoomRanges: [zoom("s", 22_000, 24_000, { clipId: "c3" })],
		});
		expect(moveTakesZoomsToCameraLane(document, new Set(["screen"]))).toBe(document);
		// A take with a camera beside it is a screen take, whatever its face says.
		const withCamera = typed({
			assets: [{ ...headAsset, cameraTrack: { sourcePath: "/tmp/c.mov" }, face: null }],
			timeline: { clips: [clip("c1", "head", 0, 10)] },
			zoomRanges: [zoom("z", 1000, 2000, { clipId: "c1" })],
		});
		expect(moveTakesZoomsToCameraLane(withCamera, new Set(["head"]))).toBe(withCamera);
	});
});

describe("documentHasTiltedZoom", () => {
	const typed = (overrides: Record<string, unknown>) =>
		({ cameraZoomRanges: [], zoomRanges: [], ...doc(overrides) }) as unknown as AxcutDocument;
	const clips = [clip("c1", "head", 0, 10), clip("c2", "screen", 10, 20)];
	const tilted = { rotationPreset: "left" };

	it("counts a tilted screen zoom, and a tilted camera zoom on a talking head", () => {
		expect(documentHasTiltedZoom(typed({ timeline: { clips } }))).toBe(false);
		expect(
			documentHasTiltedZoom(
				typed({ timeline: { clips }, zoomRanges: [zoom("s", 11_000, 12_000, tilted)] }),
			),
		).toBe(true);
		// A talking head's camera zoom renders on the main picture and keeps its rotation.
		expect(
			documentHasTiltedZoom(
				typed({
					timeline: { clips },
					cameraZoomRanges: [zoom("c", 1000, 2000, { clipId: "c1", ...tilted })],
				}),
			),
		).toBe(true);
	});

	it("does not count one on the camera layer, which is drawn flat", () => {
		expect(
			documentHasTiltedZoom(
				typed({
					timeline: { clips },
					cameraZoomRanges: [zoom("c", 11_000, 12_000, { clipId: "c2", ...tilted })],
				}),
			),
		).toBe(false);
	});
});
