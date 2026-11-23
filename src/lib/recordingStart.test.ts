import { describe, expect, it } from "vitest";
import {
	launchStartsOnRecord,
	launchStartsOnScript,
	launchWindowQuery,
	RECORDING_KINDS,
	recordingSetupFor,
} from "./recordingStart";

describe("recordingSetupFor", () => {
	it("talking head: camera only, camera on, mic on", () => {
		expect(recordingSetupFor("talking-head")).toEqual({
			cameraOnly: true,
			prefs: { camEnabled: true, micEnabled: true },
		});
	});

	it("screen + camera: screen on, camera on, mic on", () => {
		expect(recordingSetupFor("screen-camera")).toEqual({
			cameraOnly: false,
			prefs: { camEnabled: true, micEnabled: true },
		});
	});

	it("screen only: screen on, camera off, mic on", () => {
		expect(recordingSetupFor("screen-only")).toEqual({
			cameraOnly: false,
			prefs: { camEnabled: false, micEnabled: true },
		});
	});

	it("never leaves a take without sound", () => {
		for (const kind of RECORDING_KINDS) {
			expect(recordingSetupFor(kind).prefs.micEnabled).toBe(true);
		}
	});
});

describe("the launch window", () => {
	it("is recognised from its own query", () => {
		const query = new URLSearchParams({ windowType: "editor", ...launchWindowQuery() });
		expect(launchStartsOnRecord(`?${query.toString()}`)).toBe(true);
	});

	it("is not any other editor window", () => {
		expect(launchStartsOnRecord("?windowType=editor")).toBe(false);
		expect(launchStartsOnRecord("")).toBe(false);
		expect(launchStartsOnRecord("?startOn=edit")).toBe(false);
	});
});

describe("the editor opened by Edit script on the bar", () => {
	it("lands on the Script tab and is not the launch window", () => {
		expect(launchStartsOnScript("?windowType=editor&startOn=script")).toBe(true);
		expect(launchStartsOnRecord("?windowType=editor&startOn=script")).toBe(false);
		expect(launchStartsOnScript("?startOn=record")).toBe(false);
		expect(launchStartsOnScript("")).toBe(false);
	});
});
