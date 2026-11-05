// Smart cuts: cut the dead time of a screen recording and speed up the parts where something is
// done but nothing is said. Pure: it reads spans and returns spans; no DOM, no IPC.
//
// Every stretch of the recording is one of three things:
//   speaking  somebody talks (the transcript): kept as it is, with a little pad around it;
//   doing     nothing is said, but the pointer moves or clicks, a shortcut is pressed or the picture
//             changes: kept, but played faster;
//   idle      nothing is said, the pointer rests and the picture does not change: cut.
// A short idle stretch is left alone (a pause is part of talking), and the cut keeps a short pad
// of the pause at each end so the edit does not clip words or jump.

export interface Span {
	start: number;
	end: number;
}

export interface SmartCutOptions {
	/** An idle stretch has to be at least this long (s) to be cut at all. */
	minCutSec: number;
	/** Of an idle stretch, this much (s) is kept at each end. */
	keepPadSec: number;
	/** Speech is protected this much (s) before and after. */
	speechPadSec: number;
	/** A doing stretch has to be at least this long (s) to be sped up. */
	minSpeedSec: number;
	/** Playback speed of a doing stretch. */
	speed: number;
	/** Spans closer than this (s) are one. */
	mergeGapSec: number;
}

export const DEFAULT_SMART_CUT_OPTIONS: SmartCutOptions = {
	minCutSec: 1.2,
	keepPadSec: 0.25,
	speechPadSec: 0.3,
	minSpeedSec: 1.5,
	speed: 4,
	mergeGapSec: 0.5,
};

const STEP = 0.05;

/** Sorted, overlapping or nearly touching spans joined. */
export function mergeSpans(spans: Span[], gap = 0): Span[] {
	const sorted = spans
		.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
		.map((s) => ({ ...s }))
		.sort((a, b) => a.start - b.start);
	const out: Span[] = [];
	for (const span of sorted) {
		const last = out[out.length - 1];
		if (last && span.start - last.end <= gap) last.end = Math.max(last.end, span.end);
		else out.push(span);
	}
	return out;
}

/** The spans where the pointer moves or clicks, or a key is pressed, each padded a little. */
export function pointerActivity(
	samples: Array<{ timeMs: number; cx: number; cy: number; interactionType?: string }>,
	keys: Array<{ timeMs: number }> = [],
	options: { moveThreshold?: number; padSec?: number } = {},
): Span[] {
	const threshold = options.moveThreshold ?? 0.004;
	const pad = options.padSec ?? 0.4;
	const spans: Span[] = [];
	for (let i = 1; i < samples.length; i++) {
		const a = samples[i - 1];
		const b = samples[i];
		const moved = Math.hypot(b.cx - a.cx, b.cy - a.cy) > threshold;
		const clicked = b.interactionType === "click";
		if (moved || clicked) spans.push({ start: b.timeMs / 1000 - pad, end: b.timeMs / 1000 + pad });
	}
	for (const key of keys)
		spans.push({ start: key.timeMs / 1000 - pad, end: key.timeMs / 1000 + pad });
	return mergeSpans(spans, 0.2);
}

/** The spans where the picture changes: everything outside the frozen ones. */
export function changingPicture(frozen: Span[], durationSec: number): Span[] {
	const out: Span[] = [];
	let cursor = 0;
	for (const f of mergeSpans(frozen, 0.6)) {
		if (f.start > cursor) out.push({ start: cursor, end: f.start });
		cursor = Math.max(cursor, f.end);
	}
	if (cursor < durationSec) out.push({ start: cursor, end: durationSec });
	return out;
}

export interface SmartCutPlan {
	/** Source seconds to cut. */
	cuts: Span[];
	/** Source seconds to play faster. */
	speeds: Array<Span & { speed: number }>;
	stats: { cutSec: number; speedSec: number; keptSec: number };
}

type Kind = 0 | 1 | 2; // idle, doing, speaking

export function planSmartCuts(params: {
	durationSec: number;
	speech: Span[];
	/** Where the pointer or the keyboard is busy. */
	pointer: Span[];
	/** Where the picture changes. Null when it could not be measured: only the pointer then counts. */
	picture: Span[] | null;
	options?: Partial<SmartCutOptions>;
}): SmartCutPlan {
	const o = { ...DEFAULT_SMART_CUT_OPTIONS, ...params.options };
	const total = Math.max(0, params.durationSec);
	const n = Math.ceil(total / STEP);
	const kind: Kind[] = new Array(n).fill(0);
	const mark = (spans: Span[], value: Kind, pad = 0) => {
		for (const s of spans) {
			const from = Math.max(0, Math.floor((s.start - pad) / STEP));
			const to = Math.min(n, Math.ceil((s.end + pad) / STEP));
			for (let i = from; i < to; i++) if (kind[i] < value) kind[i] = value;
		}
	};
	mark(params.picture ?? [], 1);
	mark(params.pointer, 1);
	mark(mergeSpans(params.speech, o.mergeGapSec), 2, o.speechPadSec);

	const cuts: Span[] = [];
	const speeds: Array<Span & { speed: number }> = [];
	let i = 0;
	while (i < n) {
		let j = i;
		while (j < n && kind[j] === kind[i]) j++;
		const start = i * STEP;
		const end = Math.min(total, j * STEP);
		const length = end - start;
		if (kind[i] === 0 && length >= o.minCutSec) {
			const from = start === 0 ? 0 : start + o.keepPadSec;
			const to = end >= total ? total : end - o.keepPadSec;
			if (to - from >= 0.3) cuts.push({ start: from, end: to });
		} else if (kind[i] === 1 && length >= o.minSpeedSec) {
			speeds.push({ start, end, speed: o.speed });
		}
		i = j;
	}
	const cutSec = cuts.reduce((sum, c) => sum + (c.end - c.start), 0);
	const speedSec = speeds.reduce((sum, c) => sum + (c.end - c.start), 0);
	return { cuts, speeds, stats: { cutSec, speedSec, keptSec: total - cutSec } };
}
