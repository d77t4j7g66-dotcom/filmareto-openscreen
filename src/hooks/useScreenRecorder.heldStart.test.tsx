// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];

const SOURCE = { id: "screen:0:0", name: "Screen 1", display_id: "1", thumbnail: "" };

let api: Record<string, ReturnType<typeof vi.fn>>;

function fakeCameraStream() {
	const track = {
		kind: "video",
		label: "Studio camera",
		onended: null,
		stop: vi.fn(),
		getSettings: () => ({ deviceId: "camera-1" }),
	};
	return {
		getTracks: () => [track],
		getVideoTracks: () => [track],
		getAudioTracks: () => [],
	};
}

function stubElectronAPI(camEnabled: boolean) {
	api = {
		getRecordingPrefs: vi.fn(async () => ({
			micEnabled: false,
			camEnabled,
			camDeviceId: null,
			systemAudioEnabled: false,
			cursorCaptureMode: "system",
		})),
		setRecordingPrefs: vi.fn(async () => undefined),
		getPlatform: vi.fn(() => "darwin"),
		getSystemVersion: vi.fn(() => "15.5"),
		getSelectedSource: vi.fn(async () => SOURCE),
		isNativeMacCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		startNativeMacRecording: vi.fn(async () => ({
			success: true,
			recordingId: 7,
			webcamNative: true,
		})),
		releaseNativeMacHold: vi.fn(async () => ({ success: true })),
		onNativeMacSystemAudioUnavailable: vi.fn(() => vi.fn()),
		stopNativeMacRecording: vi.fn(async () => ({ success: true, discarded: true })),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
	};
	window.electronAPI = api as unknown as ElectronAPI;
	Object.defineProperty(window.electronAPI, "permissions", {
		value: { openSettings: vi.fn(async () => undefined) },
	});
}

async function settle(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: {
			getUserMedia: vi.fn(async () => fakeCameraStream()),
			enumerateDevices: vi.fn(async () => []),
		},
	});
});

afterEach(() => {
	Reflect.deleteProperty(navigator, "mediaDevices");
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function startCountdown() {
	const view = renderHook(() => useScreenRecorder());
	await settle();
	await act(async () => {
		view.result.current.toggleRecording();
	});
	return view;
}

// A camera opened at zero recorded its own wake-up: the first second of the take faded in from
// black. A take with the camera now starts during the countdown, held, and zero releases it.
describe("useScreenRecorder held macOS start", () => {
	it("opens a take with the camera during the countdown and starts it at zero", async () => {
		stubElectronAPI(true);
		const view = await startCountdown();
		await settle(500);

		expect(api.startNativeMacRecording).toHaveBeenCalledOnce();
		expect(api.startNativeMacRecording).toHaveBeenCalledWith(
			expect.objectContaining({
				holdUntilResume: true,
				webcam: expect.objectContaining({ enabled: true }),
			}),
		);
		expect(api.releaseNativeMacHold).not.toHaveBeenCalled();
		expect(view.result.current.recording).toBe(false);

		await settle(3_500);

		expect(api.releaseNativeMacHold).toHaveBeenCalledOnce();
		const { recordingId } = api.startNativeMacRecording.mock.calls[0][0];
		expect(api.releaseNativeMacHold).toHaveBeenCalledWith(false, recordingId);
		// The countdown is off the screen before the take starts.
		expect(api.hideCountdownOverlay.mock.invocationCallOrder.at(-1)).toBeLessThan(
			api.releaseNativeMacHold.mock.invocationCallOrder[0],
		);
		expect(api.startNativeMacRecording).toHaveBeenCalledOnce();
		expect(view.result.current.recording).toBe(true);
	});

	it("drops the held take when the countdown is cancelled", async () => {
		stubElectronAPI(true);
		const view = await startCountdown();
		await settle(1_000);
		expect(api.startNativeMacRecording).toHaveBeenCalledOnce();

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle();

		// At once, not at the countdown's next tick: the camera is let go now.
		const { recordingId } = api.startNativeMacRecording.mock.calls[0][0];
		expect(api.releaseNativeMacHold).toHaveBeenCalledWith(true, recordingId);

		await settle(3_500);
		expect(api.releaseNativeMacHold).not.toHaveBeenCalledWith(false, expect.anything());
		// The mock's start had already succeeded, as a release racing the cancel would: dropped.
		expect(api.stopNativeMacRecording).toHaveBeenCalledWith(true);
		expect(view.result.current.recording).toBe(false);
	});

	it("starts at zero the old way when the held start failed", async () => {
		stubElectronAPI(true);
		api.startNativeMacRecording.mockResolvedValueOnce({
			success: false,
			error: "The camera sent no frame",
		});
		const view = await startCountdown();
		await settle(4_000);

		expect(api.startNativeMacRecording).toHaveBeenCalledTimes(2);
		expect(api.startNativeMacRecording.mock.calls[0][0].holdUntilResume).toBe(true);
		expect(api.startNativeMacRecording.mock.calls[1][0].holdUntilResume).toBeUndefined();
		expect(view.result.current.recording).toBe(true);
	});

	it("keeps a take without the camera as it was: started at zero, never held", async () => {
		stubElectronAPI(false);
		const view = await startCountdown();
		await settle(1_000);
		expect(api.startNativeMacRecording).not.toHaveBeenCalled();

		await settle(3_000);

		expect(api.startNativeMacRecording).toHaveBeenCalledOnce();
		expect(api.startNativeMacRecording.mock.calls[0][0].holdUntilResume).toBeUndefined();
		expect(api.releaseNativeMacHold).not.toHaveBeenCalled();
		expect(view.result.current.recording).toBe(true);
	});
});
