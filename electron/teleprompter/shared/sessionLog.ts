import type { Hypothesis, RecognizedWord } from "./speechTypes";

export type LogEventType =
	| "start"
	| "pause"
	| "resume"
	| "lineStart"
	| "lineEnd"
	| "retake"
	| "lost"
	| "manualJump"
	| "stageEnd";
export type LogEvent = { t: number; type: LogEventType; lineId?: string };
export type SessionLog = {
	version: 1;
	scriptHash: string;
	stageId: string;
	attempt: number;
	startedAt: string;
	engine: string;
	events: LogEvent[];
	words: RecognizedWord[];
};

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export class SessionLogBuilder {
	private readonly events: LogEvent[] = [];
	private readonly hyps = new Map<string, RecognizedWord[]>();
	private startMs: number | null = null;
	private startedAt = "";

	constructor(
		private readonly meta: { scriptHash: string; stageId: string; attempt: number; engine: string },
		private readonly clock: () => number,
		private readonly wall: () => Date,
	) {}

	get started(): boolean {
		return this.startMs !== null;
	}

	start(): void {
		if (this.started) return;
		this.startMs = this.clock();
		this.startedAt = this.wall().toISOString();
		this.events.push({ t: 0, type: "start" });
	}

	/** Seconds since start on the monotonic clock. */
	now(): number {
		return this.startMs === null ? 0 : round3((this.clock() - this.startMs) / 1000);
	}

	add(type: LogEventType, lineId?: string): void {
		this.addAt(this.now(), type, lineId);
	}

	addAt(t: number, type: LogEventType, lineId?: string): void {
		if (!this.started) return;
		this.events.push(
			lineId === undefined ? { t: round3(t), type } : { t: round3(t), type, lineId },
		);
	}

	addHypothesis(h: Hypothesis): void {
		if (this.started) this.hyps.set(h.requestId, h.words);
	}

	build(): SessionLog {
		return {
			version: 1,
			scriptHash: this.meta.scriptHash,
			stageId: this.meta.stageId,
			attempt: this.meta.attempt,
			startedAt: this.startedAt,
			engine: this.meta.engine,
			events: [...this.events],
			words: [...this.hyps.values()].flat(),
		};
	}
}
