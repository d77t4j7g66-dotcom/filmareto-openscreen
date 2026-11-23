import type { HotkeyAction, HotkeyBinding, HotkeyModifier } from "./protocol";

/**
 * The key names a shortcut may use. The native helper maps the same names to key codes
 * (`Sources/PrompterCore/KeyCodes.swift`), so a name that is not here is never sent to it.
 */
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const DIGITS = "0123456789".split("");
const F_KEYS = Array.from({ length: 19 }, (_, i) => `F${i + 1}`);
const KEYPAD = [
	...DIGITS.map((d) => `Keypad${d}`),
	"KeypadPlus",
	"KeypadMinus",
	"KeypadMultiply",
	"KeypadDivide",
	"KeypadEnter",
	"KeypadDecimal",
	"KeypadEquals",
	"KeypadClear",
];
export const HOTKEY_KEY_NAMES: string[] = [
	...LETTERS,
	...DIGITS,
	"Left",
	"Right",
	"Up",
	"Down",
	"Space",
	"Equal",
	"Minus",
	...F_KEYS,
	...KEYPAD,
	"Return",
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
	"LeftBracket",
	"RightBracket",
	"Backslash",
	"Grave",
];

const NAMED_CODES: Record<string, string> = {
	ArrowLeft: "Left",
	ArrowRight: "Right",
	ArrowUp: "Up",
	ArrowDown: "Down",
	Space: "Space",
	Equal: "Equal",
	Minus: "Minus",
	NumpadAdd: "KeypadPlus",
	NumpadSubtract: "KeypadMinus",
	NumpadMultiply: "KeypadMultiply",
	NumpadDivide: "KeypadDivide",
	NumpadEnter: "KeypadEnter",
	NumpadDecimal: "KeypadDecimal",
	NumpadEqual: "KeypadEquals",
	NumpadClear: "KeypadClear",
	// Chromium reports the Mac keypad's Clear key as NumLock.
	NumLock: "KeypadClear",
	Enter: "Return",
	Tab: "Tab",
	Escape: "Escape",
	Delete: "Delete",
	Home: "Home",
	End: "End",
	PageUp: "PageUp",
	PageDown: "PageDown",
	Comma: "Comma",
	Period: "Period",
	Slash: "Slash",
	Semicolon: "Semicolon",
	Quote: "Quote",
	BracketLeft: "LeftBracket",
	BracketRight: "RightBracket",
	Backslash: "Backslash",
	Backquote: "Grave",
};

/** The shortcut key name for a `KeyboardEvent.code`, or null when it is not one a shortcut can use. */
export function keyNameFromCode(code: string): string | null {
	const letter = /^Key([A-Z])$/.exec(code);
	if (letter) return letter[1];
	const digit = /^Digit([0-9])$/.exec(code);
	if (digit) return digit[1];
	const f = /^F([0-9]{1,2})$/.exec(code);
	if (f) return Number(f[1]) >= 1 && Number(f[1]) <= 19 ? `F${Number(f[1])}` : null;
	const pad = /^Numpad([0-9])$/.exec(code);
	if (pad) return `Keypad${pad[1]}`;
	return NAMED_CODES[code] ?? null;
}

export type KeyEventLike = {
	code: string;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	metaKey: boolean;
};

export type Capture =
	/** Only modifiers are down so far. */
	| { kind: "pending" }
	| { kind: "cancel" }
	| { kind: "clear" }
	| { kind: "unsupported" }
	| { kind: "needsModifier" }
	| { kind: "binding"; key: string; modifiers: HotkeyModifier[] };

const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)$/;

export function modifiersOf(event: KeyEventLike): HotkeyModifier[] {
	const out: HotkeyModifier[] = [];
	if (event.ctrlKey) out.push("ctrl");
	if (event.altKey) out.push("alt");
	if (event.shiftKey) out.push("shift");
	if (event.metaKey) out.push("cmd");
	return out;
}

/**
 * What a key press means while a shortcut is being recorded. Esc alone cancels, Backspace alone
 * clears the shortcut, and any key other than an F-key has to come with a modifier.
 */
export function captureKey(event: KeyEventLike): Capture {
	if (MODIFIER_CODES.test(event.code)) return { kind: "pending" };
	const modifiers = modifiersOf(event);
	if (modifiers.length === 0) {
		if (event.code === "Escape") return { kind: "cancel" };
		if (event.code === "Backspace") return { kind: "clear" };
	}
	const key = keyNameFromCode(event.code);
	if (!key) return { kind: "unsupported" };
	if (modifiers.length === 0 && !/^F[0-9]+$/.test(key)) return { kind: "needsModifier" };
	return { kind: "binding", key, modifiers };
}

/** The other action that already uses this combination, if any. */
export function bindingConflict(
	bindings: HotkeyBinding[],
	action: HotkeyAction,
	candidate: { key: string; modifiers: HotkeyModifier[] },
): HotkeyAction | null {
	const same = (a: HotkeyModifier[], b: HotkeyModifier[]) =>
		a.length === b.length && a.every((m) => b.includes(m));
	const found = bindings.find(
		(b) => b.action !== action && b.key === candidate.key && same(b.modifiers, candidate.modifiers),
	);
	return found ? found.action : null;
}
