import { describe, expect, it } from "vitest";
import { smoothFaceTrack } from "./faceTrack";

const face = (t: number, x: number, y = 0.4) => ({ t, x, y });
const none = (t: number) => ({ t, none: true as const });

describe("smoothFaceTrack", () => {
	it("gives null when no point had a face", () => {
		expect(smoothFaceTrack([none(0), none(1), none(2)])).toBeNull();
		expect(smoothFaceTrack([])).toBeNull();
	});

	it("removes a single outlier with the median", () => {
		const points = [0, 1, 2, 3, 4, 5, 6].map((t) => face(t * 2, t === 3 ? 0.95 : 0.5));
		const out = smoothFaceTrack(points);
		// 2 s apart: the 1.5 s average sees one point only, so the median alone decides.
		expect(out?.map((p) => p.x)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
	});

	it("bridges a 2 s gap by linear interpolation", () => {
		const out = smoothFaceTrack([face(0, 0.2), none(1), none(2), face(3, 0.8)]);
		expect(out?.map((p) => p.t)).toEqual([0, 1, 2, 3]);
		// Between the two faces, in order and strictly between them.
		const [a, b, c, d] = out?.map((p) => p.x) ?? [];
		expect(a).toBeLessThan(b);
		expect(b).toBeLessThan(c);
		expect(c).toBeLessThan(d);
		expect(b).toBeGreaterThan(0.2);
		expect(c).toBeLessThan(0.8);
	});

	it("holds the last face across a 5 s gap", () => {
		const out = smoothFaceTrack([face(0, 0.2), none(1), none(2), none(3), none(4), face(6, 0.8)]);
		expect(out?.[1].x).toBeCloseTo(0.2, 5);
		expect(out?.[4].x).toBeCloseTo(0.2, 5);
		expect(out?.[5].x).toBeCloseTo(0.8, 5);
	});

	it("holds the last face to the end of the take, and the first one before it", () => {
		const out = smoothFaceTrack([none(0), face(2, 0.3), none(4)]);
		for (const p of out ?? []) expect(p.x).toBeCloseTo(0.3, 9);
		expect(out).toHaveLength(3);
	});

	it("smooths with a 1.5 s centred average", () => {
		const out = smoothFaceTrack([face(0, 0.2), face(0.5, 0.2), face(1, 0.2), face(1.5, 0.8)]);
		// At t=1.0 the window 0.25..1.75 holds the points at 0.5, 1 and 1.5.
		expect(out?.[2].x).toBeCloseTo((0.2 + 0.2 + 0.8) / 3, 5);
	});

	it("keeps h when the faces have one", () => {
		const out = smoothFaceTrack([
			{ t: 0, x: 0.5, y: 0.5, h: 0.3 },
			{ t: 10, x: 0.5, y: 0.5, h: 0.3 },
		]);
		expect(out?.[0].h).toBeCloseTo(0.3, 5);
	});
});
