import { describe, expect, it } from "vitest";
import {
	type AxcutAsset,
	type AxcutClip,
	type AxcutDocument,
	axcutSchemaVersion,
} from "@/lib/ai-edition/schema";
import { getClipEditorSettings, getEditorSettings } from "../store/editorSettings";
import {
	clearOwnFramePositions,
	clipsWithOwnFramePosition,
	fillPositionApplies,
	framePositionAt,
	framePositionPatch,
	framePositionShare,
	framePositionStart,
	framePositionTarget,
	framePositionValue,
	hasTakeFramePosition,
	mainTakeIsCamera,
} from "./framePosition";

const CAMERA = { sourcePath: "/cam.mov", startMs: 0, offsetMs: 0, visible: true };

/** A talking head: no camera beside it, looked at for a face. */
const head = (id = "a1", face: AxcutAsset["face"] = { x: 0.7, y: 0.4 }): AxcutAsset => ({
	kind: "video",
	id,
	label: id,
	originalPath: `/${id}.mov`,
	cameraTrack: null,
	face,
	video: { width: 1920, height: 1080 } as AxcutAsset["video"],
});

/** A take with no camera beside it that nobody has looked at for a face yet. */
const notLookedAt = (): AxcutAsset => {
	const { face: _face, ...asset } = head();
	return asset as AxcutAsset;
};

/** A screen take, with its camera beside it or not (no face: it has a pointer). */
const screenTake = (id = "s1", camera: Partial<typeof CAMERA> | null = CAMERA): AxcutAsset => ({
	kind: "video",
	id,
	label: id,
	originalPath: `/${id}.mp4`,
	cameraTrack: camera ? { ...CAMERA, ...camera } : null,
	video: { width: 1920, height: 1080 } as AxcutAsset["video"],
});

function clip(id: string, assetId: string, start = 0, look?: Record<string, unknown>): AxcutClip {
	return {
		id,
		assetId,
		sourceStartSec: 0,
		sourceEndSec: 5,
		timelineStartSec: start,
		timelineEndSec: start + 5,
		wordRefs: [],
		origin: "user",
		reason: "",
		...(look ? { look } : {}),
	};
}

function doc(
	assets: AxcutAsset[],
	clips: AxcutClip[],
	editor: Record<string, unknown> = {},
): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: {
			id: "p",
			title: "T",
			createdAt: "2026-11-22T10:00:00Z",
			updatedAt: "2026-11-22T10:00:00Z",
			primaryAssetId: assets[0]?.id ?? "a1",
		},
		assets,
		transcript: null,
		transcripts: [],
		timeline: {
			clips,
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		audioTracks: [],
		legacyEditor: editor,
	};
}

const VERTICAL_FILLED = { aspectRatio: "9:16", formatFollowCursor: true };

describe("which take is the camera", () => {
	it.each([
		["a talking head, a face found", head("a", { x: 0.5, y: 0.4 }), true],
		["a talking head, looked at and no face found", head("a", null), true],
		["a screen take with its camera beside it", screenTake("s", CAMERA), false],
		["a screen take with its camera hidden", screenTake("s", { visible: false }), false],
		["a screen take with a pointer, never looked at", screenTake("s", null), false],
		["a camera take not looked at yet", notLookedAt(), false],
		// The helper's own talking head is known by its file, before (or without) a face lookup.
		[
			"the helper's talking head, not looked at yet",
			{ ...notLookedAt(), originalPath: "/Movies/Filmareto/recording-1795382296970.mov" },
			true,
		],
		["the helper's screen take, not looked at", screenTake("s", null), false],
		[
			"a screen take's camera file imported on its own, not looked at",
			{ ...notLookedAt(), originalPath: "/Movies/recording-1795382296970-webcam.mov" },
			false,
		],
	])("%s", (_name, asset, expected) => {
		expect(mainTakeIsCamera(asset)).toBe(expected);
		// The rule the scene follows is the same one: a stored position shows only where its
		// control is.
		expect(fillPositionApplies(asset)).toBe(expected);
	});

	it("an audio file is no take at all", () => {
		expect(mainTakeIsCamera({ ...head(), kind: "audio" })).toBe(false);
		expect(mainTakeIsCamera(undefined)).toBe(false);
	});
});

describe("framePositionTarget", () => {
	it("places a talking head's own cut while the format is filled", () => {
		const d = doc([head()], [clip("c1", "a1")], VERTICAL_FILLED);
		const target = framePositionTarget(d, d.timeline.clips[0]);
		expect(target).toMatchObject({
			kind: "take",
			key: "fillPosition",
			axes: { horizontal: true, vertical: false },
			auto: true,
		});
		// The centre of a 9:16 cut of a 16:9 take travels between 0.158 and 0.842.
		expect(target?.travel?.x.min).toBeCloseTo(0.158, 3);
		expect(target?.travel?.x.max).toBeCloseTo(0.842, 3);
	});

	it("has nothing to place on a talking head shown whole, or in its own shape", () => {
		for (const editor of [
			{ aspectRatio: "9:16", formatFollowCursor: false },
			{ aspectRatio: "16:9", formatFollowCursor: true },
		]) {
			const d = doc([head()], [clip("c1", "a1")], editor);
			expect(framePositionTarget(d, d.timeline.clips[0])).toBeNull();
		}
	});

	it("keeps a portrait talking head in a landscape format, as before the move", () => {
		const portrait = { ...head(), video: { width: 1080, height: 1920 } as AxcutAsset["video"] };
		const d = doc([portrait], [clip("c1", "a1")], {
			aspectRatio: "16:9",
			formatFollowCursor: true,
		});
		expect(framePositionTarget(d, d.timeline.clips[0])?.axes).toEqual({
			horizontal: false,
			vertical: true,
		});
	});

	it("places the camera of a screen take, not the screen, in a vertical format", () => {
		// Filled or not: the camera is cut whenever it fills the frame.
		for (const formatFollowCursor of [true, false]) {
			const d = doc([screenTake()], [clip("c1", "s1")], {
				aspectRatio: "9:16",
				formatFollowCursor,
			});
			expect(framePositionTarget(d, d.timeline.clips[0])).toMatchObject({
				kind: "camera",
				key: "webcamCoverPan",
				axes: { horizontal: true, vertical: false },
				auto: true,
				travel: null,
			});
		}
	});

	// The "Webcam crop" framing places a zoomed crop by moving the rect it cuts.
	it("leaves a zoomed camera crop to its framing: nothing to place here", () => {
		const d = doc([screenTake()], [clip("c1", "s1")], {
			aspectRatio: "9:16",
			webcamCropRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
		});
		expect(framePositionTarget(d, d.timeline.clips[0])).toBeNull();
	});

	it("places a 16:9 camera in a square format too: it is cut there as well", () => {
		const d = doc([screenTake()], [clip("c1", "s1")], { aspectRatio: "1:1" });
		expect(framePositionTarget(d, d.timeline.clips[0])?.key).toBe("webcamCoverPan");
	});

	it("reads the crop of the clip it is asked about", () => {
		const zoomed = { webcamCropRegion: { x: 0, y: 0, width: 0.5, height: 0.5 } };
		const d = doc([screenTake()], [clip("c1", "s1"), clip("c2", "s1", 5, zoomed)], {
			aspectRatio: "9:16",
		});
		expect(framePositionTarget(d, d.timeline.clips[0])?.key).toBe("webcamCoverPan");
		expect(framePositionTarget(d, d.timeline.clips[1])).toBeNull();
	});

	it("has nothing to place for a screen with no camera, a hidden camera, or a landscape output", () => {
		const cases: Array<[AxcutAsset, Record<string, unknown>]> = [
			[screenTake("s1", null), VERTICAL_FILLED],
			[screenTake("s1", { visible: false }), VERTICAL_FILLED],
			[screenTake("s1", CAMERA), { aspectRatio: "16:9" }],
			// A portrait camera already fits a 9:16 frame.
			[screenTake("s1", { width: 1080, height: 1920 }), { aspectRatio: "9:16" }],
		];
		for (const [asset, editor] of cases) {
			const d = doc([asset], [clip("c1", "s1")], editor);
			expect(framePositionTarget(d, d.timeline.clips[0])).toBeNull();
		}
	});

	it("follows each clip of a mixed timeline", () => {
		const d = doc(
			[head("a1"), screenTake("s1")],
			[clip("c1", "a1"), clip("c2", "s1", 5)],
			VERTICAL_FILLED,
		);
		expect(framePositionTarget(d, d.timeline.clips[0])?.key).toBe("fillPosition");
		expect(framePositionTarget(d, d.timeline.clips[1])?.key).toBe("webcamCoverPan");
		expect(framePositionTarget(d, null)).toBeNull();
	});
});

describe("hasTakeFramePosition", () => {
	it("offers the camera pane for a talking head with a cut to place", () => {
		expect(hasTakeFramePosition(doc([head()], [clip("c1", "a1")], VERTICAL_FILLED))).toBe(true);
		expect(
			hasTakeFramePosition(
				doc([head()], [clip("c1", "a1")], { aspectRatio: "9:16", formatFollowCursor: false }),
			),
		).toBe(false);
		// A screen recording alone has no camera to frame.
		expect(
			hasTakeFramePosition(doc([screenTake("s1", null)], [clip("c1", "s1")], VERTICAL_FILLED)),
		).toBe(false);
	});
});

describe("values, shares and patches", () => {
	const take = () => {
		const d = doc([head()], [clip("c1", "a1")], VERTICAL_FILLED);
		const target = framePositionTarget(d, d.timeline.clips[0]);
		if (!target) throw new Error("no target");
		return { d, target };
	};
	const camera = (editor: Record<string, unknown> = {}) => {
		const d = doc([screenTake()], [clip("c1", "s1")], { aspectRatio: "9:16", ...editor });
		const target = framePositionTarget(d, d.timeline.clips[0]);
		if (!target) throw new Error("no target");
		return { d, target };
	};

	it("a talking head's slider maps the cut's real travel to its stored centre", () => {
		const { target } = take();
		expect(framePositionAt(target, "x", 0, { x: 0.5, y: 0.5 }).x).toBeCloseTo(0.158, 3);
		expect(framePositionAt(target, "x", 1, { x: 0.5, y: 0.5 }).x).toBeCloseTo(0.842, 3);
		expect(framePositionShare(target, "x", { x: 0.842, y: 0.5 })).toBeCloseTo(1, 3);
		expect(framePositionPatch(target, getEditorSettings(take().d), { x: 0.3, y: 0.5 })).toEqual({
			fillPosition: { x: 0.3, y: 0.5 },
		});
		expect(framePositionPatch(target, getEditorSettings(take().d), null)).toEqual({
			fillPosition: null,
		});
	});

	it("a talking head starts on its face when Auto is turned off", () => {
		const { target } = take();
		expect(framePositionStart(target, { x: 0.7, y: 0.4 })).toEqual({ x: 0.7, y: 0.5 });
		// Off the travel, the face is clamped to it.
		expect(framePositionStart(target, { x: 0.95, y: 0.4 }).x).toBeCloseTo(0.842, 3);
		expect(framePositionStart(target, null)).toEqual({ x: 0.5, y: 0.5 });
	});

	it("the camera's slider is the pan itself, and Auto is the centred cut", () => {
		const { d, target } = camera();
		const settings = getEditorSettings(d);
		expect(framePositionValue(target, settings)).toBeNull();
		expect(framePositionStart(target)).toEqual({ x: 0.5, y: 0.5 });
		expect(framePositionAt(target, "x", 0.2, { x: 0.5, y: 0.5 })).toEqual({ x: 0.2, y: 0.5 });
		expect(framePositionShare(target, "x", { x: 0.2, y: 0.5 })).toBe(0.2);
		expect(framePositionPatch(target, settings, { x: 0.2, y: 0.5 })).toEqual({
			webcamCoverPan: { x: 0.2, y: 0.5 },
		});
		expect(framePositionPatch(target, settings, null)).toEqual({ webcamCoverPan: null });
	});

	it("across a mirrored camera, left to right follows the picture as it is seen", () => {
		const { d, target } = camera({ webcamMirrored: true });
		expect(target.mirrored).toBe(true);
		// The left of the mirrored picture is the right of the camera's own file.
		expect(framePositionAt(target, "x", 0, { x: 0.5, y: 0.5 })).toEqual({ x: 1, y: 0.5 });
		expect(framePositionAt(target, "x", 0.2, { x: 0.5, y: 0.5 }).x).toBeCloseTo(0.8, 6);
		expect(framePositionShare(target, "x", { x: 0.8, y: 0.5 })).toBeCloseTo(0.2, 6);
		// Up and down are not mirrored.
		expect(framePositionAt(target, "y", 0.2, { x: 0.5, y: 0.5 }).y).toBeCloseTo(0.2, 6);
		expect(getEditorSettings(d).webcamMirrored).toBe(true);
		// A clip's own mirror counts, and a talking head's take is never the mirrored layer.
		const own = doc([screenTake()], [clip("c1", "s1", 0, { webcamMirrored: true })], {
			aspectRatio: "9:16",
		});
		expect(framePositionTarget(own, own.timeline.clips[0])?.mirrored).toBe(true);
		const talking = doc([head()], [clip("c1", "a1")], {
			...VERTICAL_FILLED,
			webcamMirrored: true,
		});
		expect(framePositionTarget(talking, talking.timeline.clips[0])?.mirrored).toBe(false);
	});
});

describe("own positions", () => {
	const mixed = () =>
		doc(
			[head("a1"), screenTake("s1")],
			[
				clip("c1", "a1", 0, { fillPosition: { x: 0.3, y: 0.5 }, padding: 4 }),
				// A screen take's own fillPosition is not drawn any more, so it is not counted.
				clip("c2", "s1", 5, {
					fillPosition: { x: 0.9, y: 0.5 },
					webcamCoverPan: { x: 0.1, y: 0.5 },
				}),
				clip("c3", "a1", 10, { fillPosition: null }),
			],
			VERTICAL_FILLED,
		);

	it("counts the clips whose own position shows, Auto included", () => {
		expect(clipsWithOwnFramePosition(mixed(), "fillPosition").map((c) => c.id)).toEqual([
			"c1",
			"c3",
		]);
		expect(clipsWithOwnFramePosition(mixed(), "webcamCoverPan").map((c) => c.id)).toEqual(["c2"]);
		expect(clipsWithOwnFramePosition(mixed(), "webcamCropPan")).toEqual([]);
	});

	it("gives them the project's back and leaves the rest of their look", () => {
		const cleared = clearOwnFramePositions(mixed(), "fillPosition");
		const [c1, c2, c3] = cleared.timeline.clips;
		expect(c1.look).toEqual({ padding: 4 });
		// Not counted, not touched.
		expect(c2.look).toEqual({
			fillPosition: { x: 0.9, y: 0.5 },
			webcamCoverPan: { x: 0.1, y: 0.5 },
		});
		expect("look" in c3).toBe(false);
		const camera = clearOwnFramePositions(mixed(), "webcamCoverPan");
		expect(camera.timeline.clips[1].look).toEqual({ fillPosition: { x: 0.9, y: 0.5 } });
		const none = doc([head()], [clip("c1", "a1")]);
		expect(clearOwnFramePositions(none, "fillPosition")).toBe(none);
	});

	it("a zoomed crop given the project's position keeps its own zoom", () => {
		const d = doc(
			[screenTake()],
			[
				clip("c1", "s1", 0, {
					webcamCropRegion: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
					webcamCropPan: { x: 1, y: 1 },
				}),
			],
			{ aspectRatio: "9:16", webcamCropPan: { x: 0, y: 0.5 } },
		);
		const cleared = clearOwnFramePositions(d, "webcamCropPan");
		const crop = getClipEditorSettings(cleared, cleared.timeline.clips[0]).webcamCropRegion;
		expect(crop).toEqual({ x: 0, y: 0.25, width: 0.5, height: 0.5 });
	});
});
