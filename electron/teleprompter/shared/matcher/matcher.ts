import { hasDigit, normalizeWord, phoneticKey, type Token } from "../normalize";
import type { Hypothesis } from "../speechTypes";
import { similarity } from "./similarity";

export type MatcherParams = {
	/** How many recent recognised words are compared (K). */
	windowTokens: number;
	/** Two words match when their similarity reaches this value. */
	similarity: number;
	/** Matches needed before the cursor moves. */
	minMatches: number;
	/** Consecutive words matching a sentence's start that declare a retake (fewer only for a shorter sentence). */
	retakeMatches: number;
	/** Shortest sentence that can be retaken by voice. */
	retakeMinWords: number;
	/** Seconds without new heard words, after the last word of the script, before the stage ends. */
	endSilenceSec: number;
	/** Seconds of speech without progress before a `lost` event. */
	lostAfterSec: number;
	linesBack: number;
	linesAhead: number;
};

export const DEFAULT_MATCHER_PARAMS: MatcherParams = {
	windowTokens: 6,
	similarity: 0.75,
	minMatches: 3,
	retakeMatches: 4,
	retakeMinWords: 3,
	endSilenceSec: 1.5,
	lostAfterSec: 8,
	linesBack: 1,
	linesAhead: 2,
};

export type MatchLine = { id: string; tokens: Token[] };
export type Cursor = { lineIndex: number; wordIndex: number };
export type MatcherEvent =
	| { type: "lineStart" | "lineEnd" | "retake" | "manualJump"; lineId: string; t: number }
	| { type: "lost" | "stageEnd"; t: number };

type SeqToken = { key: string; lineIndex: number; wordIndex: number };

export function wordKeys(text: string): string[] {
	return text
		.split(/\s+/)
		.map(normalizeWord)
		.filter((n) => n.length > 0 && !hasDigit(n))
		.map(phoneticKey);
}

export class StageMatcher {
	private readonly params: MatcherParams;
	private readonly seq: SeqToken[] = [];
	/** First seq index of each line, plus a sentinel equal to seq.length. */
	private readonly lineStart: number[] = [];
	private pos = -1;
	private line = 0;
	private started = false;
	private ended = false;
	private endPending = false;
	private lastHeardAt = 0;
	private readonly requests = new Map<string, string[]>();
	private readonly skip = new Map<string, number>();
	private order: string[] = [];
	private heardCount = 0;
	private history: { n: number; pos: number }[] = [];
	private lastRetakeAt = -1;
	private lastProgressAt: number | null = null;
	private lostReported = false;

	constructor(
		private readonly lines: MatchLine[],
		params: Partial<MatcherParams> = {},
	) {
		this.params = { ...DEFAULT_MATCHER_PARAMS, ...params };
		lines.forEach((line, lineIndex) => {
			this.lineStart.push(this.seq.length);
			line.tokens.forEach((tok, wordIndex) => {
				if (tok.key && !tok.isNumber) this.seq.push({ key: tok.key, lineIndex, wordIndex });
			});
		});
		this.lineStart.push(this.seq.length);
	}

	get cursor(): Cursor {
		const at = this.seq[this.pos];
		if (!at || at.lineIndex !== this.line) return { lineIndex: this.line, wordIndex: -1 };
		return { lineIndex: this.line, wordIndex: at.wordIndex };
	}

	get isEnded(): boolean {
		return this.ended;
	}

	startAt(lineIndex: number): void {
		this.line = Math.min(Math.max(0, lineIndex), this.lines.length - 1);
		this.pos = this.lineStart[this.line] - 1;
		this.started = false;
		this.ended = false;
		this.endPending = false;
	}

	/** Ends the stage once the last word has been followed by enough silence. Call regularly while listening. */
	checkEnd(now: number): MatcherEvent[] {
		if (!this.endPending || this.ended || now - this.lastHeardAt < this.params.endSilenceSec)
			return [];
		this.endPending = false;
		this.ended = true;
		return [
			{ type: "lineEnd", lineId: this.lines[this.line].id, t: now },
			{ type: "stageEnd", t: now },
		];
	}

	/** After a pause: the speaker gets the full wait again. */
	restartEndWait(now: number): void {
		this.lastHeardAt = now;
	}

	jumpToLine(lineIndex: number, t: number): MatcherEvent[] {
		const events: MatcherEvent[] = [];
		if (this.started) events.push({ type: "lineEnd", lineId: this.lines[this.line].id, t });
		this.startAt(lineIndex);
		events.push({ type: "manualJump", lineId: this.lines[this.line].id, t });
		for (const id of this.order) this.skip.set(id, (this.requests.get(id) ?? []).length);
		this.history = [];
		this.lastRetakeAt = -1;
		this.lastProgressAt = t;
		this.lostReported = false;
		return events;
	}

	ingest(h: Hypothesis, now: number): MatcherEvent[] {
		if (!this.requests.has(h.requestId)) {
			this.order.push(h.requestId);
			if (this.order.length > 6) {
				const old = this.order.shift() as string;
				this.requests.delete(old);
				this.skip.delete(old);
			}
		}
		this.requests.set(
			h.requestId,
			h.words.flatMap((w) => wordKeys(w.text)),
		);

		const all = this.heardKeys();
		const n = all.length;
		const previousCount = this.heardCount;
		const grew = n !== previousCount;
		this.heardCount = n;
		if (grew) this.lastHeardAt = now;
		if (this.ended || n === 0) return [];

		const events: MatcherEvent[] = [];
		const moved =
			this.detectRetake(all, previousCount, now, events) || this.advance(all, now, events);
		this.history.push({ n, pos: this.pos });
		if (this.history.length > 300) this.history.shift();

		if (moved) {
			this.lastProgressAt = now;
			this.lostReported = false;
		} else if (grew) {
			if (this.lastProgressAt === null) this.lastProgressAt = now;
			else if (!this.lostReported && now - this.lastProgressAt >= this.params.lostAfterSec) {
				events.push({ type: "lost", t: now });
				this.lostReported = true;
			}
		}
		return events;
	}

	private heardKeys(): string[] {
		const out: string[] = [];
		for (const id of this.order)
			out.push(...(this.requests.get(id) ?? []).slice(this.skip.get(id) ?? 0));
		return out;
	}

	private same(a: string, b: string): boolean {
		return similarity(a, b) >= this.params.similarity;
	}

	/** Cursor position recorded when at most `n` words had been heard. */
	private posBefore(n: number): number {
		for (let i = this.history.length - 1; i >= 0; i--)
			if (this.history[i].n <= n) return this.history[i].pos;
		return -1;
	}

	/** Several words can arrive in one update, so every ending position added since the last one is checked. */
	private detectRetake(
		all: string[],
		previousCount: number,
		t: number,
		events: MatcherEvent[],
	): boolean {
		for (let end = Math.min(previousCount + 1, all.length); end <= all.length; end++) {
			if (end > this.lastRetakeAt && this.retakeEndingAt(all, end, t, events)) return true;
		}
		return false;
	}

	private retakeEndingAt(all: string[], end: number, t: number, events: MatcherEvent[]): boolean {
		for (const L of [this.line, this.line - 1]) {
			if (L < 0) continue;
			const start = this.lineStart[L];
			const size = this.lineStart[L + 1] - start;
			if (size < this.params.retakeMinWords) continue;
			const m = Math.min(this.params.retakeMatches, size);
			if (end < m) continue;
			const recent = all.slice(end - m, end);
			if (!recent.every((k, i) => this.same(k, this.seq[start + i].key))) continue;
			if (this.posBefore(end - m) < start + m - 1) continue;
			if (this.started) events.push({ type: "lineEnd", lineId: this.lines[this.line].id, t });
			this.line = L;
			this.started = true;
			this.pos = start + m - 1;
			// A sentence no longer than the retake is already finished: the segment can still end.
			this.endPending = this.pos === this.seq.length - 1;
			this.lastHeardAt = t;
			events.push(
				{ type: "retake", lineId: this.lines[L].id, t },
				{ type: "lineStart", lineId: this.lines[L].id, t },
			);
			for (const key of all.slice(end)) {
				if (this.pos + 1 < this.seq.length && this.same(key, this.seq[this.pos + 1].key))
					this.moveTo(this.pos + 1, t, events);
			}
			this.lastRetakeAt = all.length;
			return true;
		}
		return false;
	}

	private advance(all: string[], t: number, events: MatcherEvent[]): boolean {
		const q = all.slice(-this.params.windowTokens);
		const last = q[q.length - 1];
		const fromLine = Math.max(0, this.line - this.params.linesBack);
		const toLine = Math.min(this.lines.length - 1, this.line + this.params.linesAhead);
		const lo = this.lineStart[fromLine];
		const hi = this.lineStart[toLine + 1] - 1;
		let best: { end: number; score: number } | null = null;
		for (let e = Math.max(lo, this.pos + 1); e <= hi; e++) {
			if (!this.same(this.seq[e].key, last)) continue;
			const score = this.scoreEndingAt(q, e, lo);
			if (score < this.params.minMatches) continue;
			if (!best || score > best.score) best = { end: e, score };
		}
		if (!best) return false;
		this.moveTo(best.end, t, events);
		return true;
	}

	/** LCS of the recent words (minus the newest) with the script just before `end`, plus 1 for the `end` pair. */
	private scoreEndingAt(q: string[], end: number, lo: number): number {
		const a = q.slice(0, -1);
		const from = Math.max(lo, end - (q.length + 2));
		const b = this.seq.slice(from, end).map((s) => s.key);
		const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
			new Array<number>(b.length + 1).fill(0),
		);
		for (let i = 1; i <= a.length; i++) {
			for (let j = 1; j <= b.length; j++) {
				dp[i][j] = this.same(a[i - 1], b[j - 1])
					? dp[i - 1][j - 1] + 1
					: Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
		return dp[a.length][b.length] + 1;
	}

	private moveTo(end: number, t: number, events: MatcherEvent[]): void {
		const target = this.seq[end].lineIndex;
		if (target !== this.line) {
			if (this.started) events.push({ type: "lineEnd", lineId: this.lines[this.line].id, t });
			this.line = target;
			this.started = false;
		}
		if (!this.started) {
			events.push({ type: "lineStart", lineId: this.lines[target].id, t });
			this.started = true;
		}
		this.pos = end;
		if (end === this.seq.length - 1) {
			// Keep listening: a retake may still cancel this. checkEnd() closes the line and the stage.
			this.endPending = true;
			this.lastHeardAt = t;
		}
	}
}
