// The edit of a talking head, from the take alone: no AI and nothing leaves the machine. A port of
// Filmareto's own Resolve chain (`talking_head_base_cut`, `cut_the_bad_takes`,
// `slow_zooms_on_long_cuts`, `emphasis_zoom_on_markers`), with its numbers, because that edit is the
// one already approved. Pure: it reads levels and words and returns spans.

import type { ZoomMotion } from "@/components/video-editor/types";

/** How the edit's own cuts and zooms are told from yours, so that a second run replaces only them. */
export const YAPPING_REASON = "yapping";
export const YAPPING_ZOOM_PREFIX = "yap";

export interface Span {
	start: number;
	end: number;
}

export interface SpokenWord extends Span {
	text: string;
}

/** The chain measures per frame of a 30 fps timeline. Its frame counts are kept as seconds here. */
export const LEVELS_PER_SEC = 30;

export const YAPPING = {
	/** Silence is this far below the clip's speech: low enough to take the breaths with it. */
	belowSpeechDb: 12,
	minSilenceSec: 16 / LEVELS_PER_SEC,
	/** Left either side of a cut, so words keep their air. */
	padSec: 5 / LEVELS_PER_SEC,
	minKeepSec: 2 / LEVELS_PER_SEC,
	/** A cut this long gets a slow zoom; a shorter one a punch-in. */
	longCutSec: 3,
	/** A cut this short can be a false start, unless it ends a sentence. */
	falseStartSec: 2,
	tooShortSec: 0.4,
	repeatFloor: 0.72,
	/** Faster than anyone speaks: on a sliver of sound the transcriber makes up a sentence. */
	fastestWordsPerSec: 10,
	/** A whole line said again: fewer words than this can repeat by chance. */
	retakeMinWords: 3,
	/** How many pieces on a line can be said again, with a stray word or two between the takes. */
	retakeReach: 3,
	/** A line you say most of again, fuller: in the user's own edit the lines thrown out scored
	 *  44% and 50%, and every line kept 25% or less. */
	runUpShare: 0.4,
	zooms: [1, 1.2, 1.5],
	slowZoom: 1.2,
	emphasisZoom: 1.2,
	/** An emphasis needs time to go up and come back. */
	minEmphasisSec: 1,
	/** Louder than the clip's usual speech by this much. */
	emphasisDb: 1.5,
	/** Eyes this far down the frame at the strongest zoom. */
	eyeLine: 0.38,
} as const;

function percentile(values: ArrayLike<number>, share: number): number {
	const sorted = Float64Array.from(values as ArrayLike<number>).sort();
	if (sorted.length === 0) return Number.NEGATIVE_INFINITY;
	const at = share * (sorted.length - 1);
	const low = Math.floor(at);
	const high = Math.min(sorted.length - 1, low + 1);
	return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

/** What is worth keeping: everything except long-enough quiet runs, by the clip's own loudness. */
export function speechPieces(levelsDb: ArrayLike<number>): Span[] {
	const n = levelsDb.length;
	if (n === 0) return [];
	const threshold = percentile(levelsDb, 0.95) - YAPPING.belowSpeechDb;
	const minSilence = Math.round(YAPPING.minSilenceSec * LEVELS_PER_SEC);
	const pad = Math.round(YAPPING.padSec * LEVELS_PER_SEC);
	const kept: Array<[number, number]> = [];
	let cursor = 0;
	let i = 0;
	while (i < n) {
		if (levelsDb[i] >= threshold) {
			i += 1;
			continue;
		}
		let j = i;
		while (j < n && levelsDb[j] < threshold) j += 1;
		if (j - i >= minSilence) {
			const from = i + pad;
			const to = j - pad;
			if (to > from) {
				if (from > cursor) kept.push([cursor, from]);
				cursor = to;
			}
		}
		i = j;
	}
	if (cursor < n) kept.push([cursor, n]);
	return kept
		.filter(([a, b]) => b - a >= Math.round(YAPPING.minKeepSec * LEVELS_PER_SEC))
		.map(([a, b]) => ({ start: a / LEVELS_PER_SEC, end: b / LEVELS_PER_SEC }));
}

// ── Saying the same thing twice ─────────────────────────────────────────────

const FILLERS = new Set([
	"εεε",
	"εε",
	"μμμ",
	"μμ",
	"ααα",
	"εμ",
	"ουμ",
	"ενταξει",
	"οκ",
	"ok",
	"okay",
	"erm",
	"uhm",
	"umm",
	"hmm",
]);
const PUNCTUATION = /[^\p{L}\p{N}\s_]/gu;
const DIGRAPHS: Array<[string, string]> = [
	["ου", "u"],
	["ντ", "d"],
	["μπ", "b"],
	["γκ", "g"],
	["γγ", "g"],
	["τσ", "ts"],
	["τζ", "tz"],
	["αυ", "av"],
	["ευ", "ev"],
	["αι", "e"],
	["ει", "i"],
	["οι", "i"],
	["υι", "i"],
];
const GREEK = "αβγδεζηθικλμνξοπρστυφχψω";
const LATIN = "a v g d e z i th i k l m n x o p r s t i f h ps o".split(" ");
// An accent or a diaeresis on the second vowel means it is not a digraph.
const SPLIT_PAIRS: Array<[string, string]> = [
	["άι", "ai"],
	["άϊ", "ai"],
	["αϊ", "ai"],
	["αΐ", "ai"],
	["όι", "oi"],
	["όϊ", "oi"],
	["οϊ", "oi"],
	["οΐ", "oi"],
	["έι", "ei"],
	["έϊ", "ei"],
	["εϊ", "ei"],
	["εΐ", "ei"],
	["όυ", "ou"],
	["οϋ", "ou"],
	["άυ", "au"],
	["αϋ", "au"],
];

const stripAccents = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "");

/** Without accents, punctuation or case. */
function plain(word: string): string {
	return stripAccents(word.toLowerCase().replace(PUNCTUATION, "")).replace(/ς/g, "σ").trim();
}

/** A rough sound-alike spelling, so that a Greek word and a Latin one meet in one alphabet. */
export function soundOf(word: string): string {
	let w = word.toLowerCase().replace(PUNCTUATION, "");
	for (const [a, b] of SPLIT_PAIRS) w = w.split(a).join(b);
	w = stripAccents(w).replace(/ς/g, "σ");
	for (const [a, b] of DIGRAPHS) w = w.split(a).join(b);
	return Array.from(w, (c) => {
		const at = GREEK.indexOf(c);
		return at >= 0 ? LATIN[at] : c;
	}).join("");
}

/** The longest common run first, then the same on each side of it (Python's `difflib`). */
function matchingRuns<T>(a: ArrayLike<T>, b: ArrayLike<T>): number[] {
	const runs: number[] = [];
	const walk = (aFrom: number, aTo: number, bFrom: number, bTo: number) => {
		let best = 0;
		let bestA = aFrom;
		let bestB = bFrom;
		let previous = new Int32Array(bTo - bFrom + 1);
		for (let i = aFrom; i < aTo; i += 1) {
			const row = new Int32Array(bTo - bFrom + 1);
			for (let j = bFrom; j < bTo; j += 1) {
				if (a[i] !== b[j]) continue;
				const length = previous[j - bFrom] + 1;
				row[j - bFrom + 1] = length;
				if (length > best) {
					best = length;
					bestA = i - length + 1;
					bestB = j - length + 1;
				}
			}
			previous = row;
		}
		if (best === 0) return;
		runs.push(best);
		walk(aFrom, bestA, bFrom, bestB);
		walk(bestA + best, aTo, bestB + best, bTo);
	};
	walk(0, a.length, 0, b.length);
	return runs;
}

function ratio(a: string, b: string): number {
	if (a.length + b.length === 0) return 0;
	const same = matchingRuns(a, b).reduce((sum, run) => sum + run, 0);
	return (2 * same) / (a.length + b.length);
}

/** Best of a spelling comparison and a sound one. */
function similar(a: string[], b: string[]): number {
	const spelt = [a.map(plain).join(" "), b.map(plain).join(" ")];
	if (!spelt[0] || !spelt[1]) return 0;
	return Math.max(
		ratio(spelt[0], spelt[1]),
		ratio(a.map(soundOf).join(" "), b.map(soundOf).join(" ")),
	);
}

/** The longest run of `a` that comes back, in order and by sound, inside `b`, as a share of `a`. */
function echo(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	const runs = matchingRuns(a.map(soundOf), b.map(soundOf));
	return Math.max(0, ...runs) / a.length;
}

/** Whisper writes a trailing "..." when someone stops mid-phrase: the opposite of finished. */
function endsASentence(spoken: string): boolean {
	const text = spoken.trimEnd();
	if (text.endsWith("...") || text.endsWith("…")) return false;
	return /[.;!?]$/.test(text);
}

/** The piece a word landed in, or the nearest one. */
function pieceOf(pieces: Span[], at: number): number {
	let best = 0;
	let gap = Number.POSITIVE_INFINITY;
	for (let i = 0; i < pieces.length; i += 1) {
		if (pieces[i].start <= at && at < pieces[i].end) return i;
		const d = at < pieces[i].start ? pieces[i].start - at : at - pieces[i].end;
		if (d < gap) {
			best = i;
			gap = d;
		}
	}
	return best;
}

/**
 * Why each piece should go, or null to keep it. False starts: short, unfinished, and said again
 * straight after. Retakes: the whole line said again. Run-ups: most of the line comes back, fuller,
 * in the next two. Asides: a short word between a take and the one that replaces it. Pieces holding
 * only a filler. A long piece with no words stays: losing speech is worse than keeping a noise.
 */
export function spotBadPieces(pieces: Span[], words: SpokenWord[]): Array<string | null> {
	const held: SpokenWord[][] = pieces.map(() => []);
	if (pieces.length > 0) {
		for (const word of words) held[pieceOf(pieces, word.start)].push(word);
	}
	const data = pieces.map((piece, index) => {
		const mine = held[index];
		const said = mine.map((w) => w.text);
		const spoken = said.join(" ").replace(/\s+/g, " ").trim();
		return {
			said,
			spoken,
			seconds: piece.end - piece.start,
			ends: endsASentence(spoken),
		};
	});
	const why: Array<string | null> = data.map((d) =>
		FILLERS.has(plain(d.spoken)) ? "filler" : null,
	);
	const replacedBy = new Map<number, number>();

	data.forEach((d, i) => {
		if (why[i]) return;
		if (d.said.length === 0 && d.seconds < YAPPING.tooShortSec) {
			why[i] = "too short";
			return;
		}
		if (d.said.length / d.seconds > YAPPING.fastestWordsPerSec) {
			why[i] = "made up";
			return;
		}
		if (d.seconds > YAPPING.falseStartSec || d.ends || d.said.length === 0) return;
		for (const j of [i + 1, i + 2]) {
			const later = data[j];
			if (!later?.said.length) continue;
			if (similar(d.said, later.said.slice(0, d.said.length)) >= YAPPING.repeatFloor) {
				why[i] = "false start";
				replacedBy.set(i, j);
				return;
			}
		}
	});
	data.forEach((d, i) => {
		if (why[i] || d.said.length < YAPPING.retakeMinWords) return;
		for (let j = i + 1; j <= i + YAPPING.retakeReach; j += 1) {
			const later = data[j];
			if (later?.said.length && similar(d.said, later.said) >= YAPPING.repeatFloor) {
				why[i] = "retake";
				replacedBy.set(i, j);
				return;
			}
		}
	});
	data.forEach((d, i) => {
		if (why[i] || d.said.length === 0) return;
		for (const j of [i + 1, i + 2]) {
			const later = data[j];
			if (!later?.said.length || later.seconds <= d.seconds) continue;
			if (echo(d.said, later.said) >= YAPPING.runUpShare) {
				why[i] = "run-up";
				replacedBy.set(i, j);
				return;
			}
		}
	});
	replacedBy.forEach((j, i) => {
		for (let k = i + 1; k < j; k += 1) {
			if (!why[k] && data[k].seconds <= YAPPING.falseStartSec) why[k] = "aside";
		}
	});
	return why;
}

// ── Zooms ───────────────────────────────────────────────────────────────────

export interface PlannedZoom extends Span {
	scale: number;
	motion: ZoomMotion;
}

/** How loud a stretch is, in dB: the mean over its voiced part, so a pause inside does not count. */
export function spanLoudness(levelsDb: ArrayLike<number>, span: Span): number {
	const from = Math.max(0, Math.floor(span.start * LEVELS_PER_SEC));
	const to = Math.min(levelsDb.length, Math.ceil(span.end * LEVELS_PER_SEC));
	const threshold = percentile(levelsDb, 0.95) - YAPPING.belowSpeechDb;
	let sum = 0;
	let count = 0;
	for (let i = from; i < to; i += 1) {
		if (levelsDb[i] >= threshold) {
			sum += levelsDb[i];
			count += 1;
		}
	}
	return count > 0 ? sum / count : Number.NEGATIVE_INFINITY;
}

/**
 * The zooms of a kept edit. A long cut sits at full frame and drifts slowly, in then out then in. A
 * short one punches in to a level other than the last one's. The short cuts spoken loudest over the
 * clip's usual speech go up and back at their middle instead, at most one in four and never side by
 * side. Repeatable: the same take gets the same zooms.
 */
export function planZooms(pieces: Span[], loudness: number[]): PlannedZoom[] {
	const voiced = loudness.filter(Number.isFinite);
	const usual = voiced.length > 0 ? voiced.reduce((a, b) => a + b, 0) / voiced.length : 0;
	const isShort = (p: Span) => p.end - p.start < YAPPING.longCutSec;
	const quota = Math.floor(pieces.filter(isShort).length / 4);
	const emphasised = new Set<number>();
	const byLoudness = pieces
		.map((_, index) => index)
		.filter(
			(i) =>
				isShort(pieces[i]) &&
				pieces[i].end - pieces[i].start >= YAPPING.minEmphasisSec &&
				loudness[i] >= usual + YAPPING.emphasisDb,
		)
		.sort((a, b) => loudness[b] - loudness[a]);
	for (const i of byLoudness) {
		if (emphasised.size >= quota) break;
		if (!emphasised.has(i - 1) && !emphasised.has(i + 1)) emphasised.add(i);
	}

	const zooms: PlannedZoom[] = [];
	let goingIn = true;
	let previous: number = YAPPING.zooms[0];
	let seed = 7;
	pieces.forEach((piece, i) => {
		if (!isShort(piece)) {
			const motion = goingIn ? "in" : "out";
			zooms.push({ ...piece, scale: YAPPING.slowZoom, motion });
			goingIn = !goingIn;
			previous = YAPPING.zooms[0];
			return;
		}
		if (emphasised.has(i)) {
			zooms.push({ ...piece, scale: YAPPING.emphasisZoom, motion: "emphasis" });
			previous = YAPPING.zooms[0];
			return;
		}
		const others = YAPPING.zooms.filter((scale) => scale !== previous);
		seed = (seed * 1103515245 + 12345) % 2147483648;
		// The high bits: the low ones of this generator only alternate.
		const scale = others[Math.floor(seed / 65536) % others.length];
		if (scale > 1) zooms.push({ ...piece, scale, motion: "hold" });
		previous = scale;
	});
	return zooms;
}

/**
 * Where a zoom of `scale` centres its view: one point stays put at every level, chosen so that the
 * eyes sit on the eye line at the strongest zoom. With no face, the zoom is centred.
 */
export function focusForZoom(
	face: { x: number; y: number } | null,
	scale: number,
	/** The axis a filled format cuts: along it the focus is where the window goes, so the face. */
	cover: "x" | "y" | null = null,
): { cx: number; cy: number } {
	if (!face || scale <= 1) return { cx: 0.5, cy: 0.5 };
	const top = Math.max(...YAPPING.zooms);
	const anchorY = (top * face.y - YAPPING.eyeLine) / (top - 1);
	const centre = (anchor: number) => {
		const half = 0.5 / scale;
		return Math.min(1 - half, Math.max(half, anchor + (0.5 - anchor) / scale));
	};
	return {
		cx: cover === "x" ? face.x : centre(face.x),
		cy: cover === "y" ? face.y : centre(anchorY),
	};
}

/** Which axis filling a frame cuts from a picture of this shape, if any. */
export function coverAxis(sourceAspect: number, frameAspect: number): "x" | "y" | null {
	if (sourceAspect > frameAspect * 1.01) return "x";
	return sourceAspect < frameAspect / 1.01 ? "y" : null;
}

/** The face of the take the playhead is on. */
export function faceUnderPlayhead(
	document: {
		assets: { id: string; face?: { x: number; y: number; h?: number } | null }[];
		timeline: { clips: { assetId: string; timelineStartSec: number; timelineEndSec: number }[] };
	},
	sec: number,
): { x: number; y: number; h?: number } | null {
	const clip = document.timeline.clips.find(
		(c) => c.timelineStartSec <= sec && sec < c.timelineEndSec,
	);
	return document.assets.find((asset) => asset.id === clip?.assetId)?.face ?? null;
}

// ── One recording ───────────────────────────────────────────────────────────

export interface YappingPlan {
	/** Source seconds to cut, within the given windows. */
	cuts: Span[];
	zooms: PlannedZoom[];
	stats: { cutSec: number; badPieces: number; pieces: number };
}

/** A span minus the spans taken out of it. */
export function subtractSpans(span: Span, removed: Span[]): Span[] {
	let kept = [span];
	for (const cut of removed) {
		kept = kept.flatMap((piece) => {
			if (cut.end <= piece.start || cut.start >= piece.end) return [piece];
			const parts: Span[] = [];
			if (cut.start > piece.start) parts.push({ start: piece.start, end: cut.start });
			if (cut.end < piece.end) parts.push({ start: cut.end, end: piece.end });
			return parts;
		});
	}
	return kept;
}

/** The stretches of speech inside what the timeline plays. Each is heard and judged on its own. */
export function piecesIn(levelsDb: ArrayLike<number>, windows: Span[]): Span[] {
	const sorted = [...windows].sort((a, b) => a.start - b.start);
	return speechPieces(levelsDb).flatMap((piece) =>
		sorted.flatMap((w) => {
			const start = Math.max(piece.start, w.start);
			const end = Math.min(piece.end, w.end);
			return end > start ? [{ start, end }] : [];
		}),
	);
}

/** `windows` is what the timeline plays of this recording; nothing outside them is touched. */
export function planYapping(params: {
	levelsDb: ArrayLike<number>;
	words: SpokenWord[];
	windows: Span[];
	/** False for a recording with no talking head in its picture: cut it, but do not zoom it. */
	zoom: boolean;
}): YappingPlan {
	const { levelsDb, words, windows, zoom } = params;
	const sorted = [...windows].sort((a, b) => a.start - b.start);
	const inWindows = piecesIn(levelsDb, sorted);
	const why = spotBadPieces(inWindows, words);
	const kept = inWindows.filter((_, i) => !why[i]);

	const cuts: Span[] = [];
	for (const w of sorted) {
		let cursor = w.start;
		for (const piece of kept) {
			if (piece.end <= w.start || piece.start >= w.end) continue;
			if (piece.start > cursor) cuts.push({ start: cursor, end: piece.start });
			cursor = Math.max(cursor, piece.end);
		}
		if (cursor < w.end) cuts.push({ start: cursor, end: w.end });
	}
	return {
		cuts,
		zooms: zoom
			? planZooms(
					kept,
					kept.map((piece) => spanLoudness(levelsDb, piece)),
				)
			: [],
		stats: {
			cutSec: cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0),
			badPieces: why.filter(Boolean).length,
			pieces: kept.length,
		},
	};
}
