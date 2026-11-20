import { describe, expect, it } from "vitest";
import { expandGraphicRegions, graphicFrameSize, graphicFrameSpans } from "./graphics";
import { refitFrameAnnotations } from "./placement";

const graphic = {
	durationMs: 3000,
	holdMs: 2700,
	frames: [
		{ path: "a", atMs: 0 },
		{ path: "b", atMs: 100 },
		{ path: "c", atMs: 2700 },
		{ path: "d", atMs: 2900 },
	],
};

describe("graphicFrameSpans", () => {
	it("plays at its own pace in a pill of its own length", () => {
		expect(graphicFrameSpans(graphic, 3000)).toEqual([
			{ path: "a", startMs: 0, endMs: 100 },
			{ path: "b", startMs: 100, endMs: 2700 },
			{ path: "c", startMs: 2700, endMs: 2900 },
			{ path: "d", startMs: 2900, endMs: 3000 },
		]);
	});

	it("holds in a longer pill and still leaves at the end", () => {
		expect(graphicFrameSpans(graphic, 5000)).toEqual([
			{ path: "a", startMs: 0, endMs: 100 },
			{ path: "b", startMs: 100, endMs: 2700 },
			{ path: "c", startMs: 2700, endMs: 4900 },
			{ path: "d", startMs: 4900, endMs: 5000 },
		]);
	});

	it("plays faster in a shorter pill", () => {
		const spans = graphicFrameSpans(graphic, 1500);
		expect(spans[0]).toEqual({ path: "a", startMs: 0, endMs: 50 });
		expect(spans.at(-1)).toEqual({ path: "d", startMs: 1450, endMs: 1500 });
	});
});

describe("expandGraphicRegions", () => {
	const base = { startMs: 1000, endMs: 4000, content: "" };

	it("leaves a project without graphics as it was", () => {
		const regions = [{ id: "t", ...base }];
		expect(expandGraphicRegions(regions)).toBe(regions);
	});

	it("turns a graphic into one image per frame, on the ruler and with no clip anchor", () => {
		const frames = expandGraphicRegions([
			{
				id: "g",
				...base,
				clipId: "c",
				sourceStartSec: 1,
				sourceEndSec: 4,
				graphicData: graphic as never,
			},
		]);
		expect(frames.map((f) => [f.id, f.content, f.startMs, f.endMs])).toEqual([
			["g~a", "a", 1000, 1100],
			["g~b", "b", 1100, 3700],
			["g~c", "c", 3700, 3900],
			["g~d", "d", 3900, 4000],
		]);
		expect(frames[0].clipId).toBeUndefined();
		expect(frames[0].graphicData).toBeUndefined();
	});

	it("plays a graphic once when a clip boundary cuts it in two", () => {
		const data = graphic as never;
		const frames = expandGraphicRegions([
			{ id: "g1", startMs: 1000, endMs: 2000, content: "", graphicData: data },
			{ id: "g2", startMs: 2000, endMs: 4000, content: "", graphicData: data },
		]);
		expect(frames.map((f) => f.content)).toEqual(["a", "b", "c", "d"]);
	});
});

describe("graphicFrameSize", () => {
	it("keeps the long side and an even size", () => {
		expect(graphicFrameSize(9 / 16)).toEqual({ width: 1080, height: 1920 });
		expect(graphicFrameSize(16 / 9)).toEqual({ width: 1920, height: 1080 });
		expect(graphicFrameSize(1)).toEqual({ width: 1920, height: 1920 });
	});
});

describe("a change of format", () => {
	it("leaves a graphic filling the frame: its render follows the format instead", () => {
		const region = {
			id: "g",
			startMs: 0,
			endMs: 3000,
			type: "image",
			content: "",
			space: "frame",
			position: { x: 0, y: 0 },
			size: { width: 100, height: 100 },
			graphicData: graphic,
		} as never;
		expect(refitFrameAnnotations([region], 9 / 16, 16 / 9)[0]).toBe(region);
	});
});
