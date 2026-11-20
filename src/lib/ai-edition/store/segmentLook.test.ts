import { describe, expect, it } from "vitest";
import type { AxcutDocument } from "../schema";
import {
	applyLookToAllClips,
	clipUnderPlayhead,
	getClipEditorSettings,
	getEditorSettings,
	patchClipLook,
	splitLookPatch,
} from "./editorSettings";
import { applySegmentSettingsPatch } from "./settingsPatch";

const clip = (id: string, start: number, end: number) => ({
	id,
	assetId: "a",
	sourceStartSec: start,
	sourceEndSec: end,
	timelineStartSec: start,
	timelineEndSec: end,
	wordRefs: [],
	origin: "user" as const,
	reason: "",
});

const twoClips = (): AxcutDocument =>
	({
		timeline: { clips: [clip("one", 0, 5), clip("two", 5, 10)], trimRanges: [] },
		annotations: [],
		legacyEditor: { padding: 30, aspectRatio: "9:16", wallpaper: "/wallpapers/wallpaper3.jpg" },
	}) as unknown as AxcutDocument;

const clipOf = (doc: AxcutDocument, id: string) =>
	doc.timeline.clips.find((c) => c.id === id) as AxcutDocument["timeline"]["clips"][number];

describe("the look of a segment", () => {
	it("changes only the clip the program is showing", () => {
		const doc = applySegmentSettingsPatch(twoClips(), { padding: 8 }, 7);
		expect(getClipEditorSettings(doc, clipOf(doc, "two")).padding).toBe(8);
		expect(getClipEditorSettings(doc, clipOf(doc, "one")).padding).toBe(30);
		expect(getEditorSettings(doc).padding).toBe(30);
	});

	it("keeps what belongs to the project on the project", () => {
		const doc = applySegmentSettingsPatch(
			twoClips(),
			{ wallpaper: "/wallpapers/wallpaper7.jpg", padding: 8 },
			1,
		);
		expect(getEditorSettings(doc).wallpaper).toBe("/wallpapers/wallpaper7.jpg");
		expect(clipOf(doc, "one").look).toEqual({ padding: 8 });
		expect(clipOf(doc, "two").look).toBeUndefined();
	});

	it("stores nothing once a clip is back to the project's value", () => {
		const changed = patchClipLook(twoClips(), "one", { padding: 8 });
		const back = patchClipLook(changed, "one", { padding: 30 });
		expect(clipOf(back, "one").look).toBeUndefined();
	});

	it("leaves a project of one clip on the project, so splitting it later keeps both alike", () => {
		const one = { ...twoClips() };
		one.timeline = { ...one.timeline, clips: [clip("only", 0, 5)] };
		const doc = applySegmentSettingsPatch(one, { padding: 8 }, 1);
		expect(getEditorSettings(doc).padding).toBe(8);
		expect(clipOf(doc, "only").look).toBeUndefined();
	});

	it("leaves the camera alone when a layout is picked", () => {
		expect(splitLookPatch({ webcamLayoutPreset: "dual-frame" }).look).toEqual({
			webcamLayoutPreset: "dual-frame",
			segmentScene: null,
		});
		const camera = patchClipLook(twoClips(), "one", { segmentScene: "camera" });
		expect(getClipEditorSettings(camera, clipOf(camera, "one")).segmentScene).toBe("camera");
		const stack = applySegmentSettingsPatch(camera, { webcamLayoutPreset: "vertical-stack" }, 1);
		expect(getClipEditorSettings(stack, clipOf(stack, "one")).segmentScene).toBeNull();
	});

	it("gives every clip one look, and clips to come too", () => {
		const doc = patchClipLook(patchClipLook(twoClips(), "one", { padding: 8 }), "two", {
			padding: 50,
		});
		const all = applyLookToAllClips(doc, "one");
		expect(getEditorSettings(all).padding).toBe(8);
		expect(all.timeline.clips.every((c) => c.look === undefined)).toBe(true);
	});

	it("acts on the clip under the playhead, or the last one past the end", () => {
		const doc = twoClips();
		expect(clipUnderPlayhead(doc, 0)?.id).toBe("one");
		expect(clipUnderPlayhead(doc, 5)?.id).toBe("two");
		expect(clipUnderPlayhead(doc, 99)?.id).toBe("two");
		expect(clipUnderPlayhead(null, 0)).toBeNull();
	});
});
