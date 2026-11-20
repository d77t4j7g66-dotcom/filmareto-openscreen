import { describe, expect, it } from "vitest";
import { type AxcutDocument, documentSchema } from "../schema";
import { insertAssetClip, removeClip } from "./timeline";

const NOW = "2026-11-05T10:00:00.000Z";
const emptyDoc = (): AxcutDocument =>
	documentSchema.parse({
		schemaVersion: 8,
		project: { id: "p", title: "t", createdAt: NOW, updatedAt: NOW, primaryAssetId: "a" },
		assets: [{ id: "a", kind: "video", label: "take", originalPath: "/take.mp4", durationSec: 12 }],
		timeline: { clips: [] },
	});

const add = (doc: AxcutDocument, id: string, start: number, end: number, segmentId?: string) =>
	insertAssetClip(doc, doc.timeline.clips.length, {
		id,
		assetId: "a",
		sourceStartSec: start,
		sourceEndSec: end,
		origin: "user",
		reason: "",
		...(segmentId ? { segmentId } : {}),
	});

describe("segments of one take", () => {
	it("stay separate clips, though their media meets", () => {
		let doc = add(emptyDoc(), "c1", 0, 4, "s1");
		doc = add(doc, "c2", 4, 8, "s2");
		doc = add(doc, "c3", 8, 12, "s3");
		expect(doc.timeline.clips.map((clip) => clip.id)).toEqual(["c1", "c2", "c3"]);
		expect(doc.timeline.clips.at(-1)?.timelineEndSec).toBe(12);
	});

	it("survive saving, and close the gap when one is deleted", () => {
		let doc = add(emptyDoc(), "c1", 0, 4, "s1");
		doc = add(doc, "c2", 4, 8, "s2");
		doc = add(doc, "c3", 8, 12, "s3");
		const saved = documentSchema.parse(JSON.parse(JSON.stringify(doc)));
		expect(saved.timeline.clips.map((clip) => clip.segmentId)).toEqual(["s1", "s2", "s3"]);
		const left = removeClip(saved, "c2").timeline.clips;
		expect(left.map((clip) => [clip.id, clip.timelineStartSec, clip.timelineEndSec])).toEqual([
			["c1", 0, 4],
			["c3", 4, 8],
		]);
	});

	it("still fold when they are not segments, as clips always have", () => {
		let doc = add(emptyDoc(), "c1", 0, 4);
		doc = add(doc, "c2", 4, 8);
		expect(doc.timeline.clips.map((clip) => clip.id)).toEqual(["c1"]);
	});
});
