import { describe, expect, it } from "vitest";
import { getEditorSettings, webcamPresetForFormat } from "../store/editorSettings";
import { sceneForFormat, scenesForFormat } from "./scenes";

describe("layouts by format", () => {
	it("offers stacked boxes in a tall frame and side by side in a wide one", () => {
		expect(scenesForFormat(true)).toContain("vertical-stack");
		expect(scenesForFormat(true)).not.toContain("dual-frame");
		expect(scenesForFormat(false)).toContain("dual-frame");
		expect(scenesForFormat(false)).not.toContain("vertical-stack");
	});

	it("carries a clip's two-box layout across a change of format", () => {
		expect(sceneForFormat("vertical-stack", false)).toBe("dual-frame");
		expect(sceneForFormat("dual-frame", true)).toBe("vertical-stack");
		expect(sceneForFormat("screen", true)).toBe("screen");
		expect(sceneForFormat("vertical-stack", true)).toBe("vertical-stack");
	});
});

describe("the project's layout by format", () => {
	it("keeps what a tall frame can show, and swaps side by side for stacked", () => {
		expect(webcamPresetForFormat("cutout-stack", "9:16")).toBe("cutout-stack");
		expect(webcamPresetForFormat("dual-frame", "9:16")).toBe("vertical-stack");
	});

	it("gives a wide frame a layout made for it", () => {
		expect(webcamPresetForFormat("cutout-stack", "16:9")).toBe("picture-in-picture");
		expect(webcamPresetForFormat("vertical-stack", "16:9")).toBe("dual-frame");
		expect(webcamPresetForFormat("free-layout", "16:9")).toBe("free-layout");
		expect(webcamPresetForFormat("cutout-stack", "1:1")).toBe("picture-in-picture");
	});

	it("leaves Auto alone: it takes its shape from the layout", () => {
		expect(webcamPresetForFormat("cutout-stack", "auto")).toBe("cutout-stack");
	});

	it("brings the stored choice back when the format returns", () => {
		const doc = (aspectRatio: string) =>
			({ legacyEditor: { aspectRatio, webcamLayoutPreset: "cutout-stack" } }) as never;
		expect(getEditorSettings(doc("16:9")).webcamLayoutPreset).toBe("picture-in-picture");
		expect(getEditorSettings(doc("9:16")).webcamLayoutPreset).toBe("cutout-stack");
	});
});
