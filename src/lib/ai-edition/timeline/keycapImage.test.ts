import { describe, expect, it } from "vitest";
import { keycapLayout, keycapTokens, keycapWidth } from "./keycapImage";

describe("keycapTokens", () => {
	it("gives each modifier its own cap, in the macOS order, then the key", () => {
		expect(keycapTokens({ key: "C", modifiers: ["shift", "cmd"] })).toEqual(["⇧", "⌘", "C"]);
		expect(keycapTokens({ key: "K", modifiers: ["cmd", "ctrl"] })).toEqual(["⌃", "⌘", "K"]);
	});

	it("prints special keys the way the keyboard does", () => {
		expect(keycapTokens({ key: "Return", modifiers: ["cmd"] })).toEqual(["⌘", "⏎"]);
		expect(keycapTokens({ key: "Esc", modifiers: [] })).toEqual(["esc"]);
		expect(keycapTokens({ key: "F1", modifiers: [] })).toEqual(["F1"]);
		expect(keycapTokens({ key: "Space", modifiers: ["alt"] })).toEqual(["⌥", "space"]);
	});
});

describe("keycapLayout", () => {
	it("makes a symbol or a letter a square cap and a word a wider one", () => {
		expect(keycapWidth("K")).toBe(100);
		expect(keycapWidth("⌘")).toBe(100);
		expect(keycapWidth("space")).toBeGreaterThan(100);
		expect(keycapWidth("esc")).toBeGreaterThanOrEqual(100);
	});

	it("is as wide as its caps, the gaps and the padding", () => {
		const one = keycapLayout(["K"]);
		const two = keycapLayout(["⌘", "K"]);
		expect(two.width).toBeGreaterThan(one.width + 100);
		expect(two.height).toBe(one.height);
		expect(two.widths).toEqual([100, 100]);
	});
});
