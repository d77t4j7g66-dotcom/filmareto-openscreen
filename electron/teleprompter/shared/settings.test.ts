import { describe, expect, it } from "vitest";
import {
	activeHotkeys,
	bindingParts,
	DEFAULT_HOTKEYS,
	DEFAULT_PROMPTER,
	defaultSettings,
	formatBinding,
	nextPosition,
	normalizeSettings,
	positionPatch,
	settingsWindowOnTop,
} from "./settings";

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

describe("cameraOpacity", () => {
	const read = (cameraOpacity: unknown) =>
		normalizeSettings({ prompter: { cameraOpacity } }, "/home").prompter.cameraOpacity;

	it("is off by default, also for settings saved before it existed", () => {
		expect(DEFAULT_PROMPTER.cameraOpacity).toBe(0);
		expect(normalizeSettings({ prompter: {} }, "/home").prompter.cameraOpacity).toBe(0);
		expect(normalizeSettings(null, "/home").prompter.cameraOpacity).toBe(0);
	});

	it("keeps a value in range and clamps the rest", () => {
		expect(read(0.4)).toBe(0.4);
		expect(read(1)).toBe(1);
		expect(read(7)).toBe(1);
		expect(read(-2)).toBe(0);
	});

	it("falls back to off for anything that is not a number", () => {
		for (const bad of ["0.5", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, true]) {
			expect(read(bad)).toBe(0);
		}
	});
});

describe("position", () => {
	const read = (position: unknown) =>
		normalizeSettings({ prompter: { position } }, "/home").prompter.position;

	it("moves a saved notch or floating prompter to the top of the screen", () => {
		expect(read("notch")).toBe("screen");
		expect(read("free")).toBe("screen");
	});

	it("keeps full screen and the top of the screen", () => {
		expect(read("fullscreen")).toBe("fullscreen");
		expect(read("screen")).toBe("screen");
	});

	it("opens at the top of the screen by default and for anything unknown", () => {
		expect(DEFAULT_PROMPTER.position).toBe("screen");
		expect(read("sideways")).toBe("screen");
		expect(read(undefined)).toBe("screen");
	});

	it("is toggled by the shortcut between full screen and the top", () => {
		expect(nextPosition("screen")).toBe("fullscreen");
		expect(nextPosition("fullscreen")).toBe("screen");
	});
});

describe("migration from the notch and floating positions", () => {
	it("keeps the background opacity they had", () => {
		for (const position of ["notch", "free"]) {
			const read = normalizeSettings(
				{ prompter: { position, opacity: 0.8, screenOpacity: 0.3 } },
				"/home",
			).prompter;
			expect(read.screenOpacity).toBe(0.8);
		}
	});

	it("leaves a screen prompter's own opacity alone", () => {
		const read = normalizeSettings(
			{ prompter: { position: "screen", opacity: 0.8, screenOpacity: 0.3 } },
			"/home",
		).prompter;
		expect(read.screenOpacity).toBe(0.3);
	});
});

describe("cameraPreview", () => {
	it("is off by default, also for settings saved before it existed", () => {
		expect(defaultSettings("/home").cameraPreview).toEqual({ enabled: false, displayId: null });
		expect(normalizeSettings({}, "/home").cameraPreview).toEqual({
			enabled: false,
			displayId: null,
		});
		expect(normalizeSettings(null, "/home").cameraPreview.enabled).toBe(false);
	});

	it("keeps a saved switch and display", () => {
		const saved = normalizeSettings({ cameraPreview: { enabled: true, displayId: 3 } }, "/home");
		expect(saved.cameraPreview).toEqual({ enabled: true, displayId: 3 });
	});

	it("falls back for values of the wrong type", () => {
		const saved = normalizeSettings({ cameraPreview: { enabled: "yes", displayId: "3" } }, "/home");
		expect(saved.cameraPreview).toEqual({ enabled: false, displayId: null });
	});
});

describe("hotkeys", () => {
	it("keeps the new key names and a cleared shortcut", () => {
		const hotkeys = [
			{ action: "playPause", key: "Keypad5", modifiers: ["cmd"] },
			{ action: "nextLine", key: "F13", modifiers: [] },
			{ action: "prevLine", key: "", modifiers: [] },
		];
		const read = normalizeSettings({ hotkeys }, "/home").hotkeys;
		expect(read.find((h) => h.action === "playPause")).toMatchObject({ key: "Keypad5" });
		expect(read.find((h) => h.action === "nextLine")).toMatchObject({ key: "F13", modifiers: [] });
		expect(read.find((h) => h.action === "prevLine")).toMatchObject({ key: "" });
	});

	it("falls back to the default for a key name that does not exist", () => {
		const read = normalizeSettings(
			{ hotkeys: [{ action: "playPause", key: "F20", modifiers: [] }] },
			"/home",
		);
		expect(read.hotkeys.find((h) => h.action === "playPause")).toEqual(DEFAULT_HOTKEYS[0]);
	});

	it("leaves a cleared shortcut out of what the helper registers", () => {
		const bindings = [
			{ action: "playPause", key: "", modifiers: [] },
			{ action: "nextLine", key: "Down", modifiers: ["ctrl", "alt"] },
		] as const;
		expect(activeHotkeys([...bindings]).map((b) => b.action)).toEqual(["nextLine"]);
	});

	it("reads as keycaps, modifiers first", () => {
		expect(bindingParts({ key: "Down", modifiers: ["alt", "ctrl"] })).toEqual(["⌃", "⌥", "↓"]);
		expect(bindingParts({ key: "Keypad5", modifiers: ["cmd"] })).toEqual(["⌘", "Num 5"]);
		expect(bindingParts({ key: "", modifiers: [] })).toEqual([]);
		expect(formatBinding({ action: "playPause", key: "Space", modifiers: ["ctrl", "alt"] })).toBe(
			"⌃⌥Space",
		);
	});
});

describe("positionPatch", () => {
	const displays = { primary: 1, secondary: 2 };

	it("moves a display that was never picked to the new position's default, both ways", () => {
		expect(positionPatch({ displayPicked: false }, "fullscreen", displays)).toEqual({
			position: "fullscreen",
			displayId: 2,
		});
		expect(positionPatch({ displayPicked: false }, "screen", displays)).toEqual({
			position: "screen",
			displayId: 1,
		});
	});

	it("leaves a display the user picked alone", () => {
		expect(positionPatch({ displayPicked: true }, "fullscreen", displays)).toEqual({
			position: "fullscreen",
		});
	});

	it("changes only the position with a single display", () => {
		expect(
			positionPatch({ displayPicked: false }, "fullscreen", { primary: 1, secondary: null }),
		).toEqual({ position: "fullscreen" });
	});

	it("is not picked by default, nor after a migration", () => {
		expect(DEFAULT_PROMPTER.displayPicked).toBe(false);
		const read = normalizeSettings({ prompter: { position: "notch", displayId: 5 } }, "/home");
		expect(read.prompter.displayPicked).toBe(false);
		expect(
			normalizeSettings({ prompter: { displayPicked: true, displayId: 5 } }, "/home").prompter
				.displayPicked,
		).toBe(true);
	});
});
