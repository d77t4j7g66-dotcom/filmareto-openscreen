import type { RecognizedWord } from "./speechTypes";

export type PrompterPosition = "screen" | "fullscreen";
export type PrompterMode = "voice" | "manual" | "bullets";

export type PrompterSettings = {
	position: PrompterPosition;
	fontSize: number;
	visibleLines: number;
	width: number;
	/** Background opacity for notch and free positions. */
	opacity: number;
	/** Background opacity for the screen position. */
	screenOpacity: number;
	mirror: boolean;
	showCues: boolean;
	fadeNearCursor: boolean;
	mode: PrompterMode;
	speed: number;
	/** Display chosen for the top and full-screen positions. Null follows the notch, then the mouse. */
	displayId: number | null;
	/** The user chose the display themselves; until then it follows the position's default. */
	displayPicked: boolean;
	/** Height of the reading line in the text area, 0 at the top and 1 at the bottom. */
	activeLine: number;
	paddingH: number;
	paddingV: number;
	lineSpacing: number;
	showGuide: boolean;
	/** Live camera behind the text (full screen on another display only): 0 hides it, 1 is full. */
	cameraOpacity: number;
};

export type PrompterWord = { text: string; bold: boolean };
export type PrompterLine = {
	id: string;
	words: PrompterWord[];
	directions: string[];
	cues: string[];
};
export type PrompterStage = {
	id: string;
	name: string;
	index: number;
	count: number;
	startDirections: string[];
	startCues: string[];
	lines: PrompterLine[];
};

export const HOTKEY_ACTIONS = [
	"playPause",
	"nextLine",
	"prevLine",
	"nextStage",
	"prevStage",
	"retakeStage",
	"faster",
	"slower",
	"toggleMode",
	"toggleVisible",
	"cyclePosition",
] as const;
export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number];
export type HotkeyModifier = "ctrl" | "alt" | "shift" | "cmd";
/** An empty `key` is a shortcut the user cleared: it is kept in the settings and never registered. */
export type HotkeyBinding = { action: HotkeyAction; key: string; modifiers: HotkeyModifier[] };
export type AudioDevice = { id: string; name: string; isDefault: boolean };

/** What the app window shows about the teleprompter (control bar). */
export type PrompterUiState = {
	open: boolean;
	playing: boolean;
	mode: PrompterMode;
	position: PrompterPosition;
	projectDir: string | null;
	stageName: string;
	stageIndex: number;
	stageCount: number;
	lineIndex: number;
	lineCount: number;
	status: string;
};

export type ToHelper =
	| { type: "prompter.open"; stage: PrompterStage; startLineId: string; settings: PrompterSettings }
	| { type: "prompter.setCursor"; lineId: string; wordIndex: number }
	| { type: "prompter.setSettings"; settings: PrompterSettings }
	/** The camera to show behind the text, as Chromium labels it. Null while the camera is off. */
	| { type: "prompter.setCamera"; name: string | null }
	| { type: "prompter.setPlaying"; playing: boolean }
	| { type: "prompter.setVisible"; visible: boolean }
	| { type: "prompter.stageEnd"; hint: string }
	| { type: "prompter.countdown"; seconds: number }
	| { type: "prompter.status"; text: string | null }
	| { type: "prompter.close" }
	/**
	 * The camera, full screen on a display of its own. Not the prompter's: it needs no prompter open.
	 * `enabled` is false while the camera is off or none is chosen; `displayId` is a CGDirectDisplayID
	 * as a string, like `prompter.state`'s.
	 */
	| {
			type: "cameraPreview.set";
			enabled: boolean;
			displayId: string | null;
			cameraName: string | null;
			mirror: boolean;
	  }
	| {
			type: "speech.start";
			sessionId: number;
			deviceId: string | null;
			contextualStrings: string[];
	  }
	| { type: "speech.stop" }
	| { type: "speech.file"; path: string; contextualStrings: string[] }
	| { type: "hotkeys.set"; bindings: HotkeyBinding[] }
	| { type: "audio.listDevices" };

export type FromHelper =
	| { type: "ready"; version: string }
	| { type: "speech.words"; sessionId: number; requestId: string; words: RecognizedWord[] }
	| {
			type: "speech.state";
			state: "listening" | "stopped" | "denied" | "unavailable" | "deviceLost";
			message?: string;
	  }
	| { type: "speech.fileDone"; duration: number }
	| { type: "hotkey"; action: HotkeyAction }
	| { type: "hotkeys.result"; failed: HotkeyAction[] }
	| {
			type: "prompter.state";
			visible: boolean;
			position: PrompterPosition;
			frame: { x: number; y: number; width: number; height: number };
			atEnd: boolean;
			displayId: string;
	  }
	| { type: "prompter.scrolled"; lineId: string; byUser: boolean }
	| { type: "prompter.countdownDone" }
	| { type: "prompter.window"; windowId: number }
	| { type: "audio.devices"; devices: AudioDevice[] }
	/** The camera window opened or closed; `windowId` is there only while it is open. */
	| { type: "cameraPreview.state"; active: boolean; windowId?: number }
	| { type: "error"; code: string; message: string };

export function encodeMessage(msg: ToHelper): string {
	return `${JSON.stringify(msg)}\n`;
}

export class LineDecoder {
	private buffer = "";

	push(chunk: string): FromHelper[] {
		this.buffer += chunk;
		const out: FromHelper[] = [];
		let idx = this.buffer.indexOf("\n");
		while (idx >= 0) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (line) {
				try {
					out.push(JSON.parse(line) as FromHelper);
				} catch {
					out.push({ type: "error", code: "bad_json", message: line.slice(0, 200) });
				}
			}
			idx = this.buffer.indexOf("\n");
		}
		return out;
	}
}
