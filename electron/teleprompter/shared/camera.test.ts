import { describe, expect, it } from "vitest";
import {
	cameraNameMatches,
	cameraPreviewDisplay,
	cameraPreviewMessage,
	isFullscreenOnOtherDisplay,
	previewStartsSession,
	prompterCameraName,
	showsCameraBehindText,
	stripCameraSuffix,
} from "./camera";

describe("cameraNameMatches", () => {
	it("ignores Chromium's trailing (vid:pid)", () => {
		expect(cameraNameMatches("Lyra-CAM_3UXH (3547:0b05)", "Lyra-CAM_3UXH")).toBe(true);
		expect(stripCameraSuffix("FaceTime HD Camera (05AC:8514)")).toBe("FaceTime HD Camera");
	});

	it("is case-insensitive and ignores outer spaces", () => {
		expect(cameraNameMatches("  facetime hd camera ", "FaceTime HD Camera")).toBe(true);
	});

	it("keeps other parentheses and tells cameras apart", () => {
		expect(cameraNameMatches("Cam (2)", "Cam")).toBe(false);
		expect(cameraNameMatches("Cam A (1234:abcd)", "Cam B")).toBe(false);
		expect(cameraNameMatches("", "")).toBe(false);
	});
});

describe("prompterCameraName", () => {
	it("is null while the camera is off or unnamed", () => {
		expect(prompterCameraName({ camEnabled: false, camDeviceName: "Cam" })).toBeNull();
		expect(prompterCameraName({ camEnabled: true, camDeviceName: null })).toBeNull();
		expect(prompterCameraName({ camEnabled: true, camDeviceName: "  " })).toBeNull();
		expect(prompterCameraName({ camEnabled: true, camDeviceName: "Cam (1:2)" })).toBe("Cam (1:2)");
	});
});

describe("show only on another display in full screen", () => {
	const MAIN = 1;
	const PROMPTER = 7;
	it("needs a full-screen prompter on a display that is not the primary one", () => {
		expect(isFullscreenOnOtherDisplay({ position: "fullscreen", displayId: PROMPTER }, MAIN)).toBe(
			true,
		);
		expect(isFullscreenOnOtherDisplay({ position: "fullscreen", displayId: MAIN }, MAIN)).toBe(
			false,
		);
		expect(isFullscreenOnOtherDisplay({ position: "fullscreen", displayId: null }, MAIN)).toBe(
			false,
		);
		for (const position of ["screen"] as const) {
			expect(isFullscreenOnOtherDisplay({ position, displayId: PROMPTER }, MAIN)).toBe(false);
		}
	});

	it("also needs an opacity above zero and a camera", () => {
		const on = { position: "fullscreen", displayId: PROMPTER, cameraOpacity: 0.4 } as const;
		expect(showsCameraBehindText(on, MAIN, "Cam")).toBe(true);
		expect(showsCameraBehindText({ ...on, cameraOpacity: 0 }, MAIN, "Cam")).toBe(false);
		expect(showsCameraBehindText(on, MAIN, null)).toBe(false);
		expect(showsCameraBehindText({ ...on, displayId: MAIN }, MAIN, "Cam")).toBe(false);
	});
});

describe("cameraPreviewMessage", () => {
	it("is the contract the helper reads, with the display as a string", () => {
		expect(
			cameraPreviewMessage({ enabled: true, displayId: 7 }, "FaceTime HD Camera", true),
		).toEqual({
			type: "cameraPreview.set",
			enabled: true,
			displayId: "7",
			cameraName: "FaceTime HD Camera",
			mirror: true,
		});
	});

	it("is disabled while the app's camera is off or none is chosen", () => {
		expect(cameraPreviewMessage({ enabled: true, displayId: 7 }, null, false).enabled).toBe(false);
	});

	it("is disabled with no display to show it on", () => {
		const msg = cameraPreviewMessage({ enabled: true, displayId: null }, "Cam", false);
		expect(msg.enabled).toBe(false);
		expect(msg.displayId).toBeNull();
	});

	it("is disabled when the switch is off, and keeps a null display as null", () => {
		const msg = cameraPreviewMessage({ enabled: false, displayId: null }, "Cam", false);
		expect(msg.enabled).toBe(false);
		expect(msg.displayId).toBeNull();
	});
});

describe("cameraPreviewDisplay", () => {
	const MAIN = 1;
	it("keeps a saved display that is still connected and is not the main one", () => {
		expect(cameraPreviewDisplay(3, [1, 2, 3], MAIN)).toBe(3);
	});

	it("falls to the other display when the saved one is gone or is the main one", () => {
		expect(cameraPreviewDisplay(9, [1, 2], MAIN)).toBe(2);
		expect(cameraPreviewDisplay(1, [1, 2], MAIN)).toBe(2);
		expect(cameraPreviewDisplay(null, [1, 2], MAIN)).toBe(2);
	});

	it("never falls back to the main display", () => {
		expect(cameraPreviewDisplay(null, [1], MAIN)).toBeNull();
		expect(cameraPreviewDisplay(2, [1], MAIN)).toBeNull();
	});
});

describe("previewStartsSession", () => {
	const on = cameraPreviewMessage({ enabled: true, displayId: 2 }, "Cam", false);
	const off = cameraPreviewMessage({ enabled: false, displayId: 2 }, "Cam", false);

	it("is true when the camera goes from closed to open, or to another camera", () => {
		expect(previewStartsSession(on, null)).toBe(true);
		expect(previewStartsSession(on, off)).toBe(true);
		expect(previewStartsSession({ ...on, cameraName: "Other" }, on)).toBe(true);
	});

	it("is false for turning it off and for changes to a camera that is already open", () => {
		expect(previewStartsSession(off, on)).toBe(false);
		expect(previewStartsSession({ ...on, mirror: true }, on)).toBe(false);
	});
});
