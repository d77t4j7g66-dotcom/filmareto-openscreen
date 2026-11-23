import { describe, expect, it } from "vitest";
import { boxPointToCameraPicture, cameraPictureToBoxPoint } from "./cameraFocus";

const WHOLE = { x: 0, y: 0, width: 1, height: 1 };

describe("boxPointToCameraPicture", () => {
	it("maps the centre of the box to the centre of the picture", () => {
		const at = boxPointToCameraPicture({ x: 0.5, y: 0.5 }, WHOLE, null, 16 / 9, 16 / 9, false);
		expect(at.x).toBeCloseTo(0.5, 6);
		expect(at.y).toBeCloseTo(0.5, 6);
	});

	it("flips x for a mirrored camera and leaves y", () => {
		const at = boxPointToCameraPicture({ x: 0.25, y: 0.3 }, WHOLE, null, 16 / 9, 16 / 9, true);
		expect(at.x).toBeCloseTo(0.75, 6);
		expect(at.y).toBeCloseTo(0.3, 6);
	});

	it("maps the box's left edge to the cut's left edge for a 16:9 camera in a 9:16 box", () => {
		// The cover cut is 9/16 / (16/9) = 81/256 of the width, centred.
		const share = 81 / 256;
		const left = boxPointToCameraPicture({ x: 0, y: 0.5 }, WHOLE, null, 9 / 16, 16 / 9, false);
		const right = boxPointToCameraPicture({ x: 1, y: 0.5 }, WHOLE, null, 9 / 16, 16 / 9, false);
		expect(left.x).toBeCloseTo(0.5 - share / 2, 6);
		expect(right.x).toBeCloseTo(0.5 + share / 2, 6);
		expect(left.y).toBeCloseTo(0.5, 6);
	});

	it("places the cover cut with the Frame position pan when the crop is the whole picture", () => {
		const atLeft = boxPointToCameraPicture(
			{ x: 0, y: 0 },
			WHOLE,
			{ x: 0, y: 0 },
			9 / 16,
			16 / 9,
			false,
		);
		const atRight = boxPointToCameraPicture(
			{ x: 1, y: 0 },
			WHOLE,
			{ x: 1, y: 0 },
			9 / 16,
			16 / 9,
			false,
		);
		expect(atLeft.x).toBeCloseTo(0, 6);
		expect(atRight.x).toBeCloseTo(1, 6);
	});

	it("maps into the crop, in the whole picture's 0..1", () => {
		const crop = { x: 0.25, y: 0, width: 0.5, height: 1 };
		const at = boxPointToCameraPicture({ x: 0, y: 0 }, crop, null, 0.5 * (16 / 9), 16 / 9, false);
		expect(at.x).toBeCloseTo(0.25, 6);
		const far = boxPointToCameraPicture({ x: 1, y: 1 }, crop, null, 0.5 * (16 / 9), 16 / 9, false);
		expect(far.x).toBeCloseTo(0.75, 6);
		expect(far.y).toBeCloseTo(1, 6);
	});

	it("ignores the pan for a crop smaller than the picture, as the compositor does", () => {
		const crop = { x: 0.2, y: 0, width: 0.6, height: 1 };
		const a = boxPointToCameraPicture({ x: 0, y: 0.5 }, crop, { x: 0, y: 0 }, 1, 16 / 9, false);
		const b = boxPointToCameraPicture({ x: 0, y: 0.5 }, crop, null, 1, 16 / 9, false);
		expect(a).toEqual(b);
	});
});

describe("cameraPictureToBoxPoint", () => {
	it("is the inverse of boxPointToCameraPicture, mirrored or not", () => {
		const crop = { x: 0, y: 0, width: 1, height: 1 };
		for (const mirrored of [false, true]) {
			const picked = { x: 0.2, y: 0.7 };
			const focus = boxPointToCameraPicture(
				picked,
				crop,
				{ x: 0.3, y: 0 },
				9 / 16,
				16 / 9,
				mirrored,
			);
			const back = cameraPictureToBoxPoint(focus, crop, { x: 0.3, y: 0 }, 9 / 16, 16 / 9, mirrored);
			expect(back.x).toBeCloseTo(picked.x, 6);
			expect(back.y).toBeCloseTo(picked.y, 6);
		}
	});

	it("puts a focus the cut does not show on the box's nearest edge", () => {
		const whole = { x: 0, y: 0, width: 1, height: 1 };
		const at = cameraPictureToBoxPoint({ x: 0.01, y: 0.5 }, whole, null, 9 / 16, 16 / 9, false);
		expect(at.x).toBe(0);
	});
});
