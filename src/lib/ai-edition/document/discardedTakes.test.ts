import { describe, expect, it } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import { markDiscardedTakes, usedAssetIds } from "./discardedTakes";
import { removeClip } from "./timeline";

function doc(): AxcutDocument {
	const base = createEmptyDocument({ projectId: "p", title: "P" });
	const asset = (id: string) => ({
		id,
		kind: "video",
		label: id,
		originalPath: `/r/${id}.mp4`,
		cameraTrack: null,
	});
	const clip = (id: string, assetId: string, at: number, alternates?: unknown[]) => ({
		id,
		assetId,
		sourceStartSec: 0,
		sourceEndSec: 5,
		timelineStartSec: at,
		timelineEndSec: at + 5,
		...(alternates ? { alternates } : {}),
	});
	return {
		...base,
		assets: [asset("a"), asset("b"), asset("c"), asset("idle")],
		timeline: {
			...base.timeline,
			clips: [
				clip("c1", "a", 0),
				clip("c2", "a", 5),
				clip("c3", "b", 10, [{ assetId: "c", sourceStartSec: 0, sourceEndSec: 3 }]),
			],
		},
	} as unknown as AxcutDocument;
}

describe("markDiscardedTakes", () => {
	it("marks the take whose last clip was deleted, and the attempts that went with it", () => {
		const before = doc();
		const after = markDiscardedTakes(before, removeClip(before, "c3"), "2026-11-22T04:00:00.000Z");
		const marks = Object.fromEntries(after.assets.map((a) => [a.id, a.discardedAt ?? null]));
		expect(marks).toEqual({
			a: null,
			b: "2026-11-22T04:00:00.000Z",
			c: "2026-11-22T04:00:00.000Z",
			idle: null,
		});
	});

	it("marks nothing while another clip still shows the take", () => {
		const before = doc();
		const after = markDiscardedTakes(before, removeClip(before, "c1"), "now");
		expect(after.assets.every((a) => a.discardedAt === undefined)).toBe(true);
	});

	it("never marks media that was not on the timeline to begin with", () => {
		const before = doc();
		const after = markDiscardedTakes(before, removeClip(before, "c3"), "now");
		expect(after.assets.find((a) => a.id === "idle")?.discardedAt).toBeUndefined();
		expect(usedAssetIds(before).has("idle")).toBe(false);
	});
});
