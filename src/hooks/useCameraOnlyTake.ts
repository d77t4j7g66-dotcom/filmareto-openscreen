import { useCallback, useEffect, useRef, useState } from "react";
import { createRecorderHandle, type RecorderHandle } from "./recorderHandle";
import { webcamBitrateForStream, webcamVideoConstraints } from "./webcamCaptureTarget";

const COUNTDOWN_SEC = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cameraMimeType(): string {
	const preferred = ["video/webm;codecs=h264", "video/webm;codecs=vp9", "video/webm"];
	return preferred.find((type) => MediaRecorder.isTypeSupported(type)) ?? "video/webm";
}

/**
 * A take of the camera and the microphone with no screen in it, for talking to the lens. The camera
 * file is the take's video, so the editor treats it like any recording, and the teleprompter's
 * segments split it the same way.
 */
export function useCameraOnlyTake(options: {
	webcamDeviceId?: string;
	webcamQuality: Parameters<typeof webcamVideoConstraints>[1];
	microphoneEnabled: boolean;
	microphoneDeviceId?: string;
}) {
	const { webcamDeviceId, webcamQuality, microphoneEnabled, microphoneDeviceId } = options;
	const [active, setActive] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
	const take = useRef<{
		handle: RecorderHandle;
		stream: MediaStream;
		id: number;
		startedAt: number;
	} | null>(null);
	const starting = useRef(false);

	const start = useCallback(async () => {
		if (starting.current || take.current) return;
		starting.current = true;
		setError(null);
		let stream: MediaStream | null = null;
		try {
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
			await window.electronAPI.showCountdownOverlay(COUNTDOWN_SEC, id);
			for (let value = COUNTDOWN_SEC; value > 0; value -= 1) {
				await window.electronAPI.setCountdownOverlayValue(value, id);
				await sleep(1000);
			}
			await window.electronAPI.hideCountdownOverlay(id);
			const handle = createRecorderHandle(
				stream,
				{ mimeType: cameraMimeType(), videoBitsPerSecond: webcamBitrateForStream(stream) },
				`recording-${id}.webm`,
			);
			take.current = { handle, stream, id, startedAt: performance.now() };
			// "system": no pointer to record and draw over a face.
			await window.electronAPI.setRecordingState(true, id, "system");
			setActive(true);
		} catch (cause) {
			for (const track of stream?.getTracks() ?? []) track.stop();
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			starting.current = false;
		}
	}, [webcamDeviceId, webcamQuality, microphoneEnabled, microphoneDeviceId]);

	const stop = useCallback(async () => {
		const current = take.current;
		if (!current) return;
		take.current = null;
		setSaving(true);
		const durationMs = performance.now() - current.startedAt;
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
