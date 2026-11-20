// The named caption looks. Each is whole: font, colours, light and how the word being said behaves.
//
// They follow what the references do, under names of our own: the word-following styles of Submagic
// and the reels made with it, the stacks of Ajene Pinnock's studio, the lit serif titles of premium
// tutorials, and the user's own gold and red reels. Every font has Greek. A style's fit (how many
// words at once, how high) is in `CAPTION_STYLE_FIT`, because moving a caption does not change its look.

import type { CaptionLook } from "./settings";

const STILL = {
	textCase: "as-spoken",
	activeWordColor: null,
	activeWordPill: null,
	emphasis: "none",
	emphasisColor: "#ff8a2a",
	emphasisFont: "Georgia",
	emphasisItalic: true,
	emphasisSize: 2,
	strokeEm: 0,
	strokeColor: "#000000",
	shadow: false,
	pop: false,
	dropPunctuation: false,
	fx: null,
	activeWordPop: 1,
	activeWordHold: 1,
	activeWordGlow: null,
	pillSlides: false,
	build: false,
	pastWordColor: null,
	futureWordColor: null,
	twoLines: false,
	emoji: false,
} as const;

const NO_PLATE = {
	backgroundEnabled: false,
	backgroundColor: "#000000",
	backgroundOpacity: 0.55,
} as const;

const PLATE = (color: string, opacity: number) => ({
	backgroundEnabled: true,
	backgroundColor: color,
	backgroundOpacity: opacity,
});

function look(over: Partial<CaptionLook>): CaptionLook {
	return {
		fontFamily: "Inter",
		fontWeight: "bold",
		fontSize: 48,
		color: "#ffffff",
		...NO_PLATE,
		...STILL,
		dropPunctuation: true,
		...over,
	};
}

/** Heavy capitals with an outline, and one word that jumps. */
function creator(activeWordColor: string, over: Partial<CaptionLook> = {}): CaptionLook {
	return look({
		fontFamily: "Geologica Black",
		fontWeight: "normal",
		fontSize: 60,
		textCase: "upper",
		strokeEm: 0.085,
		shadow: true,
		pop: true,
		activeWordColor,
		activeWordPop: 1.2,
		activeWordHold: 1.07,
		...over,
	});
}

/** Text on a sliding pill. */
function pill(activeWordPill: string, over: Partial<CaptionLook> = {}): CaptionLook {
	return look({
		fontFamily: "Geologica",
		fontSize: 50,
		strokeEm: 0.05,
		shadow: true,
		activeWordPill,
		pillSlides: true,
		...over,
	});
}

/** A box behind each line, as a TikTok text box has. */
function box(color: string, text: string, over: Partial<CaptionLook> = {}): CaptionLook {
	return look({
		fontFamily: "Geologica",
		fontSize: 50,
		color: text,
		// Only read if a plate is picked later: the box itself is `linePlate`.
		backgroundColor: color.startsWith("#") ? color : "#000000",
		fx: { linePlate: { color, radiusEm: 0.16, padXEm: 0.22, padYEm: 0.06 } },
		...over,
	});
}

/** A small line, then the word that matters, big. */
function stack(emphasisColor: string, over: Partial<CaptionLook> = {}): CaptionLook {
	return look({
		fontFamily: "Open Sans Condensed",
		fontSize: 44,
		emphasis: "big-word",
		emphasisColor,
		emphasisFont: "Open Sans Condensed ExtraBold",
		emphasisItalic: false,
		emphasisSize: 1.8,
		strokeEm: 0.05,
		shadow: true,
		fx: { leading: 0.84 },
		pop: true,
		...over,
	});
}

/** A glowing title, line by line. */
function lit(palettes: string[][], colors: string[], over: Partial<CaptionLook> = {}): CaptionLook {
	return look({
		fontFamily: "LT Remark Black Italic",
		fontWeight: "normal",
		fontSize: 84,
		twoLines: true,
		pop: true,
		fx: {
			fill: { kind: "gradient", palettes, angle: 125, core: 0.55 },
			glow: { colors, em: 0.9, strength: 1.1 },
			bevel: 0.15,
			leading: 0.82,
		},
		...over,
	});
}

// Lit from the top right. The white inside the strokes is `core`, so hairlines keep their colour.
const BLUE_RAMP = ["#e8f1ff", "#8db7ff", "#3f7dff", "#1f58f0"];
const PINK_RAMP = ["#ffeaf7", "#ff9bd8", "#ff4fb8", "#d9148f"];
const CYAN_RAMP = ["#e6fdff", "#7febff", "#25cdfa", "#0a7fe0"];
const VIOLET_RAMP = ["#f1e8ff", "#c09bff", "#8f55ff", "#5b1ee0"];
const GOLD_RAMP = ["#fff6d8", "#ffd566", "#e39a1c", "#9d5a06", "#ffd98a"];
const CHROME_RAMP = ["#ffffff", "#dfe9f5", "#8ea3bd", "#2d3a4d", "#f4f7fb", "#a9b7c9"];
const GLINT = {
	color: "#ffffff",
	periodMs: 2600,
	sweepMs: 900,
	em: 0.5,
	angle: 18,
	strength: 0.95,
};

export const CAPTION_STYLES = {
	// ── Plain ─────────────────────────────────────────────────────────────
	classic: look({ ...PLATE("#000000", 0.55), dropPunctuation: false }),
	minimal: look({
		fontWeight: "normal",
		fontSize: 40,
		...PLATE("#000000", 0.4),
		dropPunctuation: false,
	}),
	light: look({ color: "#111111", ...PLATE("#ffffff", 0.9), dropPunctuation: false }),
	bold: look({
		fontFamily: "Open Sans Condensed",
		fontSize: 60,
		color: "#fde047",
		...PLATE("#000000", 0.85),
		dropPunctuation: false,
	}),
	plain: look({ fontWeight: "normal", fontSize: 44, shadow: true, strokeEm: 0.06 }),
	chest: look({ fontSize: 34, shadow: true, strokeEm: 0.07 }),
	editorial: look({
		fontFamily: "Syne ExtraBold",
		fontWeight: "normal",
		fontSize: 54,
		strokeEm: 0.05,
		shadow: true,
	}),
	serifQuiet: look({
		fontFamily: "LT Remark Italic",
		fontWeight: "normal",
		fontSize: 58,
		strokeEm: 0.05,
		shadow: true,
		pop: true,
	}),
	code: look({
		fontFamily: "Source Code Pro",
		fontWeight: "normal",
		fontSize: 42,
		strokeEm: 0.09,
		shadow: true,
		build: true,
	}),

	// ── Word that jumps ───────────────────────────────────────────────────
	punch: creator("#ffb000", {
		fontFamily: "Open Sans Condensed",
		fontWeight: "bold",
		fontSize: 68,
		strokeEm: 0.07,
	}),
	outline: creator("#ffe100", { fontSize: 56, strokeEm: 0.11 }),
	money: creator("#27e36b", { emoji: true }),
	sun: creator("#ffd400", { emoji: true }),
	flame: creator("#ff5a1f"),
	sky: creator("#33c8ff"),
	bubblegum: creator("#ff4fb4"),
	grape: creator("#b98cff"),
	tall: creator("#ffffff", {
		fontFamily: "Open Sans Condensed ExtraBold",
		fontSize: 78,
		color: "rgba(255, 255, 255, 0.72)",
		strokeEm: 0.075,
		activeWordPop: 1.14,
		activeWordHold: 1.04,
	}),
	superior: creator("#ffcc00", { fontFamily: "LT Superior Black", fontSize: 54 }),
	sturdy: creator("#7cff4f", { fontFamily: "Source Sans Black", fontSize: 66 }),
	comic: creator("#ffe100", {
		fontFamily: "Oi",
		fontSize: 46,
		textCase: "as-spoken",
		strokeEm: 0.1,
		fx: { hardShadow: { color: "#000000", xEm: 0.05, yEm: 0.09 } },
		emoji: true,
	}),
	pixel: creator("#39ff88", { fontFamily: "Pixeloid Sans", fontSize: 44, strokeEm: 0.07 }),
	oneWord: creator("#ffffff", {
		fontFamily: "Geologica",
		fontWeight: "bold",
		fontSize: 76,
		textCase: "as-spoken",
		strokeEm: 0.07,
		activeWordColor: null,
		activeWordPop: 1,
		activeWordHold: 1,
	}),
	oneLoud: creator("#ffe100", {
		fontSize: 92,
		strokeEm: 0.09,
		activeWordPop: 1.16,
		activeWordHold: 1,
	}),

	// ── Pills and boxes ───────────────────────────────────────────────────
	spotlight: pill("#ee6c0e"),
	violet: pill("#7b3cff"),
	mint: pill("#10b981"),
	cherry: pill("#ef2b4b", {
		textCase: "upper",
		fontFamily: "Geologica Black",
		fontWeight: "normal",
		fontSize: 46,
	}),
	ink: pill("#000000", { strokeEm: 0, fontFamily: "Manrope ExtraBold", fontWeight: "normal" }),
	tiktok: box("#ffffff", "#111111"),
	night: box("#000000", "#ffffff"),
	highlighter: box("#ffd400", "#111111", {
		fontFamily: "Open Sans Condensed ExtraBold",
		fontWeight: "normal",
		fontSize: 58,
		emoji: true,
		fx: {
			linePlate: { color: "#ffd400", radiusEm: 0.03, padXEm: 0.16, padYEm: 0.02, block: true },
			leading: 0.86,
		},
	}),
	redBar: box("#e11d2e", "#ffffff", {
		fontFamily: "Geologica Black",
		fontWeight: "normal",
		textCase: "upper",
		fontSize: 46,
	}),
	glass: box("rgba(24, 26, 34, 0.5)", "#ffffff", {
		fontFamily: "Manrope ExtraBold",
		fontWeight: "normal",
	}),

	// ── Stacks ────────────────────────────────────────────────────────────
	fitted: stack("#d07f42", {
		fontSize: 42,
		emphasisFont: "Georgia",
		emphasisItalic: true,
		emphasisSize: 2,
		strokeEm: 0.06,
	}),
	glow: look({ fontSize: 46, emphasis: "key-word", strokeEm: 0.06, shadow: true, pop: true }),
	yellowLine: look({
		fontFamily: "Open Sans Condensed",
		fontSize: 64,
		color: "#ffe14a",
		strokeEm: 0.05,
		shadow: true,
		emoji: true,
	}),
	stackWhite: stack("#ffffff"),
	stackYellow: stack("#ffd400", { emoji: true }),
	stackOrange: stack("#ee6c0e"),
	bigType: stack("#ee6c0e", { fontSize: 36, emphasisSize: 2.5 }),
	serifAccent: stack("#ffd9a8", { emphasisFont: "LT Remark Black Italic", emphasisSize: 2.1 }),

	// ── Word by word ──────────────────────────────────────────────────────
	build: creator("#ffffff", {
		build: true,
		activeWordColor: null,
		activeWordPop: 1.18,
		activeWordHold: 1,
	}),
	buildSoft: look({
		fontSize: 50,
		strokeEm: 0.06,
		shadow: true,
		build: true,
		activeWordPop: 1.08,
		activeWordHold: 1,
		twoLines: true,
	}),
	karaoke: creator("#ffe100", {
		pastWordColor: "#ffe100",
		futureWordColor: "rgba(255, 255, 255, 0.55)",
		activeWordPop: 1.12,
		activeWordHold: 1.02,
	}),

	// ── Light ─────────────────────────────────────────────────────────────
	neonDuo: lit([BLUE_RAMP, PINK_RAMP], ["#2a6bff", "#ff2ba6"]),
	neonPink: lit([PINK_RAMP], ["#ff2ba6"]),
	neonBlue: lit([BLUE_RAMP], ["#2a6bff"]),
	neonViolet: lit([VIOLET_RAMP, CYAN_RAMP], ["#7b2bff", "#18c8ff"]),
	neonSans: lit([CYAN_RAMP], ["#10b8ff"], {
		fontFamily: "Geologica Black",
		fontSize: 70,
		textCase: "upper",
	}),
	neonTube: look({
		fontFamily: "LT Superior Black",
		fontWeight: "normal",
		fontSize: 72,
		textCase: "upper",
		twoLines: true,
		pop: true,
		strokeEm: 0.016,
		strokeColor: "#d9fdff",
		fx: {
			fill: { kind: "none", palettes: [] },
			glow: { colors: ["#19f0ff"], em: 0.5, strength: 1 },
		},
	}),
	redGlow: look({
		fontFamily: "Open Sans Condensed ExtraBold",
		fontWeight: "normal",
		fontSize: 78,
		textCase: "upper",
		twoLines: true,
		fx: { glow: { colors: ["#ff1f2e"], em: 0.55, strength: 1 }, enter: "blur" },
	}),
	whiteGlow: look({
		fontFamily: "LT Remark Italic",
		fontWeight: "normal",
		fontSize: 82,
		twoLines: true,
		fx: { glow: { colors: ["#ffffff"], em: 0.4, strength: 0.5, night: 0.9 }, enter: "blur" },
	}),

	// ── Metal ─────────────────────────────────────────────────────────────
	gold: look({
		fontFamily: "Geologica Black",
		fontWeight: "normal",
		fontSize: 74,
		textCase: "upper",
		twoLines: true,
		pop: true,
		fx: {
			fill: { kind: "gradient", palettes: [GOLD_RAMP], angle: 90 },
			bevel: 0.8,
			shine: GLINT,
			glow: { colors: ["#ff9b1c"], em: 0.45, strength: 0.55 },
		},
	}),
	goldSerif: lit([GOLD_RAMP], ["#ff9b1c"], {
		fx: {
			fill: { kind: "gradient", palettes: [GOLD_RAMP], angle: 90 },
			bevel: 0.7,
			shine: GLINT,
			glow: { colors: ["#ff9b1c"], em: 0.5, strength: 0.6 },
		},
	}),
	goldWhite: look({
		fontFamily: "Open Sans Condensed ExtraBold",
		fontWeight: "normal",
		fontSize: 76,
		twoLines: true,
		shadow: true,
		fx: {
			fill: {
				kind: "gradient",
				palettes: [
					["#ffffff", "#ffffff"],
					["#ff8a1f", "#ffe3b0"],
				],
				angle: 0,
			},
			glow: { colors: ["#e17d1e"], em: 0.35, strength: 0.45 },
			enter: "wipe",
		},
	}),
	chrome: look({
		fontFamily: "Geologica Black",
		fontWeight: "normal",
		fontSize: 74,
		textCase: "upper",
		twoLines: true,
		pop: true,
		shadow: true,
		strokeEm: 0.03,
		strokeColor: "#0b0f16",
		fx: { fill: { kind: "gradient", palettes: [CHROME_RAMP], angle: 90 }, bevel: 1, shine: GLINT },
	}),

	// ── Colour in the letters ─────────────────────────────────────────────
	plasma: look({
		fontFamily: "Geologica Black",
		fontWeight: "normal",
		fontSize: 74,
		textCase: "upper",
		twoLines: true,
		pop: true,
		fx: {
			fill: {
				kind: "plasma",
				palettes: [["#ff7bf0", "#ffb3f5", "#ffffff", "#8ff2ff", "#c19bff"]],
				scale: 3.2,
				core: 0.3,
			},
			glow: { colors: ["#8a2bff"], em: 0.6, strength: 0.95 },
		},
	}),
	plasmaFire: look({
		fontFamily: "Geologica Black",
		fontWeight: "normal",
		fontSize: 74,
		textCase: "upper",
		twoLines: true,
		pop: true,
		fx: {
			fill: {
				kind: "plasma",
				palettes: [["#b3000c", "#ff3b0a", "#ff8a00", "#ffd400", "#fff3b0"]],
				scale: 2.2,
				flow: 0.5,
				core: 0.25,
			},
			glow: { colors: ["#ff4a0a"], em: 0.6, strength: 0.95 },
		},
	}),
	holo: look({
		fontFamily: "LT Superior Black",
		fontWeight: "normal",
		fontSize: 70,
		textCase: "upper",
		twoLines: true,
		pop: true,
		shadow: true,
		fx: {
			fill: {
				kind: "plasma",
				palettes: [["#ff9de2", "#ffd6a5", "#fdffb6", "#a0ffd6", "#9bd5ff", "#c8b6ff"]],
				scale: 3,
			},
			bevel: 0.5,
			glow: { colors: ["#c8b6ff"], em: 0.4, strength: 0.4 },
		},
	}),
	sunset: look({
		fontFamily: "Geologica Black",
		fontWeight: "normal",
		fontSize: 72,
		textCase: "upper",
		twoLines: true,
		pop: true,
		shadow: true,
		fx: { fill: { kind: "gradient", palettes: [["#ff7a18", "#ff2d8b", "#7a2bff"]], angle: 15 } },
	}),
	aurora: look({
		fontFamily: "Geologica Black",
		fontWeight: "normal",
		fontSize: 72,
		textCase: "upper",
		twoLines: true,
		pop: true,
		shadow: true,
		fx: {
			fill: {
				kind: "gradient",
				palettes: [["#16f4d0", "#3a86ff", "#8338ec", "#ff006e"]],
				angle: 0,
				flow: 0.18,
			},
			glow: { colors: ["#3a86ff"], em: 0.4, strength: 0.5 },
		},
	}),
	ice: lit([CYAN_RAMP], ["#10b8ff"], {
		fontFamily: "LT Superior Black",
		fontSize: 66,
		textCase: "upper",
		fx: {
			fill: {
				kind: "gradient",
				palettes: [["#ffffff", "#bff4ff", "#4fc8ff", "#0a62d0"]],
				angle: 90,
			},
			bevel: 0.6,
			shine: GLINT,
			glow: { colors: ["#10b8ff"], em: 0.5, strength: 0.7 },
		},
	}),
} satisfies Record<string, CaptionLook>;

export type CaptionStyleId = keyof typeof CAPTION_STYLES;

/** How the pane groups them. */
export const CAPTION_STYLE_GROUPS: Array<{ id: string; styles: CaptionStyleId[] }> = [
	{
		id: "light",
		styles: [
			"neonDuo",
			"neonPink",
			"neonBlue",
			"neonViolet",
			"neonSans",
			"neonTube",
			"redGlow",
			"whiteGlow",
			"glow",
		],
	},
	{ id: "metal", styles: ["gold", "goldSerif", "goldWhite", "chrome", "ice"] },
	{ id: "colour", styles: ["plasma", "plasmaFire", "holo", "sunset", "aurora"] },
	{
		id: "jump",
		styles: [
			"money",
			"sun",
			"punch",
			"outline",
			"flame",
			"sky",
			"bubblegum",
			"grape",
			"tall",
			"superior",
			"sturdy",
			"comic",
			"pixel",
			"oneWord",
			"oneLoud",
		],
	},
	{
		id: "boxes",
		styles: [
			"spotlight",
			"violet",
			"mint",
			"cherry",
			"ink",
			"tiktok",
			"night",
			"highlighter",
			"redBar",
			"glass",
		],
	},
	{
		id: "stacks",
		styles: [
			"yellowLine",
			"stackWhite",
			"stackYellow",
			"stackOrange",
			"bigType",
			"fitted",
			"serifAccent",
		],
	},
	{ id: "words", styles: ["build", "buildSoft", "karaoke", "code"] },
	{
		id: "plain",
		styles: ["classic", "minimal", "light", "bold", "plain", "chest", "editorial", "serifQuiet"],
	},
];

/** The styles a title can take: the ones whose whole point is the look of the letters. */
export const TITLE_STYLE_IDS: CaptionStyleId[] = [
	"neonDuo",
	"neonPink",
	"neonBlue",
	"neonViolet",
	"neonSans",
	"neonTube",
	"redGlow",
	"whiteGlow",
	"gold",
	"goldSerif",
	"goldWhite",
	"chrome",
	"ice",
	"plasma",
	"plasmaFire",
	"holo",
	"sunset",
	"aurora",
	"tiktok",
	"night",
	"highlighter",
	"redBar",
	"glass",
	"comic",
	"editorial",
];

const UNDER_CHIN = 24;

/** Words at once, and in a tall frame how high it sits, % up from the bottom. */
export const CAPTION_STYLE_FIT: Record<
	CaptionStyleId,
	{ min: number; max: number; insetY?: number }
> = Object.fromEntries(
	(Object.keys(CAPTION_STYLES) as CaptionStyleId[]).map((id) => {
		const style: CaptionLook = CAPTION_STYLES[id];
		if (style.backgroundEnabled) return [id, { min: 2, max: 7 }];
		if (id === "oneWord" || id === "oneLoud") return [id, { min: 1, max: 1, insetY: 28 }];
		if (id === "chest" || id === "plain") return [id, { min: 3, max: 6, insetY: 22 }];
		if (id === "glow") return [id, { min: 3, max: 6, insetY: UNDER_CHIN }];
		if (style.twoLines) return [id, { min: 2, max: 3, insetY: UNDER_CHIN }];
		if (style.activeWordPill || style.fx?.linePlate)
			return [id, { min: 2, max: 4, insetY: UNDER_CHIN }];
		return [id, { min: 1, max: 3, insetY: UNDER_CHIN }];
	}),
) as Record<CaptionStyleId, { min: number; max: number; insetY?: number }>;
