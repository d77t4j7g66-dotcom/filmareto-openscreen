import { describe, expect, it } from "vitest";
import {
	bindingConflict,
	captureKey,
	HOTKEY_KEY_NAMES,
	type KeyEventLike,
	keyNameFromCode,
} from "./hotkeyKeys";

const press = (code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
	code,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
	metaKey: false,
	...mods,
});

describe("keyNameFromCode", () => {
	it("names letters, digits and arrows", () => {
		expect(keyNameFromCode("KeyR")).toBe("R");
		expect(keyNameFromCode("Digit7")).toBe("7");
		expect(keyNameFromCode("ArrowLeft")).toBe("Left");
		expect(keyNameFromCode("ArrowDown")).toBe("Down");
		expect(keyNameFromCode("Space")).toBe("Space");
		expect(keyNameFromCode("Equal")).toBe("Equal");
		expect(keyNameFromCode("Minus")).toBe("Minus");
	});

	it("names F1 to F19 and nothing past them", () => {
		expect(keyNameFromCode("F1")).toBe("F1");
		expect(keyNameFromCode("F19")).toBe("F19");
		expect(keyNameFromCode("F20")).toBeNull();
		expect(keyNameFromCode("F0")).toBeNull();
	});

	it("names the keypad", () => {
		expect(keyNameFromCode("Numpad5")).toBe("Keypad5");
		expect(keyNameFromCode("NumpadAdd")).toBe("KeypadPlus");
		expect(keyNameFromCode("NumpadSubtract")).toBe("KeypadMinus");
		expect(keyNameFromCode("NumpadMultiply")).toBe("KeypadMultiply");
		expect(keyNameFromCode("NumpadDivide")).toBe("KeypadDivide");
		expect(keyNameFromCode("NumpadEnter")).toBe("KeypadEnter");
		expect(keyNameFromCode("NumpadDecimal")).toBe("KeypadDecimal");
		expect(keyNameFromCode("NumpadEqual")).toBe("KeypadEquals");
		expect(keyNameFromCode("NumpadClear")).toBe("KeypadClear");
	});

	it("names the editing and punctuation keys", () => {
		expect(keyNameFromCode("Enter")).toBe("Return");
		expect(keyNameFromCode("BracketLeft")).toBe("LeftBracket");
		expect(keyNameFromCode("BracketRight")).toBe("RightBracket");
		expect(keyNameFromCode("Backquote")).toBe("Grave");
		expect(keyNameFromCode("PageUp")).toBe("PageUp");
		expect(keyNameFromCode("Delete")).toBe("Delete");
	});

	it("only ever returns a name the settings accept", () => {
		const codes = [
			"KeyA",
			"Digit0",
			"ArrowUp",
			"Space",
			"Equal",
			"Minus",
			"F12",
			"Numpad0",
			"NumpadAdd",
			"NumpadEnter",
			"Enter",
			"Tab",
			"Escape",
			"Delete",
			"Home",
			"End",
			"PageUp",
			"PageDown",
			"Comma",
			"Period",
			"Slash",
			"Semicolon",
			"Quote",
			"BracketLeft",
			"BracketRight",
			"Backslash",
			"Backquote",
		];
		for (const code of codes) expect(HOTKEY_KEY_NAMES).toContain(keyNameFromCode(code));
	});

	it("refuses keys outside the set", () => {
		expect(keyNameFromCode("Backspace")).toBeNull();
		expect(keyNameFromCode("CapsLock")).toBeNull();
		expect(keyNameFromCode("IntlBackslash")).toBeNull();
	});
});

describe("captureKey", () => {
	it("waits while only modifiers are down", () => {
		expect(captureKey(press("MetaLeft", { metaKey: true }))).toEqual({ kind: "pending" });
		expect(captureKey(press("AltRight", { altKey: true }))).toEqual({ kind: "pending" });
	});

	it("cancels on Esc and clears on Backspace, when pressed alone", () => {
		expect(captureKey(press("Escape"))).toEqual({ kind: "cancel" });
		expect(captureKey(press("Backspace"))).toEqual({ kind: "clear" });
	});

	it("builds the modifiers and the key name", () => {
		expect(captureKey(press("Numpad5", { metaKey: true, altKey: true }))).toEqual({
			kind: "binding",
			key: "Keypad5",
			modifiers: ["alt", "cmd"],
		});
		expect(captureKey(press("KeyR", { ctrlKey: true, shiftKey: true }))).toEqual({
			kind: "binding",
			key: "R",
			modifiers: ["ctrl", "shift"],
		});
	});

	it("takes an F-key alone", () => {
		expect(captureKey(press("F13"))).toEqual({ kind: "binding", key: "F13", modifiers: [] });
	});

	it("asks for a modifier on any other key", () => {
		expect(captureKey(press("KeyR"))).toEqual({ kind: "needsModifier" });
		expect(captureKey(press("Numpad5"))).toEqual({ kind: "needsModifier" });
		expect(captureKey(press("ArrowLeft"))).toEqual({ kind: "needsModifier" });
	});

	it("lets Esc take a modifier, and refuses keys it has no name for", () => {
		expect(captureKey(press("Escape", { ctrlKey: true }))).toMatchObject({ key: "Escape" });
		expect(captureKey(press("CapsLock"))).toEqual({ kind: "unsupported" });
		expect(captureKey(press("Backspace", { ctrlKey: true }))).toEqual({ kind: "unsupported" });
	});
});

describe("bindingConflict", () => {
	const bindings = [
		{ action: "playPause", key: "Space", modifiers: ["ctrl", "alt"] },
		{ action: "nextLine", key: "Down", modifiers: ["ctrl", "alt"] },
	] as const;

	it("finds the other action that has the combination, in any modifier order", () => {
		expect(
			bindingConflict([...bindings], "prevLine", { key: "Space", modifiers: ["alt", "ctrl"] }),
		).toBe("playPause");
	});

	it("does not count the action's own binding, or a different modifier set", () => {
		expect(
			bindingConflict([...bindings], "playPause", { key: "Space", modifiers: ["ctrl", "alt"] }),
		).toBeNull();
		expect(
			bindingConflict([...bindings], "prevLine", { key: "Space", modifiers: ["ctrl"] }),
		).toBeNull();
	});
});
