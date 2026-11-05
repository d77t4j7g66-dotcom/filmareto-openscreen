import { describe, expect, it } from "vitest";
import { MIN_CROP, moveCrop, resizeCrop } from "./pipCrop";

const rect = { x: 0.2, y: 0.2, width: 0.3, height: 0.2 };

describe("moveCrop", () => {
	it("moves the rectangle and stops it at the edges", () => {
		const moved = moveCrop(rect, 0.1, 0.1);
		expect(moved.x).toBeCloseTo(0.3);
		expect(moved.y).toBeCloseTo(0.3);
		expect(moved.width).toBe(rect.width);
		expect(moveCrop(rect, 5, 5)).toEqual({ ...rect, x: 0.7, y: 0.8 });
		expect(moveCrop(rect, -5, -5)).toEqual({ ...rect, x: 0, y: 0 });
	});
});

describe("resizeCrop (free)", () => {
	const free = { aspect: null, sourceAspect: 16 / 9 };

	it("drags the south-east corner and leaves the north-west corner where it was", () => {
		const out = resizeCrop(rect, "se", 0.1, 0.05, free);
		expect(out.x).toBeCloseTo(0.2);
		expect(out.y).toBeCloseTo(0.2);
		expect(out.width).toBeCloseTo(0.4);
		expect(out.height).toBeCloseTo(0.25);
	});

	it("drags the north-west corner and leaves the south-east corner where it was", () => {
		const out = resizeCrop(rect, "nw", -0.1, -0.05, free);
		expect(out.x + out.width).toBeCloseTo(0.5);
		expect(out.y + out.height).toBeCloseTo(0.4);
		expect(out.width).toBeCloseTo(0.4);
		expect(out.height).toBeCloseTo(0.25);
	});

	it("never shrinks below the minimum or leaves the frame", () => {
		const tiny = resizeCrop(rect, "se", -5, -5, free);
		expect(tiny.width).toBeCloseTo(MIN_CROP);
		expect(tiny.height).toBeCloseTo(MIN_CROP);
		const big = resizeCrop(rect, "se", 5, 5, free);
		expect(big.x + big.width).toBeCloseTo(1);
		expect(big.y + big.height).toBeCloseTo(1);
	});
});

describe("resizeCrop (aspect locked)", () => {
	// A box that is 2:1 in pixels on a 16:9 frame: width / height as fractions = 2 / (16/9) = 1.125.
	const locked = { aspect: 2, sourceAspect: 16 / 9 };
	const base = { x: 0.1, y: 0.1, width: 0.225, height: 0.2 };

	it("keeps the picture's pixel shape while the corner moves", () => {
		const out = resizeCrop(base, "se", 0.1, 0.0, locked);
		expect(out.width / out.height).toBeCloseTo(1.125);
		expect(out.x).toBeCloseTo(0.1);
		expect(out.y).toBeCloseTo(0.1);
	});

	it("stays inside the frame and keeps the shape when dragged far", () => {
		const out = resizeCrop(base, "se", 5, 5, locked);
		expect(out.x + out.width).toBeLessThanOrEqual(1 + 1e-9);
		expect(out.y + out.height).toBeLessThanOrEqual(1 + 1e-9);
		expect(out.width / out.height).toBeCloseTo(1.125);
	});

	it("keeps the anchor for a west corner", () => {
		const out = resizeCrop(base, "nw", -0.05, -0.05, locked);
		expect(out.x + out.width).toBeCloseTo(0.325);
		expect(out.y + out.height).toBeCloseTo(0.3);
		expect(out.width / out.height).toBeCloseTo(1.125);
	});
});
