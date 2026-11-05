// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
	buildEditorTimeline,
	type EditorTimelineInput,
	editorTimelineExtension,
	fileUrl,
} from "./editorTimeline";

const input: EditorTimelineInput = {
	name: "Tutorial & more",
	fps: 30,
	width: 1080,
	height: 1920,
	durationFrames: 900,
	mainPath: "/Users/me/My Videos/Tutorial_main.mp4",
	overlayPath: "/Users/me/My Videos/Tutorial_overlay.mov",
};

const parse = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");

describe("fileUrl", () => {
	it("escapes spaces and keeps the path", () => {
		expect(fileUrl("/Users/me/My Videos/a b.mp4")).toBe("file:///Users/me/My%20Videos/a%20b.mp4");
		expect(fileUrl("/x/y.mp4", "localhost")).toBe("file://localhost/x/y.mp4");
	});
});

describe("editorTimelineExtension", () => {
	it("is fcpxml for Resolve and xml for Premiere", () => {
		expect(editorTimelineExtension("resolve")).toBe("fcpxml");
		expect(editorTimelineExtension("premiere")).toBe("xml");
	});
});

describe("buildEditorTimeline", () => {
	it("writes a well-formed FCPXML with the overlay on the lane above the main clip", () => {
		const xml = buildEditorTimeline("resolve", input);
		const doc = parse(xml);
		expect(doc.querySelector("parsererror")).toBeNull();
		expect(doc.documentElement.getAttribute("version")).toBe("1.8");
		expect(doc.querySelector("format")?.getAttribute("frameDuration")).toBe("1/30s");
		expect(doc.querySelector("format")?.getAttribute("width")).toBe("1080");
		const main = doc.querySelector("spine > asset-clip");
		expect(main?.getAttribute("duration")).toBe("900/30s");
		expect(main?.querySelector("asset-clip")?.getAttribute("lane")).toBe("1");
		expect(xml).toContain("file:///Users/me/My%20Videos/Tutorial_main.mp4");
		expect(xml).toContain("Tutorial &amp; more");
	});

	it("writes a well-formed xmeml with two video tracks and the main file's audio", () => {
		const xml = buildEditorTimeline("premiere", input);
		const doc = parse(xml);
		expect(doc.querySelector("parsererror")).toBeNull();
		expect(doc.querySelectorAll("video > track").length).toBe(2);
		expect(doc.querySelectorAll("audio > track").length).toBe(2);
		expect(doc.querySelector("sequence > duration")?.textContent).toBe("900");
		expect(xml).toContain("file://localhost/Users/me/My%20Videos/Tutorial_overlay.mov");
	});

	it("leaves the overlay out when the project has none", () => {
		const bare = { ...input, overlayPath: undefined };
		expect(buildEditorTimeline("resolve", bare)).not.toContain("lane=");
		expect(
			parse(buildEditorTimeline("premiere", bare)).querySelectorAll("video > track").length,
		).toBe(1);
	});
});
