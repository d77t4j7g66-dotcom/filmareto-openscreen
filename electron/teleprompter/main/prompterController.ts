import { type MatcherEvent, StageMatcher } from "../shared/matcher/matcher";
import { contextualStrings, stageEndHint, toPrompterStage } from "../shared/prompterModel";
import type {
	FromHelper,
	HotkeyAction,
	PrompterSettings,
	PrompterUiState,
	ToHelper,
} from "../shared/protocol";
import type { Script } from "../shared/script/types";
import { type LogEventType, type SessionLog, SessionLogBuilder } from "../shared/sessionLog";
import { activeHotkeys, formatHotkey, nextPosition, type Settings } from "../shared/settings";
import type { Hypothesis } from "../shared/speechTypes";
import type { BridgeStatus } from "./helperBridge";

export interface BridgeLike {
	send(msg: ToHelper): void;
	on(handler: (m: FromHelper) => void): () => void;
	onStatus(handler: (s: BridgeStatus) => void): () => void;
}

export type ControllerDeps = {
	bridge: BridgeLike;
	getSettings: () => Settings;
	updatePrompterSettings: (patch: Partial<PrompterSettings>) => void;
	nextAttempt: (projectDir: string, stageId: string) => number;
	writeLog: (projectDir: string, log: SessionLog) => void;
	clock?: () => number;
	wall?: () => Date;
	onStatus?: (text: string) => void;
	/** The helper reported an error: its code, for the window to word. */
	onHelperError?: (code: string) => void;
	/** What the helper could not register, after every `hotkeys.set`. Empty when all went through. */
	onHotkeysFailed?: (failed: HotkeyAction[]) => void;
	/** A segment was put on the prompter: the next one, the same one again, or one jumped to. */
	onStageOpened?: (stageIndex: number) => void;
	/** A take is running: a segment put on the prompter starts at once. */
	isRecording?: () => boolean;
	/** The camera the prompter may show behind the text; null while the camera is off. */
	getCameraName?: () => string | null;
	/** Called whenever something the control bar shows has changed. */
	onState?: (state: PrompterUiState) => void;
};

export type OpenRequest = {
	projectDir: string;
	script: Script;
	scriptHash: string;
	stageIndex: number;
	lineId?: string;
};

const ENGINE = "sfspeech-el-GR-ondevice";
const END_CHECK_MS = 100;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

export class PrompterController {
	private req: OpenRequest | null = null;
	private stageIndex = 0;
	private matcher: StageMatcher | null = null;
	private log: SessionLogBuilder | null = null;
	private playing = false;
	private awaitingCountdown = false;
	private speechOffset = 0;
	private visible = true;
	private manualLine: string | null = null;
	private lastCursor = "";
	private finished = false;
	private reopenOnReady = false;
	private statusText = "";
	/** Mode the current run started in; the stored setting can change under it. */
	private activeMode: PrompterSettings["mode"] = "manual";
	/** Words of an earlier session can arrive after it was stopped. */
	private speechSession = 0;
	private endTimer: ReturnType<typeof setInterval> | null = null;
	private readonly clock: () => number;
	private readonly wall: () => Date;

	constructor(private readonly deps: ControllerDeps) {
		this.clock = deps.clock ?? (() => performance.now());
		this.wall = deps.wall ?? (() => new Date());
		deps.bridge.on((m) => this.onMessage(m));
		deps.bridge.onStatus((s) => this.onBridgeStatus(s));
	}

	get isOpen(): boolean {
		return this.req !== null;
	}

	get uiState(): PrompterUiState {
		const settings = this.deps.getSettings().prompter;
		if (!this.req || !this.matcher) {
			return {
				open: false,
				playing: false,
				mode: settings.mode,
				position: settings.position,
				projectDir: null,
				stageName: "",
				stageIndex: 0,
				stageCount: 0,
				lineIndex: 0,
				lineCount: 0,
				status: "",
			};
		}
		const stage = this.stage();
		return {
			open: true,
			playing: this.playing || this.awaitingCountdown,
			mode: settings.mode,
			position: settings.position,
			projectDir: this.req.projectDir,
			stageName: stage.name,
			stageIndex: this.stageIndex,
			stageCount: this.req.script.stages.length,
			lineIndex: this.matcher.cursor.lineIndex,
			lineCount: stage.lines.length,
			status: this.statusText,
		};
	}

	/** The last segment was read to its end. */
	get isFinished(): boolean {
		return this.finished;
	}

	get isVisible(): boolean {
		return this.req !== null && this.visible;
	}

	/** Hides the panel even if it believes it is hidden: a reload may have shown it again. */
	hide(): void {
		if (!this.req) return;
		this.visible = false;
		this.send({ type: "prompter.setVisible", visible: false });
	}

	setVisible(visible: boolean): void {
		if (!this.req || this.visible === visible) return;
		this.visible = visible;
		this.send({ type: "prompter.setVisible", visible });
	}

	/** Runs a control-bar button or a hotkey. */
	perform(action: HotkeyAction): void {
		if (!this.req) return;
		this.onHotkey(action);
	}

	private notify(): void {
		this.deps.onState?.(this.uiState);
	}

	open(req: OpenRequest): void {
		if (this.req) this.stopAttempt();
		this.req = req;
		this.stageIndex = Math.min(Math.max(0, req.stageIndex), req.script.stages.length - 1);
		this.visible = true;
		this.openStage(req.lineId);
	}

	close(): void {
		if (!this.req) return;
		this.stopAttempt();
		this.send({ type: "speech.stop" });
		this.send({ type: "prompter.close" });
		this.req = null;
		this.matcher = null;
		this.notify();
	}

	/** The script of an open project was saved: reload it at the same stage and line, paused. */
	scriptUpdated(projectDir: string, script: Script, scriptHash: string): void {
		if (!this.req || this.req.projectDir !== projectDir) return;
		const lineId = this.currentLineId();
		this.stopAttempt();
		this.req = { ...this.req, script, scriptHash };
		this.stageIndex = Math.min(this.stageIndex, script.stages.length - 1);
		const stillThere = script.stages[this.stageIndex].lines.some((l) => l.id === lineId);
		this.openStage(stillThere ? lineId : undefined);
	}

	settingsChanged(): void {
		if (!this.req) return;
		if (this.playing && this.mode() !== this.activeMode) {
			this.pause();
			this.pushSettings();
			this.begin();
		} else {
			this.pushSettings();
		}
		this.send({ type: "hotkeys.set", bindings: activeHotkeys(this.deps.getSettings().hotkeys) });
	}

	// --- stage lifecycle ---

	private stage() {
		return (this.req as OpenRequest).script.stages[this.stageIndex];
	}

	private mode() {
		return this.deps.getSettings().prompter.mode;
	}

	private currentLineId(): string | undefined {
		if (!this.matcher || !this.req) return undefined;
		return this.stage().lines[this.matcher.cursor.lineIndex]?.id;
	}

	private openStage(lineId?: string): void {
		const req = this.req as OpenRequest;
		const stage = this.stage();
		const found = lineId ? stage.lines.findIndex((l) => l.id === lineId) : -1;
		const startIndex = found >= 0 ? found : 0;
		this.matcher = new StageMatcher(stage.lines.map((l) => ({ id: l.id, tokens: l.tokens })));
		this.matcher.startAt(startIndex);
		this.stopEndTimer();
		this.log = null;
		this.playing = false;
		this.finished = false;
		this.awaitingCountdown = false;
		this.manualLine = null;
		this.lastCursor = `${startIndex}:-1`;
		const settings = this.deps.getSettings();
		this.send({
			type: "prompter.open",
			stage: toPrompterStage(req.script, this.stageIndex),
			startLineId: stage.lines[startIndex].id,
			settings: settings.prompter,
		});
		this.send({ type: "hotkeys.set", bindings: activeHotkeys(settings.hotkeys) });
		this.pushCamera();
		this.status();
		this.deps.onStageOpened?.(this.stageIndex);
	}

	/** Pause if needed, save the attempt if it started. */
	private stopAttempt(): void {
		if (this.playing) this.pause();
		this.awaitingCountdown = false;
		this.saveLog();
	}

	private saveLog(): void {
		if (this.log?.started && this.req) this.deps.writeLog(this.req.projectDir, this.log.build());
		this.log = null;
	}

	private status(text?: string): void {
		const voice = this.mode() === "voice";
		const label = voice ? "Voice sync" : this.mode() === "bullets" ? "Bullets" : "Constant speed";
		const keys = formatHotkey(this.deps.getSettings().hotkeys, "playPause");
		const start = keys ? ` ${keys} start` : "";
		this.statusText =
			text ??
			(this.playing ? `${label} · ${voice ? "listening" : "scrolling"}` : `${label} · ⏸${start}`);
		this.send({ type: "prompter.status", text: this.statusText });
		this.notify();
	}

	private send(msg: ToHelper): void {
		this.deps.bridge.send(msg);
	}

	/** Tells the helper which camera is on; it decides whether to show it. */
	pushCamera(): void {
		this.send({ type: "prompter.setCamera", name: this.deps.getCameraName?.() ?? null });
	}

	private pushSettings(): void {
		this.pushCamera();
		this.send({ type: "prompter.setSettings", settings: this.deps.getSettings().prompter });
		this.notify();
	}

	// --- play / pause ---

	private playPause(): void {
		if (this.playing) {
			this.pause();
			return;
		}
		if (this.awaitingCountdown) return;
		if (this.deps.getSettings().countdown) {
			this.awaitingCountdown = true;
			this.send({ type: "prompter.countdown", seconds: 3 });
		} else {
			this.begin();
		}
	}

	private begin(): void {
		const req = this.req as OpenRequest;
		this.awaitingCountdown = false;
		if (!this.log) {
			const stage = this.stage();
			this.log = new SessionLogBuilder(
				{
					scriptHash: req.scriptHash,
					stageId: stage.id,
					attempt: this.deps.nextAttempt(req.projectDir, stage.id),
					engine: this.mode() === "voice" ? ENGINE : "manual",
				},
				this.clock,
				this.wall,
			);
			this.log.start();
			if (this.mode() === "manual") {
				// The first line is already on the reading line, so no scroll event will announce it.
				const id = this.currentLineId();
				if (id) {
					this.log.add("lineStart", id);
					this.manualLine = id;
				}
			}
		} else {
			this.log.add("resume");
		}
		this.playing = true;
		this.activeMode = this.mode();
		if (this.activeMode === "voice") {
			this.speechOffset = this.log.now();
			const s = this.deps.getSettings();
			this.send({
				type: "speech.start",
				sessionId: ++this.speechSession,
				deviceId: s.micDeviceId,
				contextualStrings: contextualStrings(req.script, this.stageIndex),
			});
			this.matcher?.restartEndWait(this.log.now());
			this.startEndTimer();
		}
		this.send({ type: "prompter.setPlaying", playing: true });
		this.status();
	}

	private pause(): void {
		this.playing = false;
		this.stopEndTimer();
		this.log?.add("pause");
		if (this.activeMode === "voice") this.send({ type: "speech.stop" });
		this.send({ type: "prompter.setPlaying", playing: false });
		this.status();
	}

	/** In voice mode the end of a segment is a silence, so nothing but time can trigger it. */
	private startEndTimer(): void {
		this.stopEndTimer();
		this.endTimer = setInterval(() => {
			if (this.playing && this.matcher && this.log)
				this.applyEvents(this.matcher.checkEnd(this.log.now()));
		}, END_CHECK_MS);
		this.endTimer.unref?.();
	}

	private stopEndTimer(): void {
		if (this.endTimer) clearInterval(this.endTimer);
		this.endTimer = null;
	}

	private finishStage(): void {
		this.stopEndTimer();
		const voice = this.activeMode === "voice";
		if (voice) this.send({ type: "speech.stop" });
		this.playing = false;
		if (this.manualLine) this.log?.add("lineEnd", this.manualLine);
		this.log?.add("stageEnd");
		this.saveLog();
		const req = this.req as OpenRequest;
		const isLast = this.stageIndex === req.script.stages.length - 1;
		// The speaker judges the attempt: the next segment starts with a press, never by itself.
		this.finished = isLast;
		this.send({
			type: "prompter.stageEnd",
			hint: stageEndHint(this.deps.getSettings().hotkeys, isLast),
		});
		this.status(isLast ? "End of script" : "End of segment");
	}

	// --- helper messages ---

	private onMessage(m: FromHelper): void {
		if (!this.req) return;
		switch (m.type) {
			case "hotkey":
				this.onHotkey(m.action);
				break;
			case "speech.words":
				this.onWords(m);
				break;
			case "speech.state":
				this.onSpeechState(m.state, m.message);
				break;
			case "prompter.countdownDone":
				if (this.awaitingCountdown) this.begin();
				break;
			case "prompter.scrolled":
				this.onScrolled(m.lineId, m.byUser);
				break;
			case "prompter.state":
				this.visible = m.visible;
				if (m.atEnd && this.playing && this.mode() === "manual") this.finishStage();
				break;
			case "hotkeys.result":
				this.deps.onHotkeysFailed?.(m.failed);
				break;
			case "error":
				// The helper's own text is for the log; the window words the code.
				console.warn(`[teleprompter] helper error ${m.code}: ${m.message}`);
				this.deps.onHelperError?.(m.code);
				break;
		}
	}

	private onWords(h: Hypothesis & { sessionId: number }): void {
		if (h.sessionId !== this.speechSession) return;
		if (!this.playing || !this.matcher || !this.log || this.mode() !== "voice") return;
		const shifted: Hypothesis = {
			requestId: h.requestId,
			words: h.words.map((w) => ({
				...w,
				t: round3(w.t + this.speechOffset),
				...(w.at !== undefined ? { at: round3(w.at + this.speechOffset) } : {}),
			})),
		};
		this.log.addHypothesis(shifted);
		this.applyEvents(this.matcher.ingest(shifted, this.log.now()));
	}

	private applyEvents(events: MatcherEvent[]): void {
		let ended = false;
		for (const e of events) {
			if (e.type === "stageEnd") {
				ended = true;
				continue;
			}
			this.log?.addAt(e.t, e.type as LogEventType, "lineId" in e ? e.lineId : undefined);
		}
		this.sendCursor();
		if (ended) this.finishStage();
	}

	private sendCursor(force = false): void {
		if (!this.matcher) return;
		const c = this.matcher.cursor;
		const key = `${c.lineIndex}:${c.wordIndex}`;
		if (!force && key === this.lastCursor) return;
		this.lastCursor = key;
		this.send({
			type: "prompter.setCursor",
			lineId: this.stage().lines[c.lineIndex].id,
			wordIndex: c.wordIndex,
		});
		this.notify();
	}

	private onSpeechState(state: string, message?: string): void {
		if (state === "denied" || state === "unavailable") {
			if (this.mode() !== "voice") return;
			const wasPlaying = this.playing;
			this.stopEndTimer();
			this.playing = false;
			this.deps.updatePrompterSettings({ mode: "manual" });
			this.pushSettings();
			if (message) console.warn(`[teleprompter] speech: ${message}`);
			this.deps.onStatus?.("Speech recognition is not available");
			if (wasPlaying) this.begin();
			else this.status();
		} else if (state === "deviceLost") {
			if (this.playing) {
				this.stopEndTimer();
				this.playing = false;
				this.log?.add("pause");
				this.send({ type: "prompter.setPlaying", playing: false });
			}
			this.deps.updatePrompterSettings({ mode: "manual" });
			this.pushSettings();
			this.status("Microphone disconnected: manual");
			if (message) console.warn(`[teleprompter] speech: ${message}`);
			this.deps.onStatus?.("Microphone disconnected");
		}
	}

	private onScrolled(lineId: string, byUser: boolean): void {
		if (!this.matcher) return;
		const index = this.stage().lines.findIndex((l) => l.id === lineId);
		if (index < 0) return;
		const t = this.log?.now() ?? 0;
		if (this.mode() === "voice") {
			if (!byUser) return;
			for (const e of this.matcher.jumpToLine(index, t))
				this.log?.addAt(e.t, e.type as LogEventType, "lineId" in e ? e.lineId : undefined);
			this.lastCursor = `${index}:-1`;
			return;
		}
		this.matcher.startAt(index);
		if (!this.log?.started) return;
		if (byUser) {
			this.log.add("manualJump", lineId);
		} else if (this.playing) {
			if (this.manualLine) this.log.add("lineEnd", this.manualLine);
			this.log.add("lineStart", lineId);
		}
		this.manualLine = lineId;
	}

	private onBridgeStatus(s: BridgeStatus): void {
		if (s === "restarting" || s === "failed") this.stopEndTimer();
		if (s === "restarting") this.reopenOnReady = true;
		else if (s === "ready" && this.reopenOnReady) {
			this.reopenOnReady = false;
			if (!this.req) return;
			const lineId = this.currentLineId();
			this.stopEndTimer();
			this.playing = false;
			this.saveLog();
			this.openStage(lineId);
		} else if (s === "failed") {
			this.deps.onStatus?.(
				"The teleprompter helper stopped answering. Close and reopen Filmareto.",
			);
		}
	}

	// --- hotkeys ---

	private onHotkey(action: HotkeyAction): void {
		switch (action) {
			case "playPause":
				this.playPause();
				break;
			case "nextLine":
				this.jumpLine(1);
				break;
			case "prevLine":
				this.jumpLine(-1);
				break;
			case "nextStage":
				this.changeStage(1);
				break;
			case "prevStage":
				this.changeStage(-1);
				break;
			case "retakeStage":
				this.stopAttempt();
				this.openStage();
				if (this.deps.isRecording?.()) this.begin();
				break;
			case "faster":
				this.changeSpeed(1);
				break;
			case "slower":
				this.changeSpeed(-1);
				break;
			case "toggleMode":
				this.toggleMode();
				break;
			case "toggleVisible":
				this.visible = !this.visible;
				this.send({ type: "prompter.setVisible", visible: this.visible });
				break;
			case "cyclePosition": {
				const current = this.deps.getSettings().prompter.position;
				this.deps.updatePrompterSettings({
					position: nextPosition(current),
				});
				this.pushSettings();
				break;
			}
		}
	}

	private jumpLine(delta: number): void {
		if (!this.matcher) return;
		const lines = this.stage().lines;
		const target = Math.min(lines.length - 1, Math.max(0, this.matcher.cursor.lineIndex + delta));
		for (const e of this.matcher.jumpToLine(target, this.log?.now() ?? 0)) {
			this.log?.addAt(e.t, e.type as LogEventType, "lineId" in e ? e.lineId : undefined);
		}
		this.manualLine = null;
		this.sendCursor(true);
	}

	private changeStage(delta: number): void {
		const next = this.stageIndex + delta;
		if (!this.req || next < 0 || next >= this.req.script.stages.length) return;
		this.stopAttempt();
		this.stageIndex = next;
		this.openStage();
		if (this.deps.isRecording?.()) this.begin();
	}

	private changeSpeed(delta: number): void {
		const speed = Math.min(10, Math.max(1, this.deps.getSettings().prompter.speed + delta));
		this.deps.updatePrompterSettings({ speed });
		this.pushSettings();
	}

	private toggleMode(): void {
		// Bullets split the text differently, so that switch belongs to the settings window.
		if (this.mode() === "bullets") return;
		const wasPlaying = this.playing;
		if (wasPlaying) this.pause();
		this.deps.updatePrompterSettings({ mode: this.mode() === "voice" ? "manual" : "voice" });
		this.pushSettings();
		if (wasPlaying) this.begin();
		else this.status();
	}
}
