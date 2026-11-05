import { describe, expect, it } from "vitest";
import { parseCombination } from "./KeycapsDialog";

describe("parseCombination", () => {
	it("reads modifiers and a key, in any case", () => {
		expect(parseCombination("Cmd+Shift+Z")).toEqual({ key: "Z", modifiers: ["cmd", "shift"] });
		expect(parseCombination("ctrl + opt + k")).toEqual({ key: "K", modifiers: ["ctrl", "alt"] });
	});

	it("reads a plain key and the named ones", () => {
		expect(parseCombination("e")).toEqual({ key: "E", modifiers: [] });
		expect(parseCombination("Cmd+Enter")).toEqual({ key: "Return", modifiers: ["cmd"] });
		expect(parseCombination("space")).toEqual({ key: "Space", modifiers: [] });
	});

	it("has no key for an empty text", () => {
		expect(parseCombination("  ")).toBeNull();
		expect(parseCombination("+")).toBeNull();
	});
});
