import { describe, expect, it } from "vitest";
import { settingsWindowOnTop } from "./settings";

describe("settingsWindowOnTop", () => {
	const LAPTOP = 2;
	const PROMPTER_GLASS = 10;

	it("floats over a full-screen prompter on its own display, which would bury it", () => {
		expect(settingsWindowOnTop({ position: "fullscreen", displayId: LAPTOP }, LAPTOP)).toBe(true);
	});

	// A prompter display (the glass of a hardware teleprompter) shows the text full screen while
	// the settings sit on the screen being recorded: pinned on top there, they cover the take.
	it("stays a normal window when the full-screen prompter is on another display", () => {
		expect(settingsWindowOnTop({ position: "fullscreen", displayId: PROMPTER_GLASS }, LAPTOP)).toBe(
			false,
		);
	});

	it("floats when no display was picked: the prompter then opens where the pointer is", () => {
		expect(settingsWindowOnTop({ position: "fullscreen", displayId: null }, LAPTOP)).toBe(true);
	});

	it("never floats for a prompter that is not full screen", () => {
		for (const position of ["notch", "free", "screen"] as const) {
			expect(settingsWindowOnTop({ position, displayId: LAPTOP }, LAPTOP)).toBe(false);
		}
	});
});
