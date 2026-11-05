import { describe, expect, it } from "vitest";
import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
import { patchKeycaps } from "./keycapLayout";

const cap = (id: string, group: string, x: number, width: number): AxcutAnnotationRegion =>
	({
		id,
		startMs: 0,
		endMs: 1000,
		type: "image",
		content: "",
		space: "frame",
		position: { x, y: 80 },
		size: { width, height: 6 },
		style: {},
		zIndex: 1,
		annotationSource: "keycap",
		annotationGroup: group,
	}) as unknown as AxcutAnnotationRegion;

const set = () => [cap("a1", "a", 40, 10), cap("a2", "a", 50, 10), cap("b1", "b", 45, 10)];

describe("keycap layout", () => {
	it("ignores regions that are not keycaps", () => {
		const plain = [{ ...cap("p", "g", 0, 5), annotationSource: undefined }];
		expect(patchKeycaps(plain, "p", { position: { x: 1, y: 1 } })).toBeNull();
	});

	it("moves every combination onto the same centre", () => {
		const out = patchKeycaps(set(), "a1", { position: { x: 20, y: 60 } }) ?? [];
		const centre = (ids: string[]) => {
			const parts = out.filter((r) => ids.includes(r.id));
			const min = Math.min(...parts.map((r) => r.position.x));
			const max = Math.max(...parts.map((r) => r.position.x + r.size.width));
			return (min + max) / 2;
		};
		expect(centre(["a1", "a2"])).toBeCloseTo(centre(["b1"]), 5);
	});

	it("snaps the group's centre onto the middle of the frame", () => {
		const out = patchKeycaps(set(), "a1", { position: { x: 40.5, y: 80 } }) ?? [];
		const a = out.filter((r) => r.annotationGroup === "a");
		const min = Math.min(...a.map((r) => r.position.x));
		const max = Math.max(...a.map((r) => r.position.x + r.size.width));
		expect((min + max) / 2).toBe(50);
	});

	it("scales every key to the same height, keeping each combination's spacing", () => {
		const out = patchKeycaps(set(), "a1", { size: { width: 20, height: 12 } }) ?? [];
		expect(out.every((r) => r.size.height === 12)).toBe(true);
		const [a1, a2] = out;
		expect(a2.position.x - a1.position.x).toBeCloseTo(20, 5);
	});
});
