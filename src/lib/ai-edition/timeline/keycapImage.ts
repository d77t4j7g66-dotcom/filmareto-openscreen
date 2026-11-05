// Keycaps drawn as keys: one rounded, bevelled key per modifier and per key, on a transparent
// PNG. The layout is pure (testable); the drawing needs a canvas and returns null without one.

import type { CursorRecordingKey } from "@/native/contracts";

const MODIFIER_SYMBOL = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" } as const;
const MODIFIER_WORD = { ctrl: "Ctrl", alt: "Opt", shift: "Shift", cmd: "Cmd" } as const;
const MODIFIER_ORDER = ["ctrl", "alt", "shift", "cmd"] as const;

/** How a key is written on its cap: symbols as on a Mac keyboard, or words. */
export type KeycapLabels = "symbols" | "words";
/** The colours of the caps. */
export type KeycapTheme = "dark" | "light";

/** What a key is called on its cap: symbols where the keyboard prints one. */
const KEY_FACE: Record<string, string> = {
	Return: "⏎",
	Enter: "⌤",
	Tab: "⇥",
	Delete: "⌫",
	"Forward Delete": "⌦",
	Esc: "esc",
	Space: "space",
	Left: "←",
	Right: "→",
	Up: "↑",
	Down: "↓",
	"Page Up": "pg up",
	"Page Down": "pg dn",
	Home: "home",
	End: "end",
};

/** The caps to draw, left to right: modifiers in macOS order, then the key. */
export function keycapTokens(
	key: Pick<CursorRecordingKey, "key" | "modifiers">,
	labels: KeycapLabels = "symbols",
): string[] {
	const names = labels === "words" ? MODIFIER_WORD : MODIFIER_SYMBOL;
	const modifiers = MODIFIER_ORDER.filter((m) => key.modifiers.includes(m)).map((m) => names[m]);
	return [...modifiers, KEY_FACE[key.key] ?? key.key];
}

/** The "+" between the keys of a combination: a bare sign, narrower than a key. */
export const PLUS = "+";
const PLUS_WIDTH = 46;
const KEY_HEIGHT = 100;
const KEY_GAP = 14;
const KEY_DEPTH = 9;
const PAD = 14;
const SCALE = 2;

/** Width of one cap in layout units: square for a symbol or a letter, wider for a word. */
export function keycapWidth(token: string): number {
	const length = [...token].length;
	if (token === PLUS) return PLUS_WIDTH;
	return length <= 1 ? KEY_HEIGHT : Math.max(KEY_HEIGHT, 30 + 27 * length);
}

export interface KeycapLayout {
	widths: number[];
	width: number;
	height: number;
}

export function keycapLayout(tokens: string[]): KeycapLayout {
	const widths = tokens.map(keycapWidth);
	const width = widths.reduce((sum, w) => sum + w, 0) + KEY_GAP * (tokens.length - 1) + 2 * PAD;
	return { widths, width, height: KEY_HEIGHT + KEY_DEPTH + 2 * PAD };
}

export interface KeycapImage {
	dataUrl: string;
	/** Width over height of the picture. */
	aspect: number;
}

function roundedRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

export function renderKeycapImage(
	tokens: string[],
	theme: KeycapTheme = "dark",
): KeycapImage | null {
	if (typeof document === "undefined" || tokens.length === 0) return null;
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	const layout = keycapLayout(tokens);
	canvas.width = Math.round(layout.width * SCALE);
	canvas.height = Math.round(layout.height * SCALE);
	ctx.scale(SCALE, SCALE);

	const colours =
		theme === "light"
			? {
					side: "#b9bdc6",
					top: "#ffffff",
					bottom: "#e4e6ec",
					edge: "rgba(0,0,0,0.14)",
					text: "#1c1e24",
				}
			: {
					side: "#15171b",
					top: "#5a5e69",
					bottom: "#383b44",
					edge: "rgba(255,255,255,0.28)",
					text: "#ffffff",
				};
	let x = PAD;
	tokens.forEach((token, index) => {
		const w = layout.widths[index];
		const y = PAD;
		if (token === PLUS) {
			// A bare sign between two keys.
			ctx.fillStyle = theme === "light" ? "#1c1e24" : "#ffffff";
			ctx.font = `700 64px -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.shadowColor = "rgba(0,0,0,0.35)";
			ctx.shadowBlur = 8;
			ctx.fillText("+", x + w / 2, y + KEY_HEIGHT / 2 + 2);
			ctx.shadowColor = "transparent";
			ctx.shadowBlur = 0;
			x += w + KEY_GAP;
			return;
		}
		// The key's side: a darker plate a little lower, so the cap stands on something.
		ctx.save();
		ctx.shadowColor = "rgba(0,0,0,0.45)";
		ctx.shadowBlur = 10;
		ctx.shadowOffsetY = 4;
		ctx.fillStyle = colours.side;
		roundedRect(ctx, x, y + KEY_DEPTH, w, KEY_HEIGHT, 22);
		ctx.fill();
		ctx.restore();
		// The top face.
		const face = ctx.createLinearGradient(0, y, 0, y + KEY_HEIGHT);
		face.addColorStop(0, colours.top);
		face.addColorStop(1, colours.bottom);
		ctx.fillStyle = face;
		roundedRect(ctx, x, y, w, KEY_HEIGHT, 22);
		ctx.fill();
		ctx.strokeStyle = colours.edge;
		ctx.lineWidth = 2;
		roundedRect(ctx, x + 1, y + 1, w - 2, KEY_HEIGHT - 2, 21);
		ctx.stroke();
		// The legend.
		const word = [...token].length > 1;
		ctx.fillStyle = colours.text;
		ctx.font = `${word ? 600 : 700} ${word ? 36 : 54}px -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(token, x + w / 2, y + KEY_HEIGHT / 2 + 2);
		x += w + KEY_GAP;
	});
	return { dataUrl: canvas.toDataURL("image/png"), aspect: layout.width / layout.height };
}
