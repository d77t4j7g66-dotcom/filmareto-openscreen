import { describe, expect, it } from "vitest";
import { tokenizeLine } from "../normalize";
import type { Hypothesis } from "../speechTypes";
import { type MatcherEvent, StageMatcher } from "./matcher";
import { levenshtein, similarity } from "./similarity";

const lines = (...texts: string[]) =>
	texts.map((t, i) => ({ id: `s-${i + 1}`, tokens: tokenizeLine(t) }));

/** Feeds words one at a time into one growing hypothesis, 0.3 s apart. */
class Reader {
	private words: string[] = [];
	t = 0;
	events: MatcherEvent[] = [];
	constructor(
		private readonly m: StageMatcher,
		private requestId = "r1",
	) {}
	say(text: string): this {
		for (const w of text.split(/\s+/).filter(Boolean)) {
			this.words.push(w);
			this.t += 0.3;
			const h: Hypothesis = {
				requestId: this.requestId,
				words: this.words.map((x) => ({ text: x, t: this.t, final: false })),
			};
			this.events.push(...this.m.ingest(h, this.t));
		}
		return this;
	}
	newRequest(id: string): this {
		this.requestId = id;
		this.words = [];
		return this;
	}
}

const kinds = (events: MatcherEvent[]) =>
	events.map((e) => ("lineId" in e ? `${e.type}:${e.lineId}` : e.type));

const L1 = "Το 90% κάνει αυτό το λάθος στο Instagram.";
const L2 = "Και δεν το ξέρει καν.";
const L3 = "Ανεβάζεις χωρίς hook στο πρώτο δευτερόλεπτο.";
const A = "Σήμερα θα μιλήσουμε για το μοντάζ.";
const B = "Είναι πιο εύκολο απ' ό,τι νομίζεις.";

describe("similarity", () => {
	it("measures edits and requires exact short words", () => {
		expect(levenshtein("κανι", "κανι")).toBe(0);
		expect(levenshtein("abc", "abd")).toBe(1);
		expect(similarity("το", "τα")).toBe(0);
		expect(similarity("το", "το")).toBe(1);
		expect(similarity("μιλισουμε", "μιλισουμα")).toBeGreaterThan(0.85);
		expect(similarity("", "")).toBe(0);
	});
});

describe("StageMatcher", () => {
	it("follows a normal reading, spoken numbers included", () => {
		const m = new StageMatcher(lines(L1, L2, L3));
		m.startAt(0);
		const r = new Reader(m).say(
			"το ενενήντα τοις εκατό κάνει αυτό το λάθος στο instagram και δεν το ξέρει καν ανεβάζεις χωρίς χουκ στο πρώτο δευτερόλεπτο",
		);
		expect(kinds(r.events)).toEqual([
			"lineStart:s-1",
			"lineEnd:s-1",
			"lineStart:s-2",
			"lineEnd:s-2",
			"lineStart:s-3",
		]);
		expect(m.isEnded).toBe(false);
		expect(kinds(m.checkEnd(r.t + 1.5))).toEqual(["lineEnd:s-3", "stageEnd"]);
		expect(m.isEnded).toBe(true);
	});

	it("moves the cursor word by word", () => {
		const m = new StageMatcher(lines(L1, L2));
		m.startAt(0);
		const r = new Reader(m).say("το ενενήντα τοις εκατό κάνει αυτό");
		expect(m.cursor).toEqual({ lineIndex: 0, wordIndex: 3 });
		r.say("το λάθος");
		expect(m.cursor).toEqual({ lineIndex: 0, wordIndex: 5 });
	});

	it("waits during ad-libs and resumes", () => {
		const m = new StageMatcher(lines(L1, L2, L3));
		m.startAt(0);
		const r = new Reader(m).say("το ενενήντα τοις εκατό κάνει αυτό το λάθος στο instagram");
		const before = m.cursor;
		r.say("εεε ας πούμε κάτι άλλο εντελώς διαφορετικό");
		expect(m.cursor).toEqual(before);
		r.say("και δεν το ξέρει");
		expect(m.cursor.lineIndex).toBe(1);
	});

	it("detects a retake of the current line", () => {
		const m = new StageMatcher(lines(L1, L2, L3));
		m.startAt(0);
		const r = new Reader(m).say(
			"το ενενήντα τοις εκατό κάνει αυτό το λάθος στο instagram και δεν το ξέρει",
		);
		r.events = [];
		r.say("και δεν το");
		expect(kinds(r.events)).toEqual([]);
		r.say("ξέρει");
		expect(kinds(r.events)).toEqual(["lineEnd:s-2", "retake:s-2", "lineStart:s-2"]);
		expect(m.cursor).toEqual({ lineIndex: 1, wordIndex: 3 });
		r.events = [];
		r.say("καν");
		expect(m.cursor).toEqual({ lineIndex: 1, wordIndex: 4 });
		expect(kinds(r.events)).toEqual([]);
	});

	it("detects a retake of the previous line", () => {
		const m = new StageMatcher(lines(A, B));
		m.startAt(0);
		const r = new Reader(m).say("σήμερα θα μιλήσουμε για το μοντάζ είναι πιο");
		expect(m.cursor.lineIndex).toBe(1);
		r.events = [];
		r.say("σήμερα θα μιλήσουμε για");
		expect(kinds(r.events)).toEqual(["lineEnd:s-2", "retake:s-1", "lineStart:s-1"]);
		expect(m.cursor).toEqual({ lineIndex: 0, wordIndex: 3 });
	});

	it("tolerates misrecognised words", () => {
		const m = new StageMatcher(lines(A, B));
		m.startAt(0);
		const r = new Reader(m).say(
			"σήμερα θα μιλίσουμε για τον μονταζ είναι πιο ευκολο από ότι νομίζης",
		);
		expect(kinds(m.checkEnd(r.t + 1.5))).toContain("stageEnd");
	});

	it("keeps tracking across recognition requests", () => {
		const m = new StageMatcher(lines(A, B));
		m.startAt(0);
		const r = new Reader(m, "r1").say("σήμερα θα");
		r.newRequest("r2").say("μιλήσουμε για το");
		expect(m.cursor).toEqual({ lineIndex: 0, wordIndex: 4 });
	});

	it("never moves back without a retake when partial results are revised", () => {
		const m = new StageMatcher(lines(A, B));
		m.startAt(0);
		const seen: number[] = [];
		const push = (words: string[], t: number) => {
			m.ingest({ requestId: "r1", words: words.map((w) => ({ text: w, t, final: false })) }, t);
			seen.push(m.cursor.wordIndex + m.cursor.lineIndex * 100);
		};
		push(["σήμερα", "θα", "μιλήσουμε"], 1);
		push(["σήμερα", "θα", "μιλήσουμε", "για"], 2);
		push(["σήμερα", "θα", "μιλήσουμαι"], 3);
		push(["σήμερα", "θα", "μιλήσουμε", "για", "το"], 4);
		for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
	});

	it("reports lost once after 8 s of unmatched speech", () => {
		const m = new StageMatcher(lines(A, B));
		m.startAt(0);
		const r = new Reader(m).say("σήμερα θα μιλήσουμε για το μοντάζ");
		r.events = [];
		r.say(
			"ένα δύο τρία τέσσερα πέντε έξι επτά οκτώ εννιά δέκα έντεκα δώδεκα δεκατρία δεκατέσσερα πεντε εξι επτα οκτω εννια δεκα ενα δυο τρια τεσσερα πεντε εξι επτα οκτω",
		);
		expect(kinds(r.events)).toEqual(["lost"]);
	});

	it("jumps to a line and ignores words heard before", () => {
		const m = new StageMatcher(lines(A, B));
		m.startAt(0);
		const r = new Reader(m).say("σήμερα θα μιλήσουμε");
		expect(kinds(m.jumpToLine(1, 5))).toEqual(["lineEnd:s-1", "manualJump:s-2"]);
		expect(m.cursor).toEqual({ lineIndex: 1, wordIndex: -1 });
		r.events = [];
		r.say("είναι πιο εύκολο");
		expect(kinds(r.events)).toEqual(["lineStart:s-2"]);
		expect(m.cursor).toEqual({ lineIndex: 1, wordIndex: 2 });
	});

	it("needs 4 words for a retake, so 3 repeated words do not go back", () => {
		const m = new StageMatcher(lines(A, B));
		m.startAt(0);
		const r = new Reader(m).say("σήμερα θα μιλήσουμε για το μοντάζ είναι πιο");
		r.events = [];
		r.say("σήμερα θα μιλήσουμε");
		expect(kinds(r.events)).toEqual([]);
		expect(m.cursor.lineIndex).toBe(1);
	});

	it("does not retake on a stutter", () => {
		const m = new StageMatcher(lines("Το πρόβλημα είναι ότι κανείς δεν το βλέπει.", B));
		m.startAt(0);
		const r = new Reader(m).say("το το πρόβλημα είναι ότι κανείς δεν το βλέπει");
		expect(kinds(r.events)).not.toContain("retake:s-1");

		const again = new StageMatcher(lines("Το πρόβλημα είναι ότι κανείς δεν το βλέπει.", B));
		again.startAt(0);
		const r2 = new Reader(again).say("το πρόβλημα το πρόβλημα είναι ότι κανείς");
		expect(kinds(r2.events)).not.toContain("retake:s-1");
		expect(again.cursor).toEqual({ lineIndex: 0, wordIndex: 4 });
	});

	it("retakes a 3-word sentence after 3 words, and never one of 2 words", () => {
		const three = new StageMatcher(lines("Πάμε λοιπόν τώρα.", A));
		three.startAt(0);
		const r = new Reader(three).say("πάμε λοιπόν τώρα σήμερα θα μιλήσουμε");
		r.events = [];
		r.say("πάμε λοιπόν τώρα");
		expect(kinds(r.events)).toEqual(["lineEnd:s-2", "retake:s-1", "lineStart:s-1"]);

		const two = new StageMatcher(lines("Πάμε τώρα.", A));
		two.startAt(0);
		const r2 = new Reader(two).say("πάμε τώρα σήμερα θα μιλήσουμε");
		r2.events = [];
		r2.say("πάμε τώρα πάμε τώρα");
		expect(kinds(r2.events)).not.toContain("retake:s-1");
	});

	it("ends the stage only after 1.5 s without new words", () => {
		const m = new StageMatcher(lines(A));
		m.startAt(0);
		const r = new Reader(m).say("σήμερα θα μιλήσουμε για το μοντάζ");
		expect(kinds(r.events)).toEqual(["lineStart:s-1"]);
		expect(m.isEnded).toBe(false);
		expect(m.checkEnd(r.t + 1.4)).toEqual([]);
		// A new word restarts the wait, even when it is not in the script.
		r.t += 1;
		r.say("εντάξει");
		expect(m.checkEnd(r.t + 1.4)).toEqual([]);
		const end = m.checkEnd(r.t + 1.5);
		expect(kinds(end)).toEqual(["lineEnd:s-1", "stageEnd"]);
		expect(m.isEnded).toBe(true);
		expect(m.checkEnd(r.t + 9)).toEqual([]);
	});

	it("does not end while the script has not been finished", () => {
		const m = new StageMatcher(lines(A, B));
		m.startAt(0);
		const r = new Reader(m).say("σήμερα θα μιλήσουμε για");
		expect(m.checkEnd(r.t + 100)).toEqual([]);
	});

	it("repeating the last sentence during the wait cancels the end", () => {
		const m = new StageMatcher(lines(A, B));
		m.startAt(0);
		const r = new Reader(m).say(
			"σήμερα θα μιλήσουμε για το μοντάζ είναι πιο εύκολο απ ό τι νομίζεις",
		);
		r.events = [];
		r.say("είναι πιο εύκολο απ");
		expect(kinds(r.events)).toEqual(["lineEnd:s-2", "retake:s-2", "lineStart:s-2"]);
		expect(m.checkEnd(r.t + 5)).toEqual([]);
		expect(m.isEnded).toBe(false);
		r.events = [];
		r.say("ό τι νομίζεις");
		expect(m.checkEnd(r.t + 1.5).map((e) => e.type)).toEqual(["lineEnd", "stageEnd"]);
	});

	it("repeating a 4-word last sentence during the wait still ends the segment", () => {
		const m = new StageMatcher(lines(A, "Είναι πολύ πιο εύκολο."));
		m.startAt(0);
		const r = new Reader(m).say("σήμερα θα μιλήσουμε για το μοντάζ είναι πολύ πιο εύκολο");
		r.t += 1;
		r.events = [];
		r.say("είναι πολύ πιο εύκολο");
		expect(kinds(r.events)).toEqual(["lineEnd:s-2", "retake:s-2", "lineStart:s-2"]);
		expect(m.checkEnd(r.t + 1.4)).toEqual([]);
		expect(kinds(m.checkEnd(r.t + 1.5))).toEqual(["lineEnd:s-2", "stageEnd"]);
	});

	it("repeating a 3-word last sentence during the wait still ends the segment", () => {
		const m = new StageMatcher(lines(A, "Πάμε λοιπόν τώρα."));
		m.startAt(0);
		const r = new Reader(m).say("σήμερα θα μιλήσουμε για το μοντάζ πάμε λοιπόν τώρα");
		r.t += 1;
		r.events = [];
		r.say("πάμε λοιπόν τώρα");
		expect(kinds(r.events)).toEqual(["lineEnd:s-2", "retake:s-2", "lineStart:s-2"]);
		expect(m.checkEnd(r.t + 1.4)).toEqual([]);
		expect(kinds(m.checkEnd(r.t + 1.5))).toEqual(["lineEnd:s-2", "stageEnd"]);
	});

	it("catches a retake when its 4th word arrives in one update with the next words", () => {
		const m = new StageMatcher(lines(A, B));
		m.startAt(0);
		const said = "σήμερα θα μιλήσουμε για το μοντάζ είναι πιο".split(" ");
		const send = (words: string[], t: number) =>
			m.ingest({ requestId: "r1", words: words.map((w) => ({ text: w, t, final: false })) }, t);
		said.forEach((_, i) => send(said.slice(0, i + 1), i * 0.3));
		const events = send([...said, "σήμερα", "θα", "μιλήσουμε", "για", "το"], 5);
		expect(kinds(events)).toEqual(["lineEnd:s-2", "retake:s-1", "lineStart:s-1"]);
		expect(m.cursor).toEqual({ lineIndex: 0, wordIndex: 4 });
	});

	it("a jump during the wait cancels the end", () => {
		const m = new StageMatcher(lines(A, B));
		m.startAt(0);
		const r = new Reader(m).say(
			"σήμερα θα μιλήσουμε για το μοντάζ είναι πιο εύκολο απ ό τι νομίζεις",
		);
		m.jumpToLine(0, r.t);
		expect(m.checkEnd(r.t + 5)).toEqual([]);
	});

	it("keeps the wait when asked to restart it after a pause", () => {
		const m = new StageMatcher(lines(A));
		m.startAt(0);
		const r = new Reader(m).say("σήμερα θα μιλήσουμε για το μοντάζ");
		m.restartEndWait(r.t + 60);
		expect(m.checkEnd(r.t + 61)).toEqual([]);
		expect(kinds(m.checkEnd(r.t + 61.5))).toEqual(["lineEnd:s-1", "stageEnd"]);
	});

	it("starts at a given line", () => {
		const m = new StageMatcher(lines(A, B));
		m.startAt(1);
		expect(m.cursor).toEqual({ lineIndex: 1, wordIndex: -1 });
	});
});
