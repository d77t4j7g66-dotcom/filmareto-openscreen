import { describe, expect, it } from "vitest";
import type { SceneDescription } from "@/native/sceneDescription";
import {
	cameraFrame0,
	framesDue,
	framesOfSeconds,
	planResolveExport,
	resolveTimelineSize,
	segmentSourceTimes,
} from "./plan";

type Clip = SceneDescription["clips"][number];

function clip(over: Partial<Clip> = {}): Clip {
	return {
		screenPath: "/rec/a.mov",
		webcamPath: "/rec/a.cam.mov",
		sourceStartSec: 0,
		sourceEndSec: 10,
		webcamOffsetSec: 0,
		hasAudio: true,
		...over,
	};
}

function scene(
	clips: Clip[],
	speedRegions: SceneDescription["speedRegions"] = [],
): SceneDescription {
	return {
		clips,
		speedRegions,
		background: { kind: "color", color: "#101010" },
	} as unknown as SceneDescription;
}

const opts = { fps: 30 as const, overlay: true };

describe("planResolveExport", () => {
	it("puts two clips with a trim between them at integer record frames", () => {
		const plan = planResolveExport(
			scene([
				clip({ sourceStartSec: 0, sourceEndSec: 4 }),
				clip({ sourceStartSec: 6, sourceEndSec: 9 }),
			]),
			opts,
		);
		expect(plan.segments).toHaveLength(2);
		expect(plan.segments[0].recordFrame).toBe(0);
		expect(plan.segments[0].frames).toBe(120);
		expect(plan.segments[1].recordFrame).toBe(120);
		expect(plan.segments[1].mediaStartFrame).toBe(180);
		expect(plan.segments[1].frames).toBe(90);
		expect(plan.durationFrames).toBe(210);
		expect(plan.segments.map((s) => s.key)).toEqual(["seg-001", "seg-002"]);
	});

	it("record frames are the programme-grid frames and add up to durationFrames", () => {
		// 0.05s spans are not whole frames: each segment owns the grid frames due, no per-span rounding.
		const clips = Array.from({ length: 10 }, (_, i) =>
			clip({ sourceStartSec: i, sourceEndSec: i + 0.05 }),
		);
		const plan = planResolveExport(scene(clips), opts);
		let sum = 0;
		for (const s of plan.segments) {
			expect(s.recordFrame).toBe(sum);
			sum += s.frames;
		}
		expect(plan.durationFrames).toBe(sum);
	});

	it("gives a 2x speed region its own retimed segment", () => {
		const plan = planResolveExport(
			scene(
				[clip({ sourceStartSec: 0, sourceEndSec: 10 })],
				[{ startSec: 2, endSec: 6, speed: 2, clipIndex: 0 }],
			),
			opts,
		);
		expect(plan.segments.map((s) => [s.srcStartSec, s.srcEndSec, s.speed, s.retimed])).toEqual([
			[0, 2, 1, false],
			[2, 6, 2, true],
			[6, 10, 1, false],
		]);
		const fast = plan.segments[1];
		expect(fast.frames).toBe(60);
		expect(fast.mediaStartFrame).toBe(0);
		expect(fast.camera?.mediaStartFrame).toBe(0);
		expect(fast.recordFrame).toBe(60);
		expect(plan.segments[2].recordFrame).toBe(120);
		expect(plan.segments[2].mediaStartFrame).toBe(180);
		expect(plan.durationFrames).toBe(60 + 60 + 120);
	});

	it("ignores speed regions of other clips and keeps overlapping ones disjoint", () => {
		const plan = planResolveExport(
			scene(
				[clip({ sourceEndSec: 10 }), clip({ sourceEndSec: 4 })],
				[
					{ startSec: 1, endSec: 5, speed: 2, clipIndex: 0 },
					{ startSec: 3, endSec: 7, speed: 4, clipIndex: 0 },
					{ startSec: 0, endSec: 4, speed: 8, clipIndex: 1 },
				],
			),
			opts,
		);
		const c0 = plan.segments.filter((s) => s.clipIndex === 0);
		expect(c0.map((s) => [s.srcStartSec, s.srcEndSec, s.speed])).toEqual([
			[0, 1, 1],
			[1, 5, 2],
			[5, 7, 4],
			[7, 10, 1],
		]);
		const c1 = plan.segments.filter((s) => s.clipIndex === 1);
		expect(c1.map((s) => s.speed)).toEqual([8]);
	});

	it("gives the same source range twice two different keys", () => {
		const plan = planResolveExport(scene([clip(), clip()]), opts);
		expect(plan.segments[0].srcStartSec).toBe(plan.segments[1].srcStartSec);
		expect(plan.segments[0].key).not.toBe(plan.segments[1].key);
		expect(plan.segments[0].camera?.key).not.toBe(plan.segments[1].camera?.key);
		expect(plan.audio[0].key).not.toBe(plan.audio[1].key);
	});

	it("treats a camera-only take as a screen segment with no camera", () => {
		const a = planResolveExport(
			scene([clip({ screenPath: "/rec/cam.mov", webcamPath: "/rec/cam.mov" })]),
			opts,
		);
		expect(a.segments[0].role).toBe("screen");
		expect(a.segments[0].mediaSourcePath).toBe("/rec/cam.mov");
		expect(a.segments[0].camera).toBeNull();
		const b = planResolveExport(scene([clip({ webcamPath: "" })]), opts);
		expect(b.segments[0].camera).toBeNull();
	});

	it("maps camera media frames with webcamTime = screenTime - webcamOffset", () => {
		const plan = planResolveExport(
			scene([clip({ sourceStartSec: 5, sourceEndSec: 8, webcamOffsetSec: 1.5 })]),
			opts,
		);
		expect(plan.segments[0].mediaStartFrame).toBe(150);
		expect(plan.segments[0].camera?.mediaStartFrame).toBe(105);
		// A negative offset pushes the camera later: it plays from media frame start + 1 s.
		const neg = planResolveExport(
			scene([clip({ sourceStartSec: 5, sourceEndSec: 8, webcamOffsetSec: -1 })]),
			opts,
		);
		expect(neg.segments[0].camera?.mediaStartFrame).toBe(180);
		const seg = neg.segments[0];
		expect(seg.camera?.offsetFrames).toBe(-30);
		expect(seg.camera?.recordFrame).toBe(seg.recordFrame);
		expect(seg.camera?.frames).toBe(seg.frames);
	});

	it("delays the camera clip when its offset is past the piece start (no clamp to 0)", () => {
		// offset 2s = 60 frames, piece starts at media frame 30 -> camera starts 30 frames late.
		const plan = planResolveExport(
			scene([clip({ sourceStartSec: 1, sourceEndSec: 3, webcamOffsetSec: 2 })]),
			opts,
		);
		const seg = plan.segments[0];
		expect(seg.frames).toBe(60);
		expect(seg.camera).toMatchObject({
			offsetFrames: 60,
			mediaStartFrame: 0,
			recordFrame: 30,
			frames: 30,
			retimed: false,
		});
		// A camera that never starts inside the piece is dropped.
		const gone = planResolveExport(
			scene([clip({ sourceStartSec: 0, sourceEndSec: 1, webcamOffsetSec: 2 })]),
			opts,
		);
		expect(gone.segments[0].camera).toBeNull();
		// Camera keys are numbered over the kept cameras only.
		const two = planResolveExport(
			scene([
				clip({ sourceStartSec: 0, sourceEndSec: 1, webcamOffsetSec: 2 }),
				clip({ sourceStartSec: 0, sourceEndSec: 1, webcamOffsetSec: 0 }),
			]),
			opts,
		);
		expect(two.segments[1].camera?.key).toBe("cam-001");
	});

	it("gives a retimed segment a retimed camera with the same record and frames", () => {
		const plan = planResolveExport(
			scene(
				[clip({ sourceEndSec: 4, webcamOffsetSec: 1 })],
				[{ startSec: 0, endSec: 4, speed: 2, clipIndex: 0 }],
			),
			opts,
		);
		const seg = plan.segments[0];
		expect(seg.handleFrames).toBe(0);
		expect(seg.camera).toMatchObject({
			retimed: true,
			mediaStartFrame: 0,
			recordFrame: seg.recordFrame,
			frames: seg.frames,
		});
		expect(cameraFrame0(seg, 0)).toBe(0);
	});

	it("emits cursorPath, handles and the screen's own audio by default", () => {
		const plan = planResolveExport(scene([clip({ sourceStartSec: 2, sourceEndSec: 3 })]), opts);
		const seg = plan.segments[0];
		expect(seg.cursorPath).toBe("/rec/a.mov.cursor.json");
		expect(seg.handleFrames).toBe(90);
		expect(plan.audio).toEqual([
			{
				key: "voice-001",
				sourcePath: "/rec/a.mov",
				takePath: "/rec/a.mov",
				retimed: false,
				speed: 1,
				srcStartSec: 2,
				srcEndSec: 3,
				mediaStartFrame: 60,
				frames: 30,
				recordFrame: 0,
				track: 1,
			},
		]);
	});

	it("uses the mic wav when given, skips clips without audio, and retimes it with the segment", () => {
		const plan = planResolveExport(
			scene(
				[clip({ sourceEndSec: 4 }), clip({ screenPath: "/rec/b.mov", hasAudio: false })],
				[{ startSec: 0, endSec: 4, speed: 2, clipIndex: 0 }],
			),
			{
				...opts,
				micWavPathFor: (p) => (p === "/rec/a.mov" ? "/rec/a.mic.wav" : null),
			},
		);
		expect(plan.audio).toHaveLength(1);
		expect(plan.audio[0].sourcePath).toBe("/rec/a.mic.wav");
		expect(plan.audio[0].retimed).toBe(true);
		expect(plan.audio[0].frames).toBe(60);
	});

	it("falls back to the screen file when micWavPathFor returns null", () => {
		const plan = planResolveExport(scene([clip()]), { ...opts, micWavPathFor: () => null });
		expect(plan.audio[0].sourcePath).toBe("/rec/a.mov");
	});

	it("passes the background through and spans V1 and V4 over the whole timeline", () => {
		const plan = planResolveExport(scene([clip()]), opts);
		expect(plan.background).toEqual({ kind: "color", color: "#101010" });
		expect(plan.backgroundSpan).toEqual({ startFrame: 0, frames: 300 });
		expect(plan.overlaySpan).toEqual({ startFrame: 0, frames: 300 });
		expect(planResolveExport(scene([clip()]), { ...opts, overlay: false }).overlaySpan).toBeNull();
	});

	it("sums a 3-clip plan whose durations are not multiples of 1/30 to framesDue(total)", () => {
		const clips = [
			clip({ sourceStartSec: 0, sourceEndSec: 1.01 }),
			clip({ sourceStartSec: 2, sourceEndSec: 3.113 }),
			clip({ sourceStartSec: 5, sourceEndSec: 6.2777 }),
		];
		const plan = planResolveExport(scene(clips), opts);
		const total = 1.01 + 1.113 + 1.2777;
		expect(plan.durationFrames).toBe(framesDue(total, 30));
		let next = 0;
		for (const s of plan.segments) {
			expect(s.recordFrame).toBe(next);
			next += s.frames;
		}
		expect(next).toBe(plan.durationFrames);
		expect(plan.segments[1].outputStartSec).toBeCloseTo(1.01, 9);
		expect(plan.segments[1].recordFrame).toBe(framesDue(1.01, 30));
	});

	it("matches the Rust frame_count for a 2x span", () => {
		const plan = planResolveExport(
			scene(
				[clip({ sourceStartSec: 0, sourceEndSec: 5 })],
				[{ startSec: 1.1, endSec: 3.3, speed: 2, clipIndex: 0 }],
			),
			opts,
		);
		const fast = plan.segments[1];
		// outputStart = 1.1, outputEnd = 1.1 + 2.2/2 = 2.2
		expect(fast.outputStartSec).toBeCloseTo(1.1, 9);
		const first = Math.ceil((1.1 - 0.001) * 30);
		const count = Math.ceil((2.2 - 0.001) * 30) - first;
		expect(fast.recordFrame).toBe(first);
		expect(fast.frames).toBe(count);
		expect(plan.segments[0].frames).toBe(first);
	});
});

describe("segmentSourceTimes", () => {
	it("samples a not-retimed segment from media frames with handles, clamped to the file", () => {
		const plan = planResolveExport(scene([clip({ sourceStartSec: 1, sourceEndSec: 2 })]), opts);
		const seg = plan.segments[0];
		const a = segmentSourceTimes(seg, 30, 90);
		expect(a.frame0).toBe(0);
		expect(a.times.length).toBe(30 + 29 + 90 + 1);
		expect(a.times[30]).toBeCloseTo(1, 9);
		const b = segmentSourceTimes(seg, 30, 10, 62);
		expect(b.frame0).toBe(20);
		expect(b.times.length).toBe(62 - 20);
		expect(b.times[0]).toBeCloseTo(20 / 30, 9);
	});

	it("samples a retimed segment on the programme grid with no handles", () => {
		const plan = planResolveExport(
			scene(
				[clip({ sourceStartSec: 0, sourceEndSec: 5 })],
				[{ startSec: 1.1, endSec: 3.3, speed: 2, clipIndex: 0 }],
			),
			opts,
		);
		const seg = plan.segments[1];
		const r = segmentSourceTimes(seg, 30, 90);
		expect(r.frame0).toBe(0);
		expect(r.times.length).toBe(seg.frames);
		expect(r.times[0]).toBeGreaterThanOrEqual(1.1);
		expect(r.times[1]).toBeCloseTo(1.1 + (34 / 30 - 1.1) * 2, 9);
	});
});

describe("planResolveExport edge cases", () => {
	it("starts a piece at the frame the decoder shows, so a late piece stays inside the file", () => {
		// 1.025 s -> 31 frames (framesDue); the next clip starts at programme 1.025, grid frame 31.
		const plan = planResolveExport(
			scene([
				clip({ sourceStartSec: 0, sourceEndSec: 1.025 }),
				clip({ sourceStartSec: 2.02, sourceEndSec: 5.0 }),
			]),
			opts,
		);
		const second = plan.segments[1];
		expect(second.mediaStartFrame).toBe(Math.floor((2.02 + 31 / 30 - 1.025) * 30 + 1e-6));
		expect(second.mediaStartFrame + second.frames - 1).toBeLessThanOrEqual(149);
		expect(plan.audio[1].mediaStartFrame).toBe(second.mediaStartFrame);
	});

	it("applies a region without clipIndex to every clip", () => {
		const plan = planResolveExport(
			scene(
				[clip({ sourceEndSec: 2 }), clip({ sourceEndSec: 2 })],
				[{ startSec: 0, endSec: 2, speed: 2 }],
			),
			opts,
		);
		expect(plan.segments.map((s) => s.speed)).toEqual([2, 2]);
	});

	it("handles speed below 1 (slow motion lengthens the span)", () => {
		const plan = planResolveExport(
			scene([clip({ sourceEndSec: 2 })], [{ startSec: 0, endSec: 2, speed: 0.5, clipIndex: 0 }]),
			opts,
		);
		expect(plan.segments[0]).toMatchObject({ speed: 0.5, retimed: true, frames: 120 });
	});

	it("drops a span too short to own a frame but keeps the programme clock", () => {
		// 0.0004 s of source at speed 1: more than the sliver floor, but framesDue gives 0 frames.
		const plan = planResolveExport(
			scene([
				clip({ sourceStartSec: 0, sourceEndSec: 0.0004 }),
				clip({ sourceStartSec: 1, sourceEndSec: 2 }),
			]),
			opts,
		);
		expect(plan.segments).toHaveLength(1);
		expect(plan.segments[0].clipIndex).toBe(1);
		expect(plan.segments[0].recordFrame).toBe(framesDue(0.0004, 30));
		expect(plan.durationFrames).toBe(plan.segments[0].frames);
	});

	it("skips a sliver of 0.0001 s or less without advancing the clock", () => {
		const plan = planResolveExport(
			scene(
				[clip({ sourceStartSec: 0, sourceEndSec: 3 })],
				[{ startSec: 1, endSec: 1.0001, speed: 2, clipIndex: 0 }],
			),
			opts,
		);
		expect(plan.segments.map((s) => [s.srcStartSec, s.srcEndSec, s.speed])).toEqual([
			[0, 1, 1],
			[1.0001, 3, 1],
		]);
	});
});

describe("cameraFrame0", () => {
	it("maps screen media frames to camera media frames and may go negative", () => {
		const plan = planResolveExport(
			scene([clip({ sourceStartSec: 2, sourceEndSec: 3, webcamOffsetSec: 1 })]),
			opts,
		);
		const seg = plan.segments[0];
		const { frame0 } = segmentSourceTimes(seg, 30);
		expect(frame0).toBe(0);
		expect(cameraFrame0(seg, frame0)).toBe(-30);
		expect(cameraFrame0(seg, 60)).toBe(30);
	});
});

describe("resolveTimelineSize", () => {
	it("keeps the project's aspect with the short side at 1080, both sides even", () => {
		// A 2048x1152 take: 16:9 and 9:16 projects, and an "auto" one that follows the take.
		expect(resolveTimelineSize({ width: 2048, height: 1152 })).toEqual({
			width: 1920,
			height: 1080,
		});
		expect(resolveTimelineSize({ width: 1152, height: 2048 })).toEqual({
			width: 1080,
			height: 1920,
		});
		expect(resolveTimelineSize({ width: 1080, height: 1920 })).toEqual({
			width: 1080,
			height: 1920,
		});
		expect(resolveTimelineSize({ width: 1920, height: 1080 })).toEqual({
			width: 1920,
			height: 1080,
		});
		// 4:3, 1:1 and 21:9 snap to even sides.
		expect(resolveTimelineSize({ width: 1600, height: 1200 })).toEqual({
			width: 1440,
			height: 1080,
		});
		expect(resolveTimelineSize({ width: 900, height: 900 })).toEqual({ width: 1080, height: 1080 });
		const wide = resolveTimelineSize({ width: 2560, height: 1097 });
		expect(wide.height).toBe(1080);
		expect(wide.width % 2).toBe(0);
	});
});

describe("framesOfSeconds", () => {
	it("rounds a duration to the nearest frame", () => {
		expect(framesOfSeconds(432.53)).toBe(12976);
		expect(framesOfSeconds(10)).toBe(300);
		expect(framesOfSeconds(0)).toBe(0);
	});
});

describe("audio clips", () => {
	it("carry their take's path, also when the voice is the mic WAV", () => {
		const plan = planResolveExport(scene([clip({ screenPath: "/rec/a.mov" })]), {
			...opts,
			micWavPathFor: () => "/rec/a.mic.wav",
		});
		expect(plan.audio[0]).toMatchObject({ sourcePath: "/rec/a.mic.wav", takePath: "/rec/a.mov" });
	});
});
