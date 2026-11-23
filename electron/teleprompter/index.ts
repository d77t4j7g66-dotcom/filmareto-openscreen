import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, ipcMain, screen } from "electron";
import { HelperBridge } from "./main/helperBridge";
import { PrompterController } from "./main/prompterController";
import { scriptFromText } from "./script";
import {
	cameraPreviewDisplay,
	cameraPreviewMessage,
	isFullscreenOnOtherDisplay,
	previewStartsSession,
} from "./shared/camera";
import type {
	AudioDevice,
	HotkeyAction,
	HotkeyBinding,
	PrompterSettings,
	PrompterUiState,
	ToHelper,
} from "./shared/protocol";
import {
	activeHotkeys,
	type CameraPreviewSettings,
	normalizeSettings,
	type Settings,
	settingsWindowOnTop,
} from "./shared/settings";
import { segmentAttempt } from "./shared/takeMarks";

const HELPER_NAME = "filmareto-teleprompter";
const PROJECT = "settings-window";

let controller: PrompterController | null = null;
let bridge: HelperBridge | null = null;
let settings: Settings | null = null;
let windowId: number | null = null;
let message = "";
let micName = "";
let micDevices: AudioDevice[] = [];
/** What the helper could not register at the last `hotkeys.set`: another app holds them. */
let failedHotkeys: HotkeyAction[] = [];
/** The last camera message sent to the helper, so an unchanged state is not sent again. */
let lastCameraPreview: Extract<ToHelper, { type: "cameraPreview.set" }> | null = null;
let cameraPreviewWindowId: number | null = null;
/** The recorder has the native camera: a preview must not start under it. */
let cameraClaimed = false;
/** The code of the last helper error that is not the camera preview's. Empty when none. */
let helperError = "";
/** The helper's error code for the camera on its display (the window words it). Empty when fine. */
let cameraPreviewError = "";
/** The camera the recorder has on, for the prompter to show behind the text. Null while off. */
let cameraName: string | null = null;
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
	return [windowId, cameraPreviewWindowId].filter((id): id is number => id !== null);
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
	micDevices: AudioDevice[];
	/** The microphone picked for voice scrolling; null is the Mac's input. */
	micDeviceId: string | null;
	settings: PrompterSettings;
	/** The open project has a script to show. */
	hasScript: boolean;
	hotkeys: HotkeyBinding[];
	failedHotkeys: HotkeyAction[];
	cameraPreview: CameraPreviewSettings;
	/** The app's camera is on, so a preview of it has something to show. */
	cameraOn: boolean;
	/** The display a second screen would be: the first that is not the main one. */
	secondaryDisplayId: number | null;
	cameraPreviewError: string;
	helperError: string;
	/** While a take runs: which attempt at the open segment it is on, for the recording bar. */
	take: number;
	displays: { id: number; label: string }[];
	primaryDisplayId: number;
	/** Full screen on another display: where the camera can sit behind the text. */
	cameraBehindText: boolean;
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
		micDevices,
		micDeviceId: currentSettings().micDeviceId,
		settings: currentSettings().prompter,
		hasScript: buildScript() !== null,
		hotkeys: currentSettings().hotkeys,
		failedHotkeys,
		cameraPreview: currentSettings().cameraPreview,
		cameraOn: cameraName !== null,
		cameraPreviewError,
		helperError,
		secondaryDisplayId:
			screen.getAllDisplays().find((display) => display.id !== screen.getPrimaryDisplay().id)?.id ??
			null,
		take:
			recording && controller?.isOpen
				? segmentAttempt(takeMarks, controller.uiState.stageIndex)
				: 1,
		displays: screen.getAllDisplays().map((display) => ({
			id: display.id,
			label: display.label || `${display.size.width} × ${display.size.height}`,
		})),
		primaryDisplayId: screen.getPrimaryDisplay().id,
		cameraBehindText: isFullscreenOnOtherDisplay(
			currentSettings().prompter,
			screen.getPrimaryDisplay().id,
		),
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

let publishTimer: ReturnType<typeof setTimeout> | null = null;
/** For a slider drag: the window gets the state at most every 50 ms, and always the last one. */
function publishSoon(): void {
	if (publishTimer) return;
	publishTimer = setTimeout(() => {
		publishTimer = null;
		publish();
	}, 50);
}

const followedSettingsWindows = new WeakSet<BrowserWindow>();

/** A full-screen prompter on the settings window's display must not bury the window that controls it. */
function pinSettingsWindow(target: BrowserWindow): void {
	const onTop = settingsWindowOnTop(
		currentSettings().prompter,
		screen.getDisplayMatching(target.getBounds()).id,
	);
	if (target.isAlwaysOnTop() !== onTop) target.setAlwaysOnTop(onTop);
}

function publish(): void {
	const target = getSettingsWindow();
	if (target && !target.isDestroyed()) {
		pinSettingsWindow(target);
		// Dragged to another display, it may now share it with the prompter, or no longer.
		if (!followedSettingsWindows.has(target)) {
			followedSettingsWindows.add(target);
			// Closed while a shortcut was being recorded: the shortcuts must come back.
			target.on("closed", () => sendHotkeys(false));
			target.on("moved", () => {
				if (!target.isDestroyed()) pinSettingsWindow(target);
			});
		}
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

/**
 * The script changed: reload it on an open prompter, keeping the place and not showing a panel
 * that was hidden. A prompter that is not open stays closed (and keeps the shortcuts free) until
 * a take or the settings window needs it.
 */
function reloadText(): void {
	if (!controller) return;
	if (!controller.isOpen) {
		publish();
		return;
	}
	const wasVisible = controller.isVisible;
	showText();
	if (!wasVisible && controller.isOpen) controller.hide();
}

function sendHotkeys(suspended: boolean): void {
	if (!controller?.isOpen) return;
	bridge?.send({
		type: "hotkeys.set",
		bindings: suspended ? [] : activeHotkeys(currentSettings().hotkeys),
	});
}

function ensureOpen(): void {
	if (controller && !controller.isOpen) showText();
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
		ensureOpen();
		controller?.setVisible(true);
		takeStartedAt = Date.now();
		takePausedMs = 0;
		takePauseStartedAt = null;
		takeMarks = controller?.isOpen ? [{ atMs: 0, segment: controller.uiState.stageIndex }] : [];
	} else {
		if (settingsWereShown) target?.showInactive();
		// A camera preview held back during the take can start now.
		pushCameraPreview();
	}
	if (controller?.isOpen && controller.uiState.playing !== isRecording) {
		controller.perform("playPause");
	}
}

/**
 * Tells the helper about the camera on a display of its own, when something it depends on changed:
 * the switch, the display, the app's camera or the mirror. The display defaults to the second one.
 */
function pushCameraPreview(): void {
	if (!bridge) return;
	const current = currentSettings();
	const displayId = cameraPreviewDisplay(
		current.cameraPreview.displayId,
		screen.getAllDisplays().map((display) => display.id),
		screen.getPrimaryDisplay().id,
	);
	const message = cameraPreviewMessage(
		{ enabled: current.cameraPreview.enabled, displayId },
		cameraName,
		current.prompter.mirror,
	);
	if (JSON.stringify(message) === JSON.stringify(lastCameraPreview)) return;
	// A take is on: starting the camera now would fight the recorder for it. Turning it off is fine.
	if ((recording || cameraClaimed) && previewStartsSession(message, lastCameraPreview)) return;
	lastCameraPreview = message;
	cameraPreviewError = "";
	bridge.send(message);
}

/** The recorder took or gave back the native camera; a held preview starts when it is free. */
export function teleprompterCameraClaimChanged(claimed: boolean): void {
	if (cameraClaimed === claimed) return;
	cameraClaimed = claimed;
	pushCameraPreview();
}

/** The recorder's camera changed (turned on or off, another one picked). Null while it is off. */
export function teleprompterCameraChanged(name: string | null): void {
	if (name === cameraName) return;
	cameraName = name;
	controller?.pushCamera();
	pushCameraPreview();
	publish();
}

export function teleprompterWindowClosed(): void {
	controller?.close();
}

export function registerTeleprompter(settingsWindow: () => BrowserWindow | null): void {
	getSettingsWindow = settingsWindow;
	if (process.platform !== "darwin") {
		// The editor sends the script on every platform; there is no prompter to give it to.
		ipcMain.handle("teleprompter:setText", () => {});
		return;
	}

	const arch = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	const helper = new HelperBridge({
		binaryPath: path.join(process.resourcesPath, "electron", "native", "bin", arch, HELPER_NAME),
		log: (line) => console.warn(`[teleprompter] ${line.trim()}`),
	});
	bridge = helper;
	helper.on((msg) => {
		if (msg.type === "prompter.window") windowId = msg.windowId;
		if (msg.type === "cameraPreview.state") {
			// The window id comes once at launch, with active false: keep it, so the capture always
			// leaves the preview out.
			cameraPreviewWindowId = msg.windowId ?? cameraPreviewWindowId;
			if (msg.active) cameraPreviewError = "";
			publish();
		}
		if (msg.type === "error" && msg.code.startsWith("camera_preview_")) {
			cameraPreviewError = msg.code;
			publish();
		}
		if (msg.type === "audio.devices") {
			micDevices = msg.devices;
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
		onHelperError: (code) => {
			if (!code.startsWith("camera_preview_")) helperError = code;
			publish();
		},
		onStatus: (status) => {
			message = status;
			publish();
		},
		onHotkeysFailed: (failed) => {
			failedHotkeys = failed;
			publish();
		},
		onState: publish,
		isRecording: () => recording,
		getCameraName: () => cameraName,
		onStageOpened: (segment) => {
			if (recording) takeMarks.push({ atMs: takeClockMs(), segment });
		},
	});
	// A restarted helper has forgotten the camera window.
	helper.onStatus((status) => {
		if (status === "restarting" || status === "starting") {
			lastCameraPreview = null;
			cameraPreviewWindowId = null;
		}
		if (status === "ready") pushCameraPreview();
	});
	pushCameraPreview();
	// An unplugged display closes the preview for good: send the state again when screens change.
	const resendCameraPreview = () => {
		lastCameraPreview = null;
		pushCameraPreview();
	};
	screen.on("display-added", resendCameraPreview);
	screen.on("display-removed", resendCameraPreview);
	screen.on("display-metrics-changed", resendCameraPreview);
	if (app.isPackaged) helper.start();
	app.once("will-quit", () => helper.stop());

	// The prompter floats above everything, so it steps aside while a finished take is edited.
	app.on("browser-window-focus", (_event, focused) => {
		if (recording) return;
		if (focused === getSettingsWindow()) {
			ensureOpen();
			controller?.setVisible(true);
		} else if (controller?.isOpen && focused.webContents.getURL().includes("windowType=editor")) {
			controller.setVisible(false);
		}
	});

	ipcMain.handle("teleprompter:setText", (_event, next: string) => {
		// A run of scenes put its own text on the prompter; the editor's script must not replace it.
		if (run?.active) return;
		const incoming = String(next ?? "");
		// The editor sends the script each time it opens: the same one changes nothing.
		if (incoming === text) return;
		text = incoming;
		message = "";
		helperError = "";
		reloadText();
	});
	ipcMain.handle("teleprompter:listMics", () => {
		bridge?.send({ type: "audio.listDevices" });
	});
	// Recording a shortcut must not trigger the ones that are registered.
	ipcMain.handle("teleprompter:suspendHotkeys", (_event, suspended: boolean) => {
		sendHotkeys(suspended);
	});
	ipcMain.handle("teleprompter:perform", (_event, action: HotkeyAction) => {
		controller?.perform(action);
	});
	ipcMain.handle("teleprompter:set", (_event, patch: Partial<PrompterSettings>) => {
		const wasBullets = currentSettings().prompter.mode === "bullets";
		updatePrompter(patch);
		controller?.settingsChanged();
		if (wasBullets !== (currentSettings().prompter.mode === "bullets")) reloadText();
		pushCameraPreview();
		publishSoon();
	});
	ipcMain.handle(
		"teleprompter:setCameraPreview",
		(_event, patch: Partial<CameraPreviewSettings>) => {
			const current = currentSettings();
			settings = normalizeSettings(
				{ ...current, cameraPreview: { ...current.cameraPreview, ...patch } },
				os.homedir(),
			);
			saveSettings();
			pushCameraPreview();
			publish();
		},
	);
	ipcMain.handle("teleprompter:setMic", (_event, deviceId: string | null) => {
		const current = currentSettings();
		settings = normalizeSettings({ ...current, micDeviceId: deviceId }, os.homedir());
		saveSettings();
		publish();
	});
	// The helper re-registers them and answers with `hotkeys.result`, which marks the refused ones.
	ipcMain.handle("teleprompter:setHotkeys", (_event, bindings: HotkeyBinding[]) => {
		const current = currentSettings();
		settings = normalizeSettings({ ...current, hotkeys: bindings }, os.homedir());
		saveSettings();
		failedHotkeys = [];
		controller?.settingsChanged();
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
