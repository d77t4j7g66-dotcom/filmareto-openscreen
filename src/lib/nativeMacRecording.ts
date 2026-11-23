import type { Rectangle } from "electron";
import type { CursorCaptureMode } from "./recordingSession";

/** "camera": a talking-head take, the camera and the microphone with no screen (1.2.0). */
export type NativeMacSourceType = "display" | "window" | "camera";

export type NativeMacRecordingRequest = {
	schemaVersion: 1;
	recordingId?: number;
	/** Main-process injected native BrowserWindow IDs excluded from display capture. */
	excludedWindowIds?: number[];
	/** Display captures: leave Finder's desktop icons out. Notifications are always left out. */
	hideDesktopIcons?: boolean;
	/**
	 * 1.2.0, camera-only takes: the take starts warm during the countdown and the renderer marks
	 * the app as recording (the teleprompter's start) itself, when the countdown ends.
	 */
	deferAppRecording?: boolean;
	/**
	 * 1.2.0: started during the countdown and held there, so the camera has woken up and settled
	 * its exposure by zero; `releaseNativeMacHold` starts the take. The start resolves only then.
	 */
	holdUntilResume?: boolean;
	source: {
		type: NativeMacSourceType;
		sourceId: string;
		displayId?: number;
		windowId?: number;
		bounds?: Rectangle;
	};
	video: {
		fps: number;
		width: number;
		height: number;
		bitrate?: number;
		hideSystemCursor: boolean;
	};
	audio: {
		system: {
			enabled: boolean;
		};
		microphone: {
			enabled: boolean;
			deviceId?: string;
			deviceName?: string;
			gain: number;
		};
	};
	webcam: {
		enabled: boolean;
		deviceId?: string;
		deviceName?: string;
		width: number;
		height: number;
		fps: number;
	};
	cursor: {
		mode: CursorCaptureMode;
	};
	outputs: {
		screenPath: string;
		manifestPath?: string;
		/** 1.2.0: the camera's own `.mov` (HEVC Main 10, 50 Mbps, constant 30 fps). */
		webcamPath?: string;
		/** 1.2.0: the microphone as a 48 kHz 24-bit WAV at unity. */
		micWavPath?: string;
	};
};

export type NativeMacHelperReadyEvent = {
	event: "ready";
	schemaVersion: 1;
};

export type NativeMacHelperRecordingStartedEvent = {
	event: "recording-started";
	timestampMs: number;
	captureBounds?: Rectangle;
};

export type NativeMacHelperRecordingStoppedEvent = {
	event: "recording-stopped";
	screenPath: string;
	/** Frames the writer was not ready for or refused. Absent from helpers built before #937. */
	droppedVideoFrames?: number;
	/** 1.2.0: the camera's file, when the helper recorded the camera. */
	webcamPath?: string;
	/** 1.2.0: the microphone WAV, when one was written. */
	micWavPath?: string;
};

export type NativeMacHelperWarningEvent = {
	event: "warning";
	code: string;
	message: string;
};

export type NativeMacHelperErrorEvent = {
	event: "error";
	code: string;
	message: string;
};

export type NativeMacHelperEvent =
	| NativeMacHelperReadyEvent
	| NativeMacHelperRecordingStartedEvent
	| NativeMacHelperRecordingStoppedEvent
	| NativeMacHelperWarningEvent
	| NativeMacHelperErrorEvent;

export type NativeMacRecordingStartResult = {
	success: boolean;
	recordingId?: number;
	path?: string;
	helperPath?: string;
	/** Wall-clock ms of the take's first appended frame: the file's t=0. */
	startedAtMs?: number;
	/** The helper could not resolve the selected device and is using the system default. */
	microphoneDefaulted?: boolean;
	/** The microphone was asked for, but this macOS cannot capture it: the take has no voice. */
	microphoneUnavailable?: boolean;
	/** The microphone was asked for, but macOS lists no audio input: the take has no voice. */
	microphoneNotFound?: boolean;
	/** 1.2.0: the helper is recording the camera itself; the renderer records none. */
	webcamNative?: boolean;
	error?: string;
};

export function collectMacCaptureExcludedWindowIds(
	mediaSourceIds: ReadonlyArray<string | null | undefined>,
) {
	const windowIds: number[] = [];
	const seen = new Set<number>();
	for (const sourceId of mediaSourceIds) {
		const windowId = parseMacWindowIdFromSourceId(sourceId);
		if (
			windowId === null ||
			!Number.isSafeInteger(windowId) ||
			windowId <= 0 ||
			windowId > 0xffff_ffff ||
			seen.has(windowId)
		) {
			continue;
		}

		seen.add(windowId);
		windowIds.push(windowId);
	}
	return windowIds;
}

export function parseMacWindowIdFromSourceId(sourceId?: string | null) {
	if (!sourceId?.startsWith("window:")) {
		return null;
	}

	const windowIdPart = sourceId.split(":")[1];
	if (!windowIdPart || !/^\d+$/.test(windowIdPart)) {
		return null;
	}

	return Number(windowIdPart);
}

export function parseMacDisplayIdFromSourceId(sourceId?: string | null) {
	if (!sourceId?.startsWith("screen:")) {
		return null;
	}

	const displayIdPart = sourceId.split(":")[1];
	if (!displayIdPart || !/^\d+$/.test(displayIdPart)) {
		return null;
	}

	return Number(displayIdPart);
}
