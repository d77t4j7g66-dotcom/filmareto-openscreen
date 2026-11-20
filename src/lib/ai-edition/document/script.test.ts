import { describe, expect, it } from "vitest";
import type { AxcutDocument } from "../schema";
import { clipLabel, prompterTextOf, splitPastedScript } from "./script";
import { placeSceneTake } from "./timeline";

const scenes = [
	{ id: "s1", name: "Hook", text: "Πρώτο." },
	{ id: "s2", name: "Βήμα", text: "" },
	{ id: "s3", name: "CTA", text: "Τρίτο." },
];

const empty = (): AxcutDocument =>
	({
		assets: [
			{ id: "a", kind: "video", durationSec: 20 },
			{ id: "b", kind: "video", durationSec: 20 },
		],
		timeline: {
			clips: [],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		audioTracks: [],
		legacyEditor: {},
		script: { scenes },
	}) as unknown as AxcutDocument;

const order = scenes.map((s) => s.id);
const take = (sceneId: string, assetId: string, startSec: number, endSec: number) => ({
	clipId: `clip-${sceneId}-${assetId}`,
	sceneId,
	assetId,
	startSec,
	endSec,
});
const shown = (doc: AxcutDocument) =>
	doc.timeline.clips.map((c) => [c.sceneId, c.assetId, c.timelineStartSec, c.timelineEndSec]);

describe("the script", () => {
	it("gives the teleprompter a segment for every scene, written or not", () => {
		expect(prompterTextOf(scenes)).toBe("Πρώτο.\n/\nΒήμα\n/\nΤρίτο.");
	});

	it("splits a pasted script at its / lines", () => {
		expect(splitPastedScript("Ένα.\n/\nΔύο.\n /\nΤρία.")).toEqual(["Ένα.", "Δύο.", "Τρία."]);
		expect(splitPastedScript("Χωρίς / κάθετο")).toEqual(["Χωρίς / κάθετο"]);
	});

	it("names a clip after its scene", () => {
		const doc = empty();
		expect(clipLabel(doc, { sceneId: "s3", reason: "" }, 0)).toBe("CTA");
		expect(clipLabel(doc, { reason: "Segment 2" }, 0)).toBe("Segment 2");
		expect(clipLabel(doc, { reason: "" }, 4)).toBe("Clip 5");
	});
});

describe("a take of a scene", () => {
	it("goes where its scene is in the script, whatever the order they were recorded in", () => {
		let doc = placeSceneTake(empty(), take("s3", "a", 0, 4), order);
		doc = placeSceneTake(doc, take("s1", "b", 0, 2), order);
		doc = placeSceneTake(doc, take("s2", "a", 4, 7), order);
		expect(shown(doc)).toEqual([
			["s1", "b", 0, 2],
			["s2", "a", 2, 5],
			["s3", "a", 5, 9],
		]);
	});

	it("replaces the scene's last take, which stays as another take, even from another file", () => {
		let doc = placeSceneTake(empty(), take("s1", "a", 1, 3), order);
		doc = placeSceneTake(doc, take("s2", "a", 3, 5), order);
		doc = placeSceneTake(doc, take("s1", "b", 0, 5), order);
		expect(shown(doc)).toEqual([
			["s1", "b", 0, 5],
			["s2", "a", 5, 7],
		]);
		expect(doc.timeline.clips[0].alternates).toEqual([
			{ assetId: "a", sourceStartSec: 1, sourceEndSec: 3 },
		]);
	});

	it("keeps earlier attempts said in the same file as other takes", () => {
		const doc = placeSceneTake(
			empty(),
			{ ...take("s1", "a", 5, 8), earlier: [{ startSec: 0, endSec: 5 }] },
			order,
		);
		expect(doc.timeline.clips[0].alternates).toEqual([
			{ assetId: "a", sourceStartSec: 0, sourceEndSec: 5 },
		]);
	});
});
