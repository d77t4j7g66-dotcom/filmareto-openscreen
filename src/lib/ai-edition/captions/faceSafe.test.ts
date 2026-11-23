import { describe, expect, it } from "vitest";
import type { AxcutDocument, AxcutZoomRegion } from "../schema";
import { CAPTION_FLOOR_INSET, captionFaceGuard, placeUnderChin } from "./faceSafe";

describe("placeUnderChin", () => {
	it("leaves a caption that is already under the chin where it is", () => {
		expect(placeUnderChin(24, 12, 50, 42)).toEqual({ insetY: 24, scale: 1 });
	});

	it("brings it down just under the chin when a zoom lowers the face", () => {
		const place = placeUnderChin(24, 12, 72, 62);
		expect(place.scale).toBe(1);
		expect(100 - place.insetY - 12).toBeGreaterThanOrEqual(72);
		expect(place.insetY).toBeGreaterThanOrEqual(CAPTION_FLOOR_INSET);
	});

	it("never goes below the floor, and shrinks rather than cover the mouth", () => {
		const place = placeUnderChin(24, 16, 92, 76);
		expect(place.insetY).toBe(CAPTION_FLOOR_INSET);
		expect(place.scale).toBeLessThan(1);
		expect(100 - place.insetY - 16 * place.scale).toBeGreaterThanOrEqual(76);
	});

	it("never raises a caption the user put low", () => {
		expect(placeUnderChin(8, 10, 60, 50).insetY).toBe(8);
	});
});

describe("captionFaceGuard on a talking head", () => {
	// A portrait talking head in a portrait frame: the frame shows its whole height before a zoom.
	const headDoc = (
		cameraZoomRanges: Partial<AxcutZoomRegion>[],
		asset: Record<string, unknown> = {},
	): AxcutDocument =>
		({
			assets: [
				{
					id: "h",
					kind: "video",
					originalPath: "/tmp/recording-1.mov",
					video: { width: 1080, height: 1920 },
					face: { x: 0.5, y: 0.35, h: 0.3 },
					...asset,
				},
			],
			timeline: {
				clips: [
					{ id: "c", assetId: "h", sourceStartSec: 0, timelineStartSec: 0, timelineEndSec: 10 },
				],
			},
			zoomRanges: [],
			cameraZoomRanges: cameraZoomRanges.map((z, i) => ({
				id: `cz${i}`,
				startMs: 1000,
				endMs: 5000,
				depth: 1,
				customScale: 2.5,
				focus: { cx: 0.5, cy: 0.35 },
				...z,
			})),
		}) as unknown as AxcutDocument;
	const place = (document: AxcutDocument) =>
		captionFaceGuard(document, 9 / 16)?.(2000, 3000, 24, 12);

	it("reads the camera lane: a punch-in there brings the caption down off the mouth", () => {
		expect(place(headDoc([]))).toEqual({ insetY: 24, scale: 1 });
		const punched = place(headDoc([{ focusMode: "manual" }]));
		expect(punched).not.toEqual({ insetY: 24, scale: 1 });
		expect(punched?.insetY).toBe(CAPTION_FLOOR_INSET);
	});

	it("centres an Auto camera zoom on the face, not on its stored point", () => {
		// The stored point is low in the picture (a click, say); Auto looks at the face.
		const auto = place(headDoc([{ focusMode: "auto", focus: { cx: 0.5, cy: 0.8 } }]));
		const onTheFace = place(headDoc([{ focusMode: "manual", focus: { cx: 0.5, cy: 0.35 } }]));
		const onThePoint = place(headDoc([{ focusMode: "manual", focus: { cx: 0.5, cy: 0.8 } }]));
		expect(auto).toEqual(onTheFace);
		expect(auto).not.toEqual(onThePoint);
	});

	it("follows the face track at the phrase's second, under an Auto camera zoom", () => {
		const track = [
			{ t: 0, x: 0.5, y: 0.6, h: 0.2 },
			{ t: 10, x: 0.5, y: 0.6, h: 0.2 },
		];
		const tracked = place(headDoc([{ focusMode: "auto" }], { faceTrack: track }));
		const there = place(
			headDoc([{ focusMode: "manual", focus: { cx: 0.5, cy: 0.6 } }], {
				face: { x: 0.5, y: 0.6, h: 0.2 },
			}),
		);
		expect(tracked).toEqual(there);
		// Not the take's one face (0.35): the track's.
		expect(tracked).not.toEqual(place(headDoc([{ focusMode: "auto" }])));
	});
});
