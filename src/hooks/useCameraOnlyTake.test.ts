import { describe, expect, it } from "vitest";
import { nativeCameraTakeRequest } from "./useCameraOnlyTake";

describe("nativeCameraTakeRequest", () => {
	it("asks the helper for the camera and the microphone, no screen, at unity", () => {
		const request = nativeCameraTakeRequest({
			recordingId: 42,
			webcamDeviceId: "chromium-hash",
			webcamDeviceName: "Elgato Facecam",
			webcamQuality: "2160p",
			microphoneEnabled: true,
			microphoneDeviceName: "Shure MV7",
		});
		expect(request.source).toEqual({ type: "camera", sourceId: "camera" });
		expect(request.audio.system.enabled).toBe(false);
		expect(request.audio.microphone).toMatchObject({
			enabled: true,
			deviceName: "Shure MV7",
			gain: 1,
		});
		expect(request.webcam).toMatchObject({
			enabled: true,
			deviceName: "Elgato Facecam",
			width: 3840,
			height: 2160,
			fps: 30,
		});
		expect(request.cursor.mode).toBe("system");
	});
});
