import { HOTKEY_KEY_NAMES } from "./hotkeyKeys";
import {
	HOTKEY_ACTIONS,
	type HotkeyAction,
	type HotkeyBinding,
	type HotkeyModifier,
	type PrompterSettings,
} from "./protocol";

/** The camera shown full screen on a display of its own, by the native helper. */
export type CameraPreviewSettings = { enabled: boolean; displayId: number | null };

export type Settings = {
	libraryRoot: string;
	micDeviceId: string | null;
	countdown: boolean;
	cameraPreview: CameraPreviewSettings;
	prompter: PrompterSettings;
	hotkeys: HotkeyBinding[];
};

export const DEFAULT_PROMPTER: PrompterSettings = {
	position: "screen",
	fontSize: 28,
	visibleLines: 4,
	width: 560,
	opacity: 1,
	screenOpacity: 0.55,
	mirror: false,
	showCues: false,
	fadeNearCursor: false,
	mode: "voice",
	speed: 4,
	displayId: null,
	displayPicked: false,
	activeLine: 1 / 3,
	paddingH: 16,
	paddingV: 0,
	lineSpacing: 1,
	showGuide: true,
	cameraOpacity: 0,
};

const CA: HotkeyModifier[] = ["ctrl", "alt"];
export const DEFAULT_HOTKEYS: HotkeyBinding[] = [
	{ action: "playPause", key: "Space", modifiers: CA },
	{ action: "nextLine", key: "Down", modifiers: CA },
	{ action: "prevLine", key: "Up", modifiers: CA },
	{ action: "nextStage", key: "Right", modifiers: CA },
	{ action: "prevStage", key: "Left", modifiers: CA },
	{ action: "retakeStage", key: "R", modifiers: CA },
	{ action: "faster", key: "Equal", modifiers: CA },
	{ action: "slower", key: "Minus", modifiers: CA },
	{ action: "toggleMode", key: "V", modifiers: CA },
	{ action: "toggleVisible", key: "H", modifiers: CA },
	{ action: "cyclePosition", key: "P", modifiers: CA },
];

export const HOTKEY_KEYS: string[] = HOTKEY_KEY_NAMES;

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
	playPause: "Play or pause",
	nextLine: "Next line",
	prevLine: "Previous line",
	nextStage: "Next segment",
	prevStage: "Previous segment",
	retakeStage: "Retake segment",
	faster: "Faster",
	slower: "Slower",
	toggleMode: "Voice or manual",
	toggleVisible: "Hide or show",
	cyclePosition: "Full screen or top",
};

const MODIFIERS: HotkeyModifier[] = ["ctrl", "alt", "shift", "cmd"];
const MOD_SYMBOLS: Record<HotkeyModifier, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
const KEY_SYMBOLS: Record<string, string> = {
	Space: "Space",
	Up: "↑",
	Down: "↓",
	Left: "←",
	Right: "→",
	Equal: "=",
	Minus: "-",
	KeypadPlus: "Num +",
	KeypadMinus: "Num -",
	KeypadMultiply: "Num ×",
	KeypadDivide: "Num ÷",
	KeypadEnter: "Num Enter",
	KeypadDecimal: "Num .",
	KeypadEquals: "Num =",
	KeypadClear: "Num Clear",
	Return: "↩",
	Tab: "⇥",
	Escape: "Esc",
	Delete: "⌦",
	PageUp: "Page up",
	PageDown: "Page down",
	Comma: ",",
	Period: ".",
	Slash: "/",
	Semicolon: ";",
	Quote: "'",
	LeftBracket: "[",
	RightBracket: "]",
	Backslash: "\\",
	Grave: "`",
};

/** The text of one key: a keypad digit reads "Num 5", the rest as in KEY_SYMBOLS. */
export function keyLabel(key: string): string {
	const pad = /^Keypad([0-9])$/.exec(key);
	if (pad) return `Num ${pad[1]}`;
	return KEY_SYMBOLS[key] ?? key;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, min: number, max: number, fallback: number) =>
	typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

export function defaultSettings(home: string): Settings {
	return {
		libraryRoot: home,
		micDeviceId: null,
		countdown: false,
		cameraPreview: { enabled: false, displayId: null },
		prompter: { ...DEFAULT_PROMPTER },
		hotkeys: DEFAULT_HOTKEYS.map((h) => ({ ...h, modifiers: [...h.modifiers] })),
	};
}

export function normalizeSettings(value: unknown, home: string): Settings {
	const d = defaultSettings(home);
	if (!isRecord(value)) return d;
	const p = isRecord(value.prompter) ? value.prompter : {};
	const prompter: PrompterSettings = {
		// The floating and notch positions are gone: a saved one becomes the top of the screen.
		position:
			p.position === "fullscreen"
				? "fullscreen"
				: p.position === "screen" || p.position === "notch" || p.position === "free"
					? "screen"
					: d.prompter.position,
		fontSize: Math.round(num(p.fontSize, 18, 200, d.prompter.fontSize)),
		visibleLines: Math.round(num(p.visibleLines, 1, 12, d.prompter.visibleLines)),
		width: Math.round(num(p.width, 320, 2400, d.prompter.width)),
		opacity: num(p.opacity, 0.2, 1, d.prompter.opacity),
		screenOpacity: num(
			p.position === "notch" || p.position === "free" ? p.opacity : p.screenOpacity,
			0.1,
			1,
			d.prompter.screenOpacity,
		),
		mirror: bool(p.mirror, d.prompter.mirror),
		showCues: bool(p.showCues, d.prompter.showCues),
		fadeNearCursor: bool(p.fadeNearCursor, d.prompter.fadeNearCursor),
		mode:
			p.mode === "voice" || p.mode === "manual" || p.mode === "bullets" ? p.mode : d.prompter.mode,
		speed: Math.round(num(p.speed, 1, 30, d.prompter.speed)),
		displayId: typeof p.displayId === "number" ? p.displayId : null,
		displayPicked: bool(p.displayPicked, d.prompter.displayPicked),
		activeLine: num(p.activeLine, 0, 0.9, d.prompter.activeLine),
		paddingH: Math.round(num(p.paddingH, 0, 600, d.prompter.paddingH)),
		paddingV: Math.round(num(p.paddingV, 0, 400, d.prompter.paddingV)),
		lineSpacing: num(p.lineSpacing, 0.8, 2.5, d.prompter.lineSpacing),
		showGuide: bool(p.showGuide, d.prompter.showGuide),
		cameraOpacity: num(p.cameraOpacity, 0, 1, d.prompter.cameraOpacity),
	};
	const preview = isRecord(value.cameraPreview) ? value.cameraPreview : {};
	const given = Array.isArray(value.hotkeys) ? value.hotkeys : [];
	const hotkeys = HOTKEY_ACTIONS.map((action): HotkeyBinding => {
		const fallback = d.hotkeys.find((h) => h.action === action) as HotkeyBinding;
		const found = given.find(
			(h): h is Record<string, unknown> => isRecord(h) && h.action === action,
		);
		if (
			!found ||
			typeof found.key !== "string" ||
			// An empty key is a shortcut the user cleared.
			!(found.key === "" || HOTKEY_KEYS.includes(found.key)) ||
			!Array.isArray(found.modifiers)
		)
			return fallback;
		const mods = found.modifiers as unknown[];
		return { action, key: found.key, modifiers: MODIFIERS.filter((m) => mods.includes(m)) };
	});
	return {
		libraryRoot:
			typeof value.libraryRoot === "string" && value.libraryRoot.trim()
				? value.libraryRoot
				: d.libraryRoot,
		micDeviceId: typeof value.micDeviceId === "string" ? value.micDeviceId : null,
		countdown: bool(value.countdown, d.countdown),
		cameraPreview: {
			enabled: bool(preview.enabled, d.cameraPreview.enabled),
			displayId: typeof preview.displayId === "number" ? preview.displayId : null,
		},
		prompter,
		hotkeys,
	};
}

/** The keycaps of a shortcut, modifiers first. Empty while it is cleared. */
export function bindingParts(b: Pick<HotkeyBinding, "key" | "modifiers">): string[] {
	if (!b.key) return [];
	return [
		...MODIFIERS.filter((m) => b.modifiers.includes(m)).map((m) => MOD_SYMBOLS[m]),
		keyLabel(b.key),
	];
}

export function formatBinding(b: HotkeyBinding): string {
	return bindingParts(b).join("");
}

/** The shortcuts the helper can register: a cleared one is left out. */
export function activeHotkeys(bindings: HotkeyBinding[]): HotkeyBinding[] {
	return bindings.filter((b) => b.key !== "");
}

/**
 * What changes when the position does. A display the user never picked follows the position: the
 * second display for full screen, the main one for the top. One they picked stays.
 */
export function positionPatch(
	prompter: Pick<PrompterSettings, "displayPicked">,
	position: "fullscreen" | "screen",
	displays: { primary: number; secondary: number | null },
): Partial<PrompterSettings> {
	if (prompter.displayPicked || displays.secondary === null) return { position };
	return {
		position,
		displayId: position === "fullscreen" ? displays.secondary : displays.primary,
	};
}

/** Where the position shortcut goes next: full screen and the top of the screen take turns. */
export function nextPosition(current: PrompterSettings["position"]): "fullscreen" | "screen" {
	return current === "fullscreen" ? "screen" : "fullscreen";
}

export function formatHotkey(bindings: HotkeyBinding[], action: HotkeyAction): string {
	const b = bindings.find((x) => x.action === action);
	return b ? formatBinding(b) : "";
}

/**
 * Whether the teleprompter's settings window has to float. Only a full-screen prompter on the
 * window's own display can bury it; on any other display (a prompter's glass, say) floating
 * would only pin the settings over the screen being recorded. With no display picked, the
 * prompter opens where the pointer is, so it is taken to share the window's display.
 */
export function settingsWindowOnTop(
	prompter: Pick<PrompterSettings, "position" | "displayId">,
	windowDisplayId: number,
): boolean {
	if (prompter.position !== "fullscreen") return false;
	return prompter.displayId === null || prompter.displayId === windowDisplayId;
}
