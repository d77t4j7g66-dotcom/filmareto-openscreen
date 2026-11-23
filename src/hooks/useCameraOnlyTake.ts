import { useCallback, useEffect, useRef, useState } from "react";
import { nativeMicrophoneGain } from "@/lib/audioMix";
import type { NativeMacRecordingRequest } from "@/lib/nativeMacRecording";
import { createRecorderHandle, type RecorderHandle } from "./recorderHandle";
import {
	WEBCAM_TARGET_FRAME_RATE,
	webcamBitrateForStream,
	webcamPresetFor,
	webcamVideoConstraints,
} from "./webcamCaptureTarget";

const COUNTDOWN_SEC = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cameraMimeType(): string {
	const preferred = ["video/webm;codecs=h264", "video/webm;codecs=vp9", "video/webm"];
	return preferred.find((type) => MediaRecorder.isTypeSupported(type)) ?? "video/webm";
}

/** On a Mac with the native helper, the take is recorded there (1.2.0); the browser otherwise. */
async function nativeCameraTakeAvailable(): Promise<boolean> {
	try {
		if (window.electronAPI.getPlatform() !== "darwin") return false;
		const availability = await window.electronAPI.isNativeMacCaptureAvailable();
		return Boolean(availability.success && availability.available);
	} catch {
		return false;
	}
}

/** The helper's request for a talking-head take: the camera and the microphone, no screen. */
export function nativeCameraTakeRequest(options: {
	recordingId: number;
	webcamDeviceId?: string;
	webcamDeviceName?: string;
	webcamQuality: Parameters<typeof webcamVideoConstraints>[1];
	microphoneEnabled: boolean;
	microphoneDeviceId?: string;
	microphoneDeviceName?: string;
	microphoneGainDb?: number;
}): NativeMacRecordingRequest {
	const preset = webcamPresetFor(options.webcamQuality);
	return {
		schemaVersion: 1,
		recordingId: options.recordingId,
		source: { type: "camera", sourceId: "camera" },
		video: { fps: WEBCAM_TARGET_FRAME_RATE, width: 0, height: 0, hideSystemCursor: false },
		audio: {
			system: { enabled: false },
			microphone: {
				enabled: options.microphoneEnabled,
				...(options.microphoneDeviceId ? { deviceId: options.microphoneDeviceId } : {}),
				...(options.microphoneDeviceName ? { deviceName: options.microphoneDeviceName } : {}),
				gain: nativeMicrophoneGain(false, options.microphoneGainDb ?? 0),
			},
		},
		webcam: {
			enabled: true,
			...(options.webcamDeviceId ? { deviceId: options.webcamDeviceId } : {}),
			...(options.webcamDeviceName ? { deviceName: options.webcamDeviceName } : {}),
			width: preset.width,
			height: preset.height,
			fps: WEBCAM_TARGET_FRAME_RATE,
		},
		cursor: { mode: "system" },
		outputs: { screenPath: "" },
	};
}

type CameraTake =
	| { kind: "browser"; handle: RecorderHandle; stream: MediaStream; id: number; startedAt: number }
	| { kind: "native"; id: number; startedAt: number };

/**
 * A take of the camera and the microphone with no screen in it, for talking to the lens. The camera
 * file is the take's video, so the editor treats it like any recording, and the teleprompter's
 * segments split it the same way.
 *
 * 1.2.0: on a Mac the native helper records it, HEVC Main 10 at 50 Mbps and a constant 30 fps in a
 * `.mov`, with the microphone as a 48 kHz 24-bit WAV beside it. The browser's MediaRecorder (H.264,
 * variable frame rate) stays for where the helper is not there.
 */
export function useCameraOnlyTake(options: {
	webcamDeviceId?: string;
	webcamDeviceName?: string;
	webcamQuality: Parameters<typeof webcamVideoConstraints>[1];
	microphoneEnabled: boolean;
	microphoneDeviceId?: string;
	microphoneDeviceName?: string;
	/** The helper could not record and the browser records this take instead (standard quality). */
	onBrowserFallback?: () => void;
}) {
	const {
		webcamDeviceId,
		webcamDeviceName,
		webcamQuality,
		microphoneEnabled,
		microphoneDeviceId,
		microphoneDeviceName,
	} = options;
	const [active, setActive] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
	const take = useRef<CameraTake | null>(null);
	const starting = useRef(false);

	const start = useCallback(async () => {
		if (starting.current || take.current) return;
		starting.current = true;
		setError(null);
		let stream: MediaStream | null = null;
		let countedDown = false;
		try {
			if (await nativeCameraTakeAvailable()) {
				const id = Date.now();
				// The helper starts during the countdown, held: the camera wakes up and settles its
				// exposure by zero, and nothing is written until then (started after the countdown,
				// the first words were lost; started unheld, its first dark frames opened the take).
				// Zero releases it, so the take and the app (the teleprompter) start there together.
				const starting = window.electronAPI
					.startNativeMacRecording({
						...nativeCameraTakeRequest({
							recordingId: id,
							webcamDeviceId,
							webcamDeviceName,
							webcamQuality,
							microphoneEnabled,
							microphoneDeviceId,
							microphoneDeviceName,
						}),
						deferAppRecording: true,
						holdUntilResume: true,
					})
					.catch((cause: unknown) => ({
						success: false as const,
						recordingId: undefined,
						error: cause instanceof Error ? cause.message : String(cause),
					}));
				let released = false;
				try {
					await window.electronAPI.showCountdownOverlay(COUNTDOWN_SEC, id);
					for (let value = COUNTDOWN_SEC; value > 0; value -= 1) {
						await window.electronAPI.setCountdownOverlayValue(value, id);
						await sleep(1000);
					}
					await window.electronAPI.hideCountdownOverlay(id);
					await window.electronAPI.releaseNativeMacHold(false, id);
					released = true;
				} finally {
					// A countdown that failed drops the held take, or it keeps the camera.
					if (!released) void window.electronAPI.releaseNativeMacHold(true, id);
				}
				const result = await starting;
				if (result.success && result.recordingId) {
					await window.electronAPI.setRecordingState(true, result.recordingId, "system");
					take.current = { kind: "native", id: result.recordingId, startedAt: performance.now() };
					setActive(true);
					return;
				}
				// The helper could not record: the browser records this take, as before 1.2.0.
				console.warn("[camera-take] native take failed; recording in the browser:", result.error);
				options.onBrowserFallback?.();
				countedDown = true;
			}
			stream = await navigator.mediaDevices.getUserMedia({
				video: webcamVideoConstraints(webcamDeviceId, webcamQuality),
				// As in a screen take: the voice as it is, cleaned up in the edit if at all.
				audio: microphoneEnabled
					? {
							...(microphoneDeviceId ? { deviceId: { exact: microphoneDeviceId } } : {}),
							echoCancellation: false,
							noiseSuppression: false,
							autoGainControl: false,
						}
					: false,
			});
			const id = Date.now();
			if (!countedDown) {
				await window.electronAPI.showCountdownOverlay(COUNTDOWN_SEC, id);
				for (let value = COUNTDOWN_SEC; value > 0; value -= 1) {
					await window.electronAPI.setCountdownOverlayValue(value, id);
					await sleep(1000);
				}
				await window.electronAPI.hideCountdownOverlay(id);
			}
			const handle = createRecorderHandle(
				stream,
				{ mimeType: cameraMimeType(), videoBitsPerSecond: webcamBitrateForStream(stream) },
				`recording-${id}.webm`,
			);
			take.current = { kind: "browser", handle, stream, id, startedAt: performance.now() };
			// "system": no pointer to record and draw over a face.
			await window.electronAPI.setRecordingState(true, id, "system");
			setActive(true);
		} catch (cause) {
			for (const track of stream?.getTracks() ?? []) track.stop();
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			starting.current = false;
		}
	}, [
		webcamDeviceId,
		webcamDeviceName,
		webcamQuality,
		microphoneEnabled,
		microphoneDeviceId,
		microphoneDeviceName,
	]);

	const stop = useCallback(async () => {
		const current = take.current;
		if (!current) return;
		take.current = null;
		setSaving(true);
		const durationMs = performance.now() - current.startedAt;
		if (current.kind === "native") {
			try {
				const result = await window.electronAPI.stopNativeMacRecording(false);
				if (!result.success) throw new Error(result.error ?? "The take could not be saved");
				if (result.warning) console.warn("[camera-take]", result.warning);
				if (result.session) await window.electronAPI.setCurrentRecordingSession(result.session);
				else if (result.path) await window.electronAPI.setCurrentVideoPath(result.path);
				setActive(false);
				await window.electronAPI.switchToEditor();
			} catch (cause) {
				setActive(false);
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setSaving(false);
			}
			return;
		}
		try {
			if (current.handle.recorder.state !== "inactive") current.handle.recorder.stop();
			const blob = await current.handle.recordedBlobPromise;
			for (const track of current.stream.getTracks()) track.stop();
			await window.electronAPI.setRecordingState(false, current.id);
			const result = await window.electronAPI.storeRecordedSession({
				screen: {
					// Streamed to disk unless that failed, in which case the blob holds it all.
					videoData: current.handle.isStreaming() ? new ArrayBuffer(0) : await blob.arrayBuffer(),
					fileName: `recording-${current.id}.webm`,
				},
				createdAt: current.id,
				cursorCaptureMode: "system",
				durationMs,
			});
			if (!result.success) throw new Error(result.message ?? "The take could not be saved");
			if (result.session) await window.electronAPI.setCurrentRecordingSession(result.session);
			else if (result.path) await window.electronAPI.setCurrentVideoPath(result.path);
			setActive(false);
			await window.electronAPI.switchToEditor();
		} catch (cause) {
			setActive(false);
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	}, []);

	useEffect(() => {
		if (!active) return;
		setElapsedSeconds(0);
		const timer = setInterval(() => {
			if (take.current)
				setElapsedSeconds(Math.floor((performance.now() - take.current.startedAt) / 1000));
		}, 500);
		return () => clearInterval(timer);
	}, [active]);

	// The tray's Stop ends this take like any other.
	useEffect(() => {
		return window.electronAPI?.onStopRecordingFromTray?.(() => {
			if (take.current) void stop();
		});
	}, [stop]);

	return { active, saving, error, elapsedSeconds, start, stop };
}
