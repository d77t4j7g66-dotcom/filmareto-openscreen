// Caption cues, derived from the transcript.
//
// Captions are a *view* over `document.transcripts` — nothing here is stored.
// The transcript owns the words and their timings (source time, per asset); the
// clips decide which of those survive and where they land on the ruler; the
// caption settings decide how many words share a line. Change any of the three
// and the cues follow on the next render, with no regeneration step and no
// stale copy to reconcile.
//
// Two coordinate systems meet here:
//   - transcript words / segments: SOURCE seconds, per asset.
//   - cues:                        VIRTUAL (timeline) ms, what the preview uses.
// The export path takes the same virtual cues and projects them back to source
// through `projectRegionsToSourceTime`, exactly like annotations, so preview and
// export cannot drift apart.

import type { AnnotationRegion } from "@/components/video-editor/types";
import {
	dedupeAdjacentCaptionRepeats,
	finalizeCaptionSegmentsForPlayback,
	groupTimedCaptionWordsIntoLines,
	isLittleCaptionWord,
	splitMergedCaptionsByWordBounds,
} from "@/lib/captioning/annotationsFromCaptions";
import type { CaptionSegment } from "@/lib/captioning/transcribe";
import type { AxcutDocument, AxcutTranscript } from "../schema";
import {
	lanePlacements,
	placementRawSec,
	type TranscriptPlacement,
} from "../timeline/aggregated-transcript";
import { removedRawSpans } from "../timeline/programme-time";
import type { CaptionPlace } from "./faceSafe";
import { getCaptionInsights, insightKey } from "./insights";
import {
	type CaptionAnchorV,
	type CaptionFx,
	type CaptionSettings,
	captionBackgroundCss,
	captionBoxRect,
	captionShown,
	captionUsesWordTimes,
	resolveCaptionLane,
} from "./settings";
import { type CaptionTranslations, captionTranslationUnits } from "./translations";

/** One on-screen caption line, in whichever time base the producer documented. */
export interface CaptionCue {
	id: string;
	startMs: number;
	endMs: number;
	text: string;
	/** Each word, on the ruler. Only for a look that needs them (`captionUsesWordTimes`). */
	words?: Array<{ text: string; startMs: number; endMs: number; key?: boolean }>;
	/** The emoji Claude gave this phrase. */
	emoji?: string;
}

/** Captions draw above every user annotation so a blur or a sticker can't bury
 *  the subtitle. Well clear of the annotation z-range, which counts up from 1. */
export const CAPTION_Z_INDEX_BASE = 100_000;

/** A gap this short is a breath: the caption stays instead of blinking off and on. */
const CAPTION_BREATH_MS = 500;

function toCaptionSegments(transcript: AxcutTranscript): CaptionSegment[] {
	return transcript.words
		.filter((word) => word.text.trim().length > 0)
		.map((word) => ({ startSec: word.startSec, endSec: word.endSec, text: word.text }));
}

function segmentWordsAsCaptionSegments(
	transcript: AxcutTranscript,
	segmentId: string,
): CaptionSegment[] {
	const segment = transcript.segments.find((s) => s.id === segmentId);
	if (!segment) return [];
	const byId = new Map(transcript.words.map((w) => [w.id, w]));
	return segment.wordIds
		.map((id) => byId.get(id))
		.filter((w): w is NonNullable<typeof w> => w !== undefined && w.text.trim().length > 0)
		.map((w) => ({ startSec: w.startSec, endSec: w.endSec, text: w.text }));
}

/**
 * Spread a piece of text across a span as one entry per word, timed by character
 * weight. This is how translated text gets timings: a translation has its own
 * word count and word order, so the source's per-word timestamps cannot carry
 * over — but the span it was spoken in can, and does.
 */
function textAsPseudoWords(startSec: number, endSec: number, text: string): CaptionSegment[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	return splitMergedCaptionsByWordBounds([{ startSec, endSec, text: trimmed }], 1, 1);
}

/**
 * One asset's caption lines in SOURCE seconds.
 *
 * Both languages go through the SAME final step — a stream of timed single words
 * fed to `groupTimedCaptionWordsIntoLines`. That is the whole point: line layout
 * (words per line, breaking on real pauses) must not depend on which language is
 * showing. Only where the words come from differs:
 *
 *   - original:   the transcript's own word timestamps.
 *   - translated: each translation unit's text spread across the unit's span,
 *                 falling back to the original words for units not translated
 *                 yet, so a partial translation still plays.
 *
 * Grouping into units before translating also matters upstream: a Whisper
 * transcript stores one segment per word, so translating per segment would have
 * translated word by word.
 */
export function captionLinesForAsset(
	transcript: AxcutTranscript,
	settings: CaptionSettings,
	translations: CaptionTranslations,
): CaptionSegment[] {
	const minWords = settings.minWordsPerLine;
	const maxWords = settings.maxWordsPerLine;
	const stream = captionWordStream(transcript, settings, translations);

	// Whisper repeats a phrase across chunk boundaries often enough that raw lines
	// would stutter on screen; the dedupe + overlap trim are the same pass the old
	// caption generator ran before writing annotations, kept because the artefact
	// is in the transcript, not in how it used to be stored.
	const polish = (lines: CaptionSegment[]) =>
		finalizeCaptionSegmentsForPlayback(dedupeAdjacentCaptionRepeats(lines));

	if (stream.length === 0) return [];
	return polish(groupTimedCaptionWordsIntoLines(stream, minWords, maxWords));
}

function captionWordStream(
	transcript: AxcutTranscript,
	settings: CaptionSettings,
	translations: CaptionTranslations,
): CaptionSegment[] {
	return settings.language === null
		? originalWordStream(transcript)
		: translatedWordStream(transcript, translations, settings.language);
}

/**
 * A caption line's words with their times. The transcript's own when they match the line one for
 * one, spread by length when a pass before this one merged or trimmed some.
 */
function timedWordsOfLine(line: CaptionSegment, stream: CaptionSegment[]): CaptionSegment[] {
	const tokens = line.text.trim().split(/\s+/).filter(Boolean);
	const heard = stream.filter(
		(word) =>
			word.text.trim() && word.startSec >= line.startSec - 0.02 && word.startSec < line.endSec,
	);
	if (heard.length === tokens.length) {
		return heard.map((word, i) => ({
			startSec: word.startSec,
			endSec: word.endSec,
			text: tokens[i],
		}));
	}
	const letters = tokens.reduce((sum, token) => sum + token.length, 0) || 1;
	let at = line.startSec;
	return tokens.map((text) => {
		const startSec = at;
		at += ((line.endSec - line.startSec) * text.length) / letters;
		return { startSec, endSec: at, text };
	});
}

function originalWordStream(transcript: AxcutTranscript): CaptionSegment[] {
	const words = toCaptionSegments(transcript);
	if (words.length > 0) return words;
	// A transcript with segments but no words (hand-authored / imported) still
	// deserves captions — spread each segment's own text across its span.
	return transcript.segments.flatMap((s) => textAsPseudoWords(s.startSec, s.endSec, s.text));
}

function translatedWordStream(
	transcript: AxcutTranscript,
	translations: CaptionTranslations,
	language: string,
): CaptionSegment[] {
	const translated = translations[language]?.byAsset[transcript.assetId] ?? {};
	return captionTranslationUnits(transcript).flatMap((unit) => {
		const replacement = translated[unit.id];
		if (typeof replacement === "string" && replacement.trim()) {
			return textAsPseudoWords(unit.startSec, unit.endSec, replacement);
		}
		// Not translated yet — keep the original words, with their real timings.
		const originals = unit.segmentIds.flatMap((id) =>
			segmentWordsAsCaptionSegments(transcript, id),
		);
		return originals.length > 0
			? originals
			: textAsPseudoWords(unit.startSec, unit.endSec, unit.text);
	});
}

/**
 * Map a source-time span onto the ruler through the clips that play it.
 *
 * The inverse of `virtualSpanToSourceSpans` (region-ventilation): a line whose
 * source range is split across two clips — or played twice by a duplicated clip —
 * yields one timeline span per covering clip, so the caption appears wherever
 * its audio actually plays and nowhere else. A span no clip plays yields [].
 */
export function sourceSpanToTimelineSpans(
	assetId: string,
	startSec: number,
	endSec: number,
	/** Clips, or a voiceover lane's placements — this reads only `assetId`, the source
	 *  window and the ruler head, which both providers carry (issue #560). `AxcutClip`
	 *  stays structurally assignable, so every existing caller is unaffected. */
	clips: TranscriptPlacement[],
): Array<{ startSec: number; endSec: number }> {
	const out: Array<{ startSec: number; endSec: number }> = [];
	for (const clip of clips) {
		if (clip.assetId !== assetId) continue;
		const clipSourceEnd = clip.sourceEndSec ?? Number.POSITIVE_INFINITY;
		const s = Math.max(startSec, clip.sourceStartSec);
		const e = Math.min(endSec, clipSourceEnd);
		if (e <= s) continue;
		// Through `placementRawSec`, never the subtraction it used to write here: a clip
		// carrying an added word plays its media in pieces, and the seconds after the
		// insertion sit further along the ruler than their distance from the clip's start.
		// Writing the short version here is what put every caption after an insertion early.
		out.push({ startSec: placementRawSec(clip, s), endSec: placementRawSec(clip, e) });
	}
	// Onto the ruler the viewer actually sees. Expanding BOTH ends does the whole job:
	return out;
}

/**
 * Every caption cue for the document, in VIRTUAL (timeline) ms.
 *
 * Returns [] when the layer is off — the caller doesn't need to check twice, and
 * "hidden" costs nothing to render.
 */
export function deriveCaptionCues(
	document: AxcutDocument | null | undefined,
	settings: CaptionSettings,
	translations: CaptionTranslations,
): CaptionCue[] {
	if (!document || !settings.enabled) return [];
	// The lane the captions are read FROM — resolved, so a stored "voiceover" whose last
	// pill has been deleted falls back here rather than exporting nothing (issue #560).
	const placements = lanePlacements(
		resolveCaptionLane(document, settings),
		document.timeline.clips,
		// `?? []` because the key is additive: a document written before it — or hand-built,
		// never through the schema — simply has none.
		document.audioTracks ?? [],
		removedRawSpans(document.timeline.clips, document.timeline.trimRanges),
	);
	if (placements.length === 0) return [];

	const transcripts = new Map(document.transcripts.map((t) => [t.assetId, t]));
	// What the film no longer contains is CLIPS-derived on both lanes, deliberately: a cut
	// is authored on the film, and a take laid over it is silent through it without its own
	// span saying so. Asking the placements instead would measure the cut against the take.
	// A transcript is only projected once per asset even when several clips draw
	// from it (line grouping is the expensive part, clipping is cheap).
	const linesByAsset = new Map<string, CaptionSegment[]>();
	const cues: CaptionCue[] = [];
	let n = 0;
	const needsWords = captionUsesWordTimes(settings);
	// Claude read the words as they were spoken: a translation has other words, in another order.
	const insights = settings.language === null ? getCaptionInsights(document) : {};

	for (const assetId of new Set(placements.map((c) => c.assetId))) {
		const transcript = transcripts.get(assetId);
		if (!transcript) continue;
		linesByAsset.set(assetId, captionLinesForAsset(transcript, settings, translations));
	}

	for (const [assetId, lines] of linesByAsset) {
		const transcript = transcripts.get(assetId);
		const needsTimes = needsWords || settings.emoji;
		const stream =
			needsTimes && transcript ? captionWordStream(transcript, settings, translations) : [];
		const read = insights[assetId];
		for (const line of lines) {
			const text = line.text.trim();
			if (!text) continue;
			const timed = needsTimes ? timedWordsOfLine(line, stream) : [];
			const keys = new Set(read?.keys ?? []);
			const emoji = settings.emoji
				? timed.map((word) => read?.emoji[insightKey(word.startSec)]).find(Boolean)
				: undefined;
			for (const span of sourceSpanToTimelineSpans(
				assetId,
				line.startSec,
				line.endSec,
				placements,
			)) {
				const startMs = Math.round(span.startSec * 1000);
				const endMs = Math.max(Math.round(span.endSec * 1000), startMs + 1);
				const words = timed.flatMap((word) => {
					const onThisSpan = sourceSpanToTimelineSpans(
						assetId,
						word.startSec,
						word.endSec,
						placements,
					).find((piece) => piece.startSec < span.endSec && piece.endSec > span.startSec);
					return onThisSpan
						? [
								{
									text: word.text,
									startMs: Math.round(onThisSpan.startSec * 1000),
									endMs: Math.round(onThisSpan.endSec * 1000),
									...(keys.has(insightKey(word.startSec)) ? { key: true } : {}),
								},
							]
						: [];
				});
				cues.push({
					id: `caption-${n++}`,
					startMs,
					endMs,
					text,
					...(needsWords ? { words } : {}),
					...(emoji ? { emoji } : {}),
				});
			}
		}
	}

	// No removed-word filter. A cue inside a cut maps to source time inside frames
	// `resolvePlaybackSegments` never emits, so it is already invisible in the preview and
	// the export; dropping the words instead would re-flow every line boundary on any
	// project with a trim — a visible change to output, bought for nothing.
	cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	// Lines from one asset can't overlap, but two clips playing overlapping
	// source ranges can put two cues on the same instant. Keep the ruler honest
	// by ending the earlier one where the later begins.
	for (let i = 1; i < cues.length; i++) {
		const prev = cues[i - 1];
		const cur = cues[i];
		if (prev.endMs > cur.startMs) prev.endMs = Math.max(prev.startMs + 1, cur.startMs);
		else if (cur.startMs - prev.endMs < CAPTION_BREATH_MS) prev.endMs = cur.startMs;
	}
	return cues;
}

/** The cue playing at `timeMs`, or null. Ties go to the one that started later,
 *  which is what "the next line has taken over" looks like. */
export function captionCueAt(cues: CaptionCue[], timeMs: number): CaptionCue | null {
	let found: CaptionCue | null = null;
	for (const cue of cues) {
		if (timeMs >= cue.startMs && timeMs < cue.endMs) found = cue;
		else if (cue.startMs > timeMs) break;
	}
	return found;
}

/**
 * A caption's region, which is an `AnnotationRegion` measured against a different box.
 *
 * The `space` marker is why this type exists instead of a field on `AnnotationRegion`:
 * an annotation is authored on top of the visible video and must keep tracking the
 * screen rect, while a caption belongs to the output frame. Widening the shared type
 * would also put a frame-space band — whose `y` legitimately goes negative when it
 * overhangs the frame edge — through `annotationRegionSchema`, which bounds position
 * to 0..100. Captions are never stored, so they never meet that schema.
 */
export type CaptionTextRegion = AnnotationRegion & {
	space: "frame";
	/** Which edge of the drawn block the compositor pins to the region's box. Carried
	 *  here rather than on `AnnotationTextStyle` for the same reason as `space`: an
	 *  annotation must keep rendering centred, and widening the shared style would put
	 *  the key in every stored annotation's payload. */
	verticalAlign: CaptionAnchorV;
	/** What a part of the text does differently: the word being said, the accent word. */
	runs?: CaptionTextRun[];
	stroke?: { color: string; em: number };
	shadow?: { color: string; blurEm: number; yEm: number };
	fx?: CaptionFx;
};

/** A part of the text, in UTF-16 units as JS counts them. */
export interface CaptionTextRun {
	start: number;
	len: number;
	color?: string;
	pill?: string;
	fontFamily?: string;
	sizeMul?: number;
	italic?: boolean;
	glow?: string;
	/** Grows to `popPeak` for a moment, then stays at `popHold`. */
	popPeak?: number;
	popHold?: number;
	/** Not said yet: it keeps its place and does not show. */
	hide?: boolean;
	/** The pill arrives from here: `[start, len]` of the word before. */
	pillFrom?: [number, number];
}

/** The longest big word that fits at full size. */
const ACCENT_FITS_LETTERS = 11;

/** How wide a letter is, in font sizes. Only where a line breaks and when a long word shrinks. */
const LETTER_WIDTH: Record<string, number> = {
	"Open Sans Condensed": 0.44,
	"Open Sans Condensed ExtraBold": 0.46,
	"Geologica Black": 0.66,
	"LT Superior Black": 0.68,
	Oi: 0.86,
	"Syne ExtraBold": 0.72,
	"LT Remark Black Italic": 0.56,
	"LT Remark Italic": 0.46,
	"Pixeloid Sans": 0.72,
};

/**
 * How wide a letter of this look is, in font sizes. A cautious guess: the rasterizer does the real
 * measuring, this only decides where a line breaks and when a long word comes down in size.
 */
function emPerLetter(settings: CaptionSettings): number {
	const letter = (LETTER_WIDTH[settings.fontFamily] ?? 0.58) + (settings.fx?.trackingEm ?? 0);
	return settings.textCase === "upper" ? letter * 1.12 : letter;
}

/** The break that leaves two lines closest in length, and not after a little word. */
function evenBreak(shown: string[]): number {
	const lettersIn = (words: string[]) => words.join(" ").length;
	const unevenness = (at: number) =>
		Math.abs(lettersIn(shown.slice(0, at)) - lettersIn(shown.slice(at))) +
		(isLittleCaptionWord(shown[at - 1]) ? 4 : 0);
	let best = 1;
	for (let at = 2; at < shown.length; at++) if (unevenness(at) < unevenness(best)) best = at;
	return best;
}

/** Whether this look changes at each word, and so has one region per word. */
function captionFollowsWords(settings: CaptionSettings): boolean {
	return (
		Boolean(settings.activeWordColor || settings.activeWordPill || settings.activeWordGlow) ||
		Boolean(settings.pastWordColor || settings.futureWordColor) ||
		settings.build ||
		settings.activeWordPop !== 1 ||
		settings.activeWordHold !== 1
	);
}

/** All captions that change at each word share one id, so they share one texture. */
const WORD_CAPTION_ID = "caption-words";

/** The words as one text, and where each landed in it. */
export function layOutCaptionWords(
	words: string[],
	settings: CaptionSettings,
	lettersAcross = Number.POSITIVE_INFINITY,
	/** The word Claude says matters, if it said. */
	keyWord: number | null = null,
): { content: string; ranges: Array<{ start: number; len: number }>; emphasized: number | null } {
	const shown = words.map((word) => captionShown(word, settings));
	const longest = shown.reduce(
		(best, word, i) => (word.length >= shown[best].length ? i : best),
		0,
	);
	// "με 3" has no word worth making big.
	const pick = keyWord ?? longest;
	const emphasized =
		settings.emphasis === "none" || (keyWord === null && isLittleCaptionWord(shown[pick]))
			? null
			: pick;
	const bigWord = settings.emphasis === "big-word" && emphasized !== null;
	const tooLong = shown.join(" ").length > lettersAcross;
	const breakAt =
		!bigWord && shown.length > 1 && (settings.twoLines || tooLong) ? evenBreak(shown) : null;
	// A thick outline and a word that grows both eat into a plain space: "TOPREMIERE".
	const wordGap =
		settings.strokeEm >= 0.04 || settings.activeWordHold > 1 || settings.activeWordPop > 1
			? "\u2002"
			: " ";
	let content = "";
	const ranges = shown.map((word, i) => {
		if (i > 0) {
			// The big word has a line of its own, with the words before and after it above and below.
			const ownLine = bigWord && (i === emphasized || i - 1 === emphasized);
			content += ownLine || i === breakAt ? "\n" : wordGap;
		}
		const start = content.length;
		content += word;
		return { start, len: word.length };
	});
	return { content, ranges, emphasized };
}

/**
 * Cues as text annotation regions, so the export renderer draws captions through
 * the exact same text path as annotations (wrapping, background plate,
 * alignment) instead of a second, subtly-different implementation.
 *
 * These regions are synthetic: they are never stored in the document and carry
 * no `annotationSource` marker, because they are not annotations.
 */
export function captionCuesToTextRegions(
	cues: CaptionCue[],
	settings: CaptionSettings,
	aspectValue: number,
	/** Where the face allows each phrase to sit: `captionFaceGuard`. */
	guard?:
		| ((startMs: number, endMs: number, insetY: number, blockPct: number) => CaptionPlace)
		| null,
): CaptionTextRegion[] {
	const usualRect = captionBoxRect(settings, aspectValue);
	let rect = usualRect;
	let shrink = 1;
	// In the same units as `fontSize`: pixels at a 1080-high frame.
	const columnWidth = (rect.width / 100) * aspectValue * 1080;
	const letterWidth = emPerLetter(settings);
	// A long word comes down in size instead of breaking in two.
	const sizeFor = (text: string) => {
		// Two even lines fit as lines: a title that wrapped to a third would climb up the chin.
		const parts = settings.twoLines ? text.split("\n") : text.split(/\s+/);
		const longest = Math.max(1, ...parts.map((part) => part.length));
		return Math.min(settings.fontSize, columnWidth / (longest * letterWidth)) * shrink;
	};
	/** The drawn block's height, % of the frame: a line per break, plus what its letters wrap to. */
	const blockPct = (content: string, accent: CaptionTextRun[]) => {
		let at = 0;
		let total = 0;
		for (const line of content.split("\n")) {
			const big = accent.find((run) => run.start >= at && run.start < at + line.length);
			const size = sizeFor(content) * (big?.sizeMul ?? 1);
			const across = Math.max(1, Math.ceil((line.length * letterWidth * size) / columnWidth));
			total += across * size * 1.22;
			at += line.length + 1;
		}
		return (total / 1080) * 100;
	};
	const placeFor = (cue: CaptionCue, content: string, accent: CaptionTextRun[]) => {
		shrink = 1;
		rect = usualRect;
		if (!guard) return;
		const place = guard(cue.startMs, cue.endMs, settings.insetY, blockPct(content, accent));
		shrink = place.scale;
		if (place.insetY !== settings.insetY) {
			rect = captionBoxRect({ ...settings, insetY: place.insetY }, aspectValue);
		}
	};
	const effects = {
		...(settings.strokeEm > 0
			? { stroke: { color: settings.strokeColor, em: settings.strokeEm } }
			: {}),
		...(settings.shadow
			? { shadow: { color: "rgba(0, 0, 0, 0.85)", blurEm: 0.2, yEm: 0.05 } }
			: {}),
		// Even empty: a look that follows words must draw every word the same way, or its shadow
		// changes softness between the first word and the second.
		...(settings.fx || captionFollowsWords(settings) ? { fx: settings.fx ?? {} } : {}),
	};
	const region = (
		id: string,
		startMs: number,
		endMs: number,
		content: string,
		zIndex: number,
		enter: boolean,
		runs: CaptionTextRun[] = [],
	): CaptionTextRegion => ({
		space: "frame" as const,
		// The edge the compositor pins the drawn block to inside `size`. Without it the
		// rasterizers centre the block — which is what made a caption drift vertically
		// every time its text wrapped to another line.
		verticalAlign: rect.verticalAlign,
		id,
		startMs,
		endMs,
		type: "text" as const,
		content,
		position: { x: rect.x, y: rect.y },
		size: { width: rect.width, height: rect.height },
		style: {
			color: settings.color,
			backgroundColor: captionBackgroundCss(settings),
			fontSize: sizeFor(content),
			fontFamily: settings.fontFamily,
			fontWeight: settings.fontWeight,
			fontStyle: "normal" as const,
			textDecoration: "none" as const,
			// One horizontal control, not two: `anchorH` picks which edge of the block is
			// pinned to the column, and the rasterizers' plate maths already snaps the
			// plate onto that edge (`text_linux.rs` `plate_x`, and its two mirrors).
			textAlign: settings.anchorH,
			// Not one of the stored animations: captions are never stored, and only the compositor
			// reads this name.
			textAnimation: (settings.pop && enter ? "word-pop" : "none") as "none",
		},
		zIndex,
		...(runs.length > 0 ? { runs } : {}),
		...effects,
	});

	/** The word being said, and what the others do around it. */
	const moment = (ranges: Array<{ start: number; len: number }>, i: number): CaptionTextRun[] =>
		ranges.flatMap((range, j): CaptionTextRun[] => {
			if (j > i) {
				if (settings.build) return [{ ...range, hide: true }];
				return settings.futureWordColor ? [{ ...range, color: settings.futureWordColor }] : [];
			}
			if (j < i) return settings.pastWordColor ? [{ ...range, color: settings.pastWordColor }] : [];
			const popping = settings.activeWordPop !== 1 || settings.activeWordHold !== 1;
			return [
				{
					...range,
					...(settings.activeWordColor ? { color: settings.activeWordColor } : {}),
					...(settings.activeWordPill ? { pill: settings.activeWordPill } : {}),
					...(settings.activeWordGlow ? { glow: settings.activeWordGlow } : {}),
					...(popping
						? {
								popPeak: settings.activeWordPop,
								// A long word grows by more than the gap beside it: hold it to a fixed reach.
								popHold: Math.min(settings.activeWordHold, 1 + 0.25 / (range.len * letterWidth)),
							}
						: {}),
					...(settings.pillSlides && settings.activeWordPill && i > 0
						? { pillFrom: [ranges[i - 1].start, ranges[i - 1].len] as [number, number] }
						: {}),
				},
			];
		});
	const follows = captionFollowsWords(settings);
	return cues.flatMap((cue, index) => {
		const zIndex = CAPTION_Z_INDEX_BASE + index;
		const words = cue.words ?? [];
		const withEmoji = (regions: CaptionTextRegion[]): CaptionTextRegion[] =>
			cue.emoji ? [...regions, emojiRegion(cue, settings, rect, zIndex)] : regions;
		if (words.length === 0 || !captionUsesWordTimes(settings)) {
			placeFor(cue, captionShown(cue.text, settings), []);
			return withEmoji([
				region(cue.id, cue.startMs, cue.endMs, captionShown(cue.text, settings), zIndex, true),
			]);
		}
		const keyWord = words.findIndex((word) => word.key);
		const { content, ranges, emphasized } = layOutCaptionWords(
			words.map((word) => word.text),
			settings,
			columnWidth / (settings.fontSize * letterWidth),
			keyWord >= 0 ? keyWord : null,
		);
		const accent: CaptionTextRun[] =
			emphasized === null
				? []
				: [
						settings.emphasis === "big-word"
							? {
									...ranges[emphasized],
									color: settings.emphasisColor,
									fontFamily: settings.emphasisFont,
									italic: settings.emphasisItalic,
									// A long word comes down to fit the frame instead of breaking in two.
									sizeMul: Math.min(
										settings.emphasisSize,
										(settings.emphasisSize * ACCENT_FITS_LETTERS) / ranges[emphasized].len,
									),
								}
							: {
									...ranges[emphasized],
									color: settings.emphasisColor,
									glow: settings.emphasisColor,
								},
					];
		placeFor(cue, content, accent);
		// The word Claude says matters keeps the look's colour for the whole phrase.
		const keyLit: CaptionTextRun[] =
			keyWord >= 0 && settings.emphasis === "none" && settings.activeWordColor
				? [{ ...ranges[keyWord], color: settings.activeWordColor }]
				: [];
		if (!follows) {
			return withEmoji([region(cue.id, cue.startMs, cue.endMs, content, zIndex, true, accent)]);
		}
		// One region per word said: the same text, with the next word lit.
		return withEmoji(
			words.map((_, i) => {
				const startMs = i === 0 ? cue.startMs : words[i].startMs;
				const nextMs = i === words.length - 1 ? cue.endMs : words[i + 1].startMs;
				return region(
					WORD_CAPTION_ID,
					startMs,
					Math.max(nextMs, startMs + 1),
					content,
					zIndex,
					i === 0,
					[...accent, ...keyLit, ...moment(ranges, i)],
				);
			}),
		);
	});
}

/** An emoji under the phrase, in a box of its own: the phrase's light and outline are not for it. */
function emojiRegion(
	cue: CaptionCue,
	settings: CaptionSettings,
	rect: ReturnType<typeof captionBoxRect>,
	zIndex: number,
): CaptionTextRegion {
	const height = (settings.fontSize * 1.8 * 100) / 1080;
	const below = rect.y + rect.height;
	return {
		space: "frame",
		verticalAlign: "top",
		id: `${cue.id}-emoji`,
		startMs: cue.startMs,
		endMs: cue.endMs,
		type: "text",
		content: cue.emoji ?? "",
		position: { x: rect.x, y: Math.min(below + 0.6, 100 - height) },
		size: { width: rect.width, height },
		style: {
			color: "#ffffff",
			backgroundColor: "transparent",
			fontSize: Math.min(settings.fontSize, 64),
			fontFamily: settings.fontFamily,
			fontWeight: "normal",
			fontStyle: "normal",
			textDecoration: "none",
			textAlign: "center",
			textAnimation: "word-pop" as "none",
		},
		zIndex: zIndex + 1,
	};
}
