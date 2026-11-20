import { describe, expect, it } from "vitest";
import { CAPTION_FLOOR_INSET, placeUnderChin } from "./faceSafe";

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
