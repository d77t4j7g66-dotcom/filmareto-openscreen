import { describe, expect, it } from "vitest";
import { lockPipSource } from "./pip";

const FRAME_169 = 16 / 9;
const FRAME_916 = 9 / 16;

describe("lockPipSource", () => {
	it("derives a height that keeps the box's pixel aspect", () => {
		// Box 30% x 20% of a 16:9 frame is 2.67:1; a source of 20% width on a 16:9 recording is
		// 20% * 16 : h% * 9 -> h = 20 * (16/9) / 2.67 = 13.3%.
		const out = lockPipSource(
			{ x: 0.1, y: 0.1, width: 0.2, height: 0.5 },
			{ width: 30, height: 20 },
			FRAME_169,
			16 / 9,
		);
		expect(out.width).toBeCloseTo(0.2);
		expect(out.height).toBeCloseTo(0.1333, 3);
	});

	it("follows the box when it is resized", () => {
		const source = { x: 0, y: 0, width: 0.3, height: 0.3 };
		const wide = lockPipSource(source, { width: 40, height: 20 }, FRAME_169, 16 / 9);
		const tall = lockPipSource(source, { width: 20, height: 40 }, FRAME_169, 16 / 9);
		expect(wide.height).toBeLessThan(tall.height);
		const pxAspect = (s: typeof wide, b: { width: number; height: number }) =>
			(s.width * 16) / (s.height * 9) / ((b.width * 16) / (b.height * 9));
		expect(pxAspect(wide, { width: 40, height: 20 })).toBeCloseTo(1);
		expect(pxAspect(tall, { width: 20, height: 40 })).toBeCloseTo(1);
	});

	it("takes the frame's own aspect into account (9:16 output)", () => {
		// The same percent box is far taller on a portrait frame, so the source rect gets taller too.
		const landscape = lockPipSource(
			{ x: 0, y: 0, width: 0.2, height: 0.2 },
			{ width: 50, height: 30 },
			FRAME_169,
			16 / 9,
		);
		const portrait = lockPipSource(
			{ x: 0, y: 0, width: 0.2, height: 0.2 },
			{ width: 50, height: 30 },
			FRAME_916,
			16 / 9,
		);
		expect(portrait.height).toBeGreaterThan(landscape.height);
	});

	it("shrinks a rect that would run off the footage, keeping the aspect", () => {
		const out = lockPipSource(
			{ x: 0.9, y: 0.9, width: 0.5, height: 0.5 },
			{ width: 30, height: 30 },
			FRAME_169,
			16 / 9,
		);
		expect(out.x + out.width).toBeLessThanOrEqual(1 + 1e-9);
		expect(out.y + out.height).toBeLessThanOrEqual(1 + 1e-9);
		expect((out.width * 16) / (out.height * 9)).toBeCloseTo(((30 / 30) * 16) / 9, 3);
	});

	it("leaves the source alone when the inputs are degenerate", () => {
		const source = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
		expect(lockPipSource(source, { width: 0, height: 20 }, FRAME_169, 16 / 9)).toBe(source);
		expect(lockPipSource(source, { width: 30, height: 20 }, 0, 16 / 9)).toBe(source);
	});
});
