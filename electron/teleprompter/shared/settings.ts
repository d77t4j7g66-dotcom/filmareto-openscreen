import {
	HOTKEY_ACTIONS,
	type HotkeyAction,
	type HotkeyBinding,
	type HotkeyModifier,
	type PrompterSettings,
} from "./protocol";

export type Settings = {
	libraryRoot: string;
	micDeviceId: string | null;
	countdown: boolean;
	prompter: PrompterSettings;
	hotkeys: HotkeyBinding[];
};

export const DEFAULT_PROMPTER: PrompterSettings = {
	position: "notch",
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
	activeLine: 1 / 3,
	paddingH: 16,
	paddingV: 0,
	lineSpacing: 1,
	showGuide: true,
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

export const HOTKEY_KEYS: string[] = [
	"Space",
	"Up",
	"Down",
	"Left",
	"Right",
	"Equal",
	"Minus",
	..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
	..."0123456789".split(""),
];

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
	playPause: "Start / pause",
	nextLine: "Next line",
	prevLine: "Previous line",
	nextStage: "Next segment",
	prevStage: "Previous segment",
	retakeStage: "Segment again",
	faster: "Faster (manual)",
	slower: "Slower (manual)",
	toggleMode: "Voice sync ↔ manual",
	toggleVisible: "Hide / show",
	cyclePosition: "Change position",
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
};

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
		prompter: { ...DEFAULT_PROMPTER },
		hotkeys: DEFAULT_HOTKEYS.map((h) => ({ ...h, modifiers: [...h.modifiers] })),
	};
}

export function normalizeSettings(value: unknown, home: string): Settings {
	const d = defaultSettings(home);
	if (!isRecord(value)) return d;
	const p = isRecord(value.prompter) ? value.prompter : {};
	const prompter: PrompterSettings = {
		position:
			p.position === "notch" ||
			p.position === "free" ||
			p.position === "screen" ||
			p.position === "fullscreen"
				? p.position
				: d.prompter.position,
		fontSize: Math.round(num(p.fontSize, 18, 200, d.prompter.fontSize)),
		visibleLines: Math.round(num(p.visibleLines, 1, 12, d.prompter.visibleLines)),
		width: Math.round(num(p.width, 320, 2400, d.prompter.width)),
		opacity: num(p.opacity, 0.2, 1, d.prompter.opacity),
		screenOpacity: num(p.screenOpacity, 0.1, 1, d.prompter.screenOpacity),
		mirror: bool(p.mirror, d.prompter.mirror),
		showCues: bool(p.showCues, d.prompter.showCues),
		fadeNearCursor: bool(p.fadeNearCursor, d.prompter.fadeNearCursor),
		mode:
			p.mode === "voice" || p.mode === "manual" || p.mode === "bullets" ? p.mode : d.prompter.mode,
		speed: Math.round(num(p.speed, 1, 30, d.prompter.speed)),
		displayId: typeof p.displayId === "number" ? p.displayId : null,
		activeLine: num(p.activeLine, 0, 0.9, d.prompter.activeLine),
		paddingH: Math.round(num(p.paddingH, 0, 600, d.prompter.paddingH)),
		paddingV: Math.round(num(p.paddingV, 0, 400, d.prompter.paddingV)),
		lineSpacing: num(p.lineSpacing, 0.8, 2.5, d.prompter.lineSpacing),
		showGuide: bool(p.showGuide, d.prompter.showGuide),
	};
	const given = Array.isArray(value.hotkeys) ? value.hotkeys : [];
	const hotkeys = HOTKEY_ACTIONS.map((action): HotkeyBinding => {
		const fallback = d.hotkeys.find((h) => h.action === action) as HotkeyBinding;
		const found = given.find(
			(h): h is Record<string, unknown> => isRecord(h) && h.action === action,
		);
		if (
			!found ||
			typeof found.key !== "string" ||
			!HOTKEY_KEYS.includes(found.key) ||
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
		prompter,
		hotkeys,
	};
}

export function formatBinding(b: HotkeyBinding): string {
	return (
		MODIFIERS.filter((m) => b.modifiers.includes(m))
			.map((m) => MOD_SYMBOLS[m])
			.join("") + (KEY_SYMBOLS[b.key] ?? b.key)
	);
}

export function formatHotkey(bindings: HotkeyBinding[], action: HotkeyAction): string {
	const b = bindings.find((x) => x.action === action);
	return b ? formatBinding(b) : "";
}
