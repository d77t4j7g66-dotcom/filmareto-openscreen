import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, ipcMain, screen } from "electron";
import { HelperBridge } from "./main/helperBridge";
import { PrompterController } from "./main/prompterController";
import { scriptFromText } from "./script";
import type { HotkeyAction, PrompterSettings, PrompterUiState } from "./shared/protocol";
import { normalizeSettings, type Settings } from "./shared/settings";

const HELPER_NAME = "filmareto-teleprompter";
const PROJECT = "settings-window";

let controller: PrompterController | null = null;
let bridge: HelperBridge | null = null;
let settings: Settings | null = null;
let windowId: number | null = null;
let message = "";
let micName = "";
let text = "";
let recording = false;
let settingsWereShown = false;
/** Where the take changed segment, in milliseconds of the recording. */
let takeMarks: { atMs: number; segment: number }[] = [];
let takeStartedAt = 0;
let takePausedMs = 0;
let takePauseStartedAt: number | null = null;
let getSettingsWindow: () => BrowserWindow | null = () => null;

type RunScene = { id: string; name: string; text: string };
type RunTake = { session: unknown; marks: { atMs: number; segment: number }[] };
/**
 * Recording the scenes of a project one after the other. After each Stop the next scene waits on
 * the prompter, and the takes go to the project together at the end, so nothing has to stop to look
 * at one. They are on disk as they come: a crash leaves them to the next time the editor opens.
 */
type SceneRun = {
	projectId: string | null;
	scenes: RunScene[];
	takes: RunTake[];
	active: boolean;
	/** Between takes, with the next scene on the prompter. */
	ready: boolean;
	next: number | null;
	done: number | null;
};
let run: SceneRun | null = null;

function runPath(): string {
	return path.join(app.getPath("userData"), "scene-run.json");
}

function saveRun(): void {
	try {
		if (run?.takes.length) fs.writeFileSync(runPath(), JSON.stringify(run));
		else fs.rmSync(runPath(), { force: true });
	} catch (error) {
		console.warn("[teleprompter] could not save the run:", error);
	}
}

function openAtScene(index: number): void {
	const script = buildScript();
	if (!controller || !script) return;
	controller.close();
	bridge?.send({ type: "audio.listDevices" });
	controller.open({ projectDir: PROJECT, script, scriptHash: "", stageIndex: index });
	controller.setVisible(true);
}

/**
 * A take of a run just ended. True: it joined the run and the recording bar stays up with the next
 * scene ready, instead of the editor opening.
 */
export function teleprompterRunTakesOver(session: unknown): boolean {
	if (!run?.active || !controller) return false;
	const stage = controller.uiState.stageIndex;
	run.takes.push({ session, marks: takeMarks });
	takeMarks = [];
	run.done = stage;
	run.next = stage + 1 < run.scenes.length ? stage + 1 : null;
	run.ready = true;
	saveRun();
	if (run.next !== null) openAtScene(run.next);
	publish();
	return true;
}

/** The helper, for the questions it answers without opening anything. */
export function nativeHelperPath(): string | null {
	if (process.platform !== "darwin") return null;
	const arch = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	return path.join(process.resourcesPath, "electron", "native", "bin", arch, HELPER_NAME);
}

/** The recorder leaves these windows out of a display capture. */
export function teleprompterWindowIds(): number[] {
	return windowId === null ? [] : [windowId];
}

function settingsPath(): string {
	return path.join(app.getPath("userData"), "teleprompter.json");
}

function loadSettings(): Settings {
	try {
		return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath(), "utf8")), os.homedir());
	} catch {
		return normalizeSettings(null, os.homedir());
	}
}

function currentSettings(): Settings {
	settings ??= loadSettings();
	return settings;
}

function saveSettings(): void {
	try {
		fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, "\t"));
	} catch (error) {
		console.warn("[teleprompter] could not save settings:", error);
	}
}

function updatePrompter(patch: Partial<PrompterSettings>): void {
	const current = currentSettings();
	settings = normalizeSettings(
		{ ...current, prompter: { ...current.prompter, ...patch } },
		os.homedir(),
	);
	saveSettings();
}

type WindowState = PrompterUiState & {
	message: string;
	micName: string;
	settings: PrompterSettings;
	displays: { id: number; label: string }[];
	run: {
		ready: boolean;
		next: string | null;
		done: string | null;
		nextNumber: number | null;
		count: number;
	} | null;
};

function windowState(): WindowState {
	return {
		...(controller as PrompterController).uiState,
		message,
		micName,
		settings: currentSettings().prompter,
		displays: screen.getAllDisplays().map((display) => ({
			id: display.id,
			label: display.label || `${display.size.width} × ${display.size.height}`,
		})),
		run: run?.active
			? {
					ready: run.ready,
					next: run.next === null ? null : (run.scenes[run.next]?.name ?? null),
					done: run.done === null ? null : (run.scenes[run.done]?.name ?? null),
					nextNumber: run.next === null ? null : run.next + 1,
					count: run.scenes.length,
				}
			: null,
	};
}

function publish(): void {
	const target = getSettingsWindow();
	if (target && !target.isDestroyed()) {
		// A full-screen prompter on this display must not bury the window that controls it.
		const onTop = currentSettings().prompter.position === "fullscreen";
		if (target.isAlwaysOnTop() !== onTop) target.setAlwaysOnTop(onTop);
	}
	// The Record tab of the editor shows the same settings.
	const state = windowState();
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send("teleprompter:state", state);
	}
}

function buildScript() {
	return scriptFromText(text, currentSettings().prompter.mode === "bullets");
}

/** Puts the current text on the prompter, keeping the place when it is already open. */
function showText(): void {
	const script = buildScript();
	if (!controller) return;
	if (!script) {
		controller.close();
	} else if (controller.isOpen) {
		controller.scriptUpdated(PROJECT, script, "");
	} else {
		bridge?.send({ type: "audio.listDevices" });
		controller.open({ projectDir: PROJECT, script, scriptHash: "", stageIndex: 0 });
	}
	publish();
}

/** The recording's own clock: time spent paused is not in the file. */
function takeClockMs(): number {
	return (takePauseStartedAt ?? Date.now()) - takeStartedAt - takePausedMs;
}

/** A pause of the take holds the prompter and the clock with it. */
export function teleprompterRecordingPaused(paused: boolean): void {
	if (paused) {
		takePauseStartedAt ??= Date.now();
	} else if (takePauseStartedAt !== null) {
		takePausedMs += Date.now() - takePauseStartedAt;
		takePauseStartedAt = null;
	}
	if (controller?.isOpen && controller.uiState.playing === paused) {
		controller.perform("playPause");
	}
}

/** Rec hides the settings and starts the prompter; stop pauses it and brings the settings back. */
export function teleprompterRecordingChanged(isRecording: boolean): void {
	recording = isRecording;
	const target = getSettingsWindow();
	if (isRecording) {
		settingsWereShown = !!target?.isVisible();
		target?.hide();
		// A run read to its end starts again from the top: this is a new take.
		if (controller?.isFinished && !run?.active) {
			controller.close();
			showText();
		}
		if (run) run.ready = false;
		controller?.setVisible(true);
		takeStartedAt = Date.now();
		takePausedMs = 0;
		takePauseStartedAt = null;
		takeMarks = controller?.isOpen ? [{ atMs: 0, segment: controller.uiState.stageIndex }] : [];
	} else if (settingsWereShown) {
		target?.showInactive();
	}
	if (controller?.isOpen && controller.uiState.playing !== isRecording) {
		controller.perform("playPause");
	}
}

export function teleprompterWindowClosed(): void {
	controller?.close();
}

export function registerTeleprompter(settingsWindow: () => BrowserWindow | null): void {
	getSettingsWindow = settingsWindow;
	if (process.platform !== "darwin") return;

	const arch = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	const helper = new HelperBridge({
		binaryPath: path.join(process.resourcesPath, "electron", "native", "bin", arch, HELPER_NAME),
		log: (line) => console.warn(`[teleprompter] ${line.trim()}`),
	});
	bridge = helper;
	helper.on((msg) => {
		if (msg.type === "prompter.window") windowId = msg.windowId;
		if (msg.type === "audio.devices") {
			micName = msg.devices.find((device) => device.isDefault)?.name ?? "";
			publish();
		}
	});
	controller = new PrompterController({
		bridge: helper,
		getSettings: currentSettings,
		updatePrompterSettings: updatePrompter,
		nextAttempt: () => 1,
		writeLog: () => {},
		onStatus: (status) => {
			message = status;
			publish();
		},
		onHotkeysFailed: (failed) => {
			message = `These shortcuts could not be set: ${failed.join(", ")}`;
			publish();
		},
		onState: publish,
		isRecording: () => recording,
		onStageOpened: (segment) => {
			if (recording) takeMarks.push({ atMs: takeClockMs(), segment });
		},
	});
	if (app.isPackaged) helper.start();
	app.once("will-quit", () => helper.stop());

	// The prompter floats above everything, so it steps aside while a finished take is edited.
	app.on("browser-window-focus", (_event, focused) => {
		if (recording || !controller?.isOpen) return;
		if (focused === getSettingsWindow()) controller.setVisible(true);
		else if (focused.webContents.getURL().includes("windowType=editor")) {
			controller.setVisible(false);
		}
	});

	ipcMain.handle("teleprompter:setText", (_event, next: string) => {
		text = String(next ?? "");
		message = "";
		showText();
	});
	ipcMain.handle("teleprompter:perform", (_event, action: HotkeyAction) => {
		controller?.perform(action);
	});
	ipcMain.handle("teleprompter:set", (_event, patch: Partial<PrompterSettings>) => {
		const wasBullets = currentSettings().prompter.mode === "bullets";
		updatePrompter(patch);
		controller?.settingsChanged();
		if (wasBullets !== (currentSettings().prompter.mode === "bullets")) showText();
		publish();
	});
	ipcMain.handle("teleprompter:state", () => windowState());
	// Handed over once: the next take starts its own.
	ipcMain.handle("teleprompter:takeMarks", () => {
		const marks = takeMarks;
		takeMarks = [];
		return marks;
	});
	ipcMain.handle(
		"teleprompter:startRun",
		(
			_event,
			request: { projectId: string | null; scenes: RunScene[]; start: number; text: string },
		) => {
			text = String(request.text ?? "");
			message = "";
			// Takes of a run that never reached the editor are not thrown away by a new one.
			const unsaved = run?.takes ?? [];
			run = {
				projectId: request.projectId,
				scenes: request.scenes,
				takes: unsaved,
				active: true,
				ready: false,
				next: request.start,
				done: null,
			};
			openAtScene(request.start);
			publish();
		},
	);
	// This scene next, whichever it is: the one just done, said again.
	ipcMain.handle("teleprompter:runGoto", (_event, which: "next" | "done") => {
		if (!run) return;
		const index = which === "done" ? run.done : run.next;
		if (index === null) return;
		run.next = index;
		openAtScene(index);
		publish();
	});
	ipcMain.handle("teleprompter:endRun", () => {
		if (run) {
			run.active = false;
			run.ready = false;
			saveRun();
		}
		controller?.setVisible(false);
		publish();
	});
	// Handed over once, to the editor that puts the takes on the timeline.
	ipcMain.handle("teleprompter:takeRun", () => {
		let finished = run?.active ? null : run;
		if (!finished && !run) {
			try {
				finished = JSON.parse(fs.readFileSync(runPath(), "utf8")) as SceneRun;
			} catch {
				finished = null;
			}
		}
		if (!finished) return null;
		run = null;
		saveRun();
		return { projectId: finished.projectId, scenes: finished.scenes, takes: finished.takes };
	});
}
