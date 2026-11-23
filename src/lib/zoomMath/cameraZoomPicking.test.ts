import { describe, expect, it } from "vitest";
import type { AxcutAsset } from "@/lib/ai-edition/schema";
import { cameraZoomOnMainPicture, cameraZoomPicking } from "./cameraZoomPicking";

const manual = { id: "c", focusMode: "manual" as const };
const unset = { id: "c" };
const auto = { id: "c", focusMode: "auto" as const };

describe("cameraZoomPicking", () => {
	it("picks a manual camera zoom on the camera box and keeps the layout handles off it", () => {
		const r = cameraZoomPicking(manual, false);
		expect(r.onCamera).toBe(manual);
		expect(r.onScreen).toBeNull();
		expect(r.blocksLayoutHandles).toBe(true);
	});

	it("reads an unset mode as manual", () => {
		expect(cameraZoomPicking(unset, false).onCamera).toBe(unset);
	});

	it("shows no overlay for Auto, on a talking head or not", () => {
		for (const head of [true, false]) {
			const r = cameraZoomPicking(auto, head);
			expect(r).toEqual({ onScreen: null, onCamera: null, blocksLayoutHandles: false });
		}
	});

	it("picks a manual talking-head camera zoom on the main picture", () => {
		const r = cameraZoomPicking(manual, true);
		expect(r.onScreen).toBe(manual);
		expect(r.onCamera).toBeNull();
		expect(r.blocksLayoutHandles).toBe(false);
	});
});

describe("cameraZoomOnMainPicture", () => {
	const assets = [
		{ id: "head", kind: "video", originalPath: "/x/recording-1.mov", face: null },
		{
			id: "screen",
			kind: "video",
			originalPath: "/x/s.mp4",
			cameraTrack: { sourcePath: "/x/c.mov" },
		},
	] as unknown as AxcutAsset[];
	const clips = [
		{ id: "h", assetId: "head", timelineStartSec: 0, timelineEndSec: 10 },
		{ id: "s", assetId: "screen", timelineStartSec: 10, timelineEndSec: 20 },
	];

	it("judges the zoom on its own clip, not on the clip under the playhead", () => {
		const onHead = { clipId: "h", startMs: 2000 };
		const onScreen = { clipId: "s", startMs: 12_000 };
		// The playhead on the screen take, the zoom on the talking head: the main picture.
		expect(cameraZoomOnMainPicture(assets, clips, onHead, clips[1])).toBe(true);
		// And the other way round: the camera box.
		expect(cameraZoomOnMainPicture(assets, clips, onScreen, clips[0])).toBe(false);
		// No anchor: the clip at its start.
		expect(cameraZoomOnMainPicture(assets, clips, { startMs: 3000 }, clips[1])).toBe(true);
	});

	it("falls back on the clip under the playhead when the zoom's clip is not found", () => {
		expect(cameraZoomOnMainPicture(assets, clips, { startMs: 99_000 }, clips[0])).toBe(true);
		expect(cameraZoomOnMainPicture(assets, clips, null, clips[1])).toBe(false);
	});
});
