// @vitest-environment jsdom
// "Frame position" places the cut of the camera by hand, in the camera pane (1.2.0 Beta feedback:
// in a screen take it used to move the screen under a full-screen camera). A talking head's take
// IS the camera, so there it places the take's own cut (`fillPosition`) while the format is
// filled; in a 9:16 screen take it places the camera's cut (`webcamCoverPan`, or the crop's pan
// once the crop is zoomed) and never the screen's. It writes the project setting, or the look of
// the clip under the playhead, and leaves Auto as the way back where there is one. The format
// menu no longer has it. The camera crop of the vertical layouts stays in the same pane.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { FormatField, LayoutPane } from "./RightPanes";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock("@/native/hooks/useSegmentationSupport", () => ({ useCanSegmentCamera: () => false }));

const clip = (id: string, start: number) => ({
	id,
	assetId: "a1",
	sourceStartSec: 0,
	sourceEndSec: 5,
	timelineStartSec: start,
	timelineEndSec: start + 5,
	wordRefs: [],
	origin: "user" as const,
	reason: "",
});

interface TakeOptions {
	clips?: number;
	width?: number;
	height?: number;
	/** A screen take with its camera beside it. */
	camera?: boolean;
	/** A take looked at for a face: no pointer in it, so a talking head when it has no camera. */
	face?: { x: number; y: number } | null;
}

function take(editor: Record<string, unknown>, opts: TakeOptions = {}): AxcutDocument {
	const base = createEmptyDocument({ title: "T", projectId: "p1" });
	const { clips = 1, width = 1920, height = 1080, camera = false } = opts;
	return {
		...base,
		assets: [
			{
				kind: "video",
				id: "a1",
				label: "a1",
				originalPath: "/a1.mp4",
				cameraTrack: camera
					? {
							sourcePath: "/cam.mp4",
							startMs: 0,
							offsetMs: 0,
							visible: true,
							width: 1920,
							height: 1080,
						}
					: null,
				...("face" in opts ? { face: opts.face } : {}),
				video: { codec: "h264", width, height, fps: 30 },
			},
		],
		timeline: {
			...base.timeline,
			clips: Array.from({ length: clips }, (_, i) => clip(`c${i + 1}`, i * 5)),
		},
		legacyEditor: editor,
	} as unknown as AxcutDocument;
}

/** A talking head: the camera alone, looked at for a face. */
const head = (editor: Record<string, unknown>, opts: TakeOptions = {}) =>
	take(editor, { face: { x: 0.5, y: 0.4 }, ...opts });
/** A screen take with its camera beside it (no face: it has a pointer). */
const screenWithCamera = (editor: Record<string, unknown>, opts: TakeOptions = {}) =>
	take(editor, { camera: true, ...opts });

function mount(doc: AxcutDocument, ui: React.ReactNode = <LayoutPane />) {
	useProjectStore.setState({
		document: doc,
		projectId: doc.project.id,
		revision: 1,
		status: "ready",
		currentTimeSec: 0,
	});
	render(<I18nProvider>{ui}</I18nProvider>);
}

const editor = () =>
	(useProjectStore.getState().document?.legacyEditor ?? {}) as Record<string, unknown>;
const lookOf = (id: string) =>
	useProjectStore.getState().document?.timeline.clips.find((c) => c.id === id)?.look as
		| Record<string, unknown>
		| undefined;

/** The Auto switch of the frame position: a switch has no text, the "Auto" choices of rows do. */
const autoToggle = () => {
	const toggle = screen
		.queryAllByRole("button", { name: "Auto" })
		.find((button) => button.textContent === "");
	if (!toggle) throw new Error("no Auto switch");
	return toggle;
};
const horizontal = () => screen.getByRole("slider", { name: /Left to right/ });

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem(LOCALE_STORAGE_KEY, "en");
	useProjectStore.setState({ document: null });
});
afterEach(() => {
	cleanup();
	localStorage.clear();
	useProjectStore.getState().clear();
});

describe("frame position leaves the format menu", () => {
	it("is not under the format any more, for any take", () => {
		for (const doc of [
			head({ aspectRatio: "9:16", formatFollowCursor: true }),
			screenWithCamera({ aspectRatio: "9:16", formatFollowCursor: true }),
			take({ aspectRatio: "9:16", formatFollowCursor: true }),
		]) {
			mount(doc, <FormatField />);
			// The fill choice stays: only the hand-placed cut went to the camera.
			expect(screen.getByRole("group", { name: "Recording" })).toBeInTheDocument();
			expect(screen.queryByText("Frame position")).not.toBeInTheDocument();
			cleanup();
		}
	});
});

describe("frame position of a talking head, in the camera pane", () => {
	it("is offered only while the format is filled", () => {
		// Filled: a 16:9 take in 9:16, following the cursor.
		mount(head({ aspectRatio: "9:16", formatFollowCursor: true }));
		expect(screen.getByText("Frame position")).toBeInTheDocument();
		// The camera alone: nothing else of the camera pane applies to it.
		expect(screen.queryByText("Webcam crop")).not.toBeInTheDocument();
		expect(screen.queryByText("Preset")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Help" }));
		expect(screen.getByRole("note")).toHaveTextContent(/This take is your camera alone/);
		cleanup();
		// The recording shown whole: nothing to place.
		mount(head({ aspectRatio: "9:16", formatFollowCursor: false }));
		expect(screen.queryByText("Frame position")).not.toBeInTheDocument();
		cleanup();
		// A format that is the recording's own shape.
		mount(head({ aspectRatio: "16:9", formatFollowCursor: true }));
		expect(screen.queryByText("Frame position")).not.toBeInTheDocument();
	});

	it("starts on Auto and writes nothing until the toggle is turned off", () => {
		mount(head({ aspectRatio: "9:16", formatFollowCursor: true }));
		expect(autoToggle()).toHaveAttribute("aria-pressed", "true");
		expect(screen.queryByRole("slider", { name: /Left to right/ })).not.toBeInTheDocument();
		expect(editor().fillPosition).toBeUndefined();
	});

	it("places the cut across a 16:9 take, and only across it", async () => {
		mount(head({ aspectRatio: "9:16", formatFollowCursor: true }, { face: null }));
		fireEvent.click(autoToggle());
		await vi.waitFor(() => expect(editor().fillPosition).toEqual({ x: 0.5, y: 0.5 }));
		// The cut is full height, so there is nothing to move vertically.
		expect(screen.queryByRole("slider", { name: /Top to bottom/ })).not.toBeInTheDocument();
		// The slider covers the travel of the cut: a 9:16 window is 0.316 of a 16:9 picture wide,
		// so its centre goes from 0.158 to 0.842.
		fireEvent.change(horizontal(), { target: { value: "0" } });
		expect((editor().fillPosition as { x: number }).x).toBeCloseTo(0.158, 3);
		fireEvent.change(horizontal(), { target: { value: "100" } });
		expect((editor().fillPosition as { x: number }).x).toBeCloseTo(0.842, 3);
		// Back to Auto: null, which the scene reads as follow.
		fireEvent.click(autoToggle());
		await vi.waitFor(() => expect(editor().fillPosition).toBeNull());
		expect(screen.queryByRole("slider", { name: /Left to right/ })).not.toBeInTheDocument();
		// Nothing of the camera's own crop was touched.
		expect(editor().webcamCoverPan).toBeUndefined();
	});

	it("starts on the face when Auto is turned off", async () => {
		mount(head({ aspectRatio: "9:16", formatFollowCursor: true }, { face: { x: 0.7, y: 0.4 } }));
		fireEvent.click(autoToggle());
		await vi.waitFor(() => expect(editor().fillPosition).toEqual({ x: 0.7, y: 0.5 }));
	});

	it("moves vertically when the cut is shorter than the recording", () => {
		// A portrait take in a 16:9 frame: the window is full width and short.
		mount(
			head(
				{ aspectRatio: "16:9", formatFollowCursor: true, fillPosition: { x: 0.5, y: 0.3 } },
				{ width: 1080, height: 1920 },
			),
		);
		expect(screen.getByRole("slider", { name: /Top to bottom/ })).toBeInTheDocument();
		expect(screen.queryByRole("slider", { name: /Left to right/ })).not.toBeInTheDocument();
	});

	it("writes the project by default, and the clip under the playhead when asked", async () => {
		mount(
			head(
				{ aspectRatio: "9:16", formatFollowCursor: true, fillPosition: { x: 0.5, y: 0.5 } },
				{ clips: 2 },
			),
		);
		const scope = screen.getByRole("group", { name: "Apply to" });
		expect(within(scope).getByRole("button", { name: "Whole project" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		fireEvent.change(horizontal(), { target: { value: "100" } });
		expect((editor().fillPosition as { x: number }).x).toBeCloseTo(0.842, 3);
		expect(lookOf("c1")).toBeUndefined();
		// This clip: the project's position and the other clip are left as they were.
		fireEvent.click(within(scope).getByRole("button", { name: "This clip" }));
		fireEvent.change(horizontal(), { target: { value: "0" } });
		expect((lookOf("c1")?.fillPosition as { x: number }).x).toBeCloseTo(0.158, 3);
		expect((editor().fillPosition as { x: number }).x).toBeCloseTo(0.842, 3);
		expect(lookOf("c2")).toBeUndefined();
		// Auto for this clip alone, while the project keeps its position.
		fireEvent.click(autoToggle());
		await vi.waitFor(() => expect(lookOf("c1")?.fillPosition).toBeNull());
		expect((editor().fillPosition as { x: number }).x).toBeCloseTo(0.842, 3);
	});

	it("has no target choice for a single clip", () => {
		mount(head({ aspectRatio: "9:16", formatFollowCursor: true }));
		expect(screen.queryByRole("group", { name: "Apply to" })).not.toBeInTheDocument();
	});

	it("says how many clips have their own position, and gives them the project's back", async () => {
		mount(
			head(
				{ aspectRatio: "9:16", formatFollowCursor: true, fillPosition: { x: 0.3, y: 0.5 } },
				{ clips: 2 },
			),
		);
		expect(screen.queryByText(/have their own position/)).not.toBeInTheDocument();
		fireEvent.click(
			within(screen.getByRole("group", { name: "Apply to" })).getByRole("button", {
				name: "This clip",
			}),
		);
		fireEvent.change(horizontal(), { target: { value: "10" } });
		expect(screen.getByText("1 clip has its own position")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Use project position" }));
		await vi.waitFor(() => expect(lookOf("c1")).toBeUndefined());
		expect(editor().fillPosition).toEqual({ x: 0.3, y: 0.5 });
		expect(screen.queryByText(/own position/)).not.toBeInTheDocument();
	});

	it("is not offered for a take not looked at yet, or a screen recording with no camera", () => {
		// No face key: a take with a recorded pointer (or one still being looked at) is a screen.
		mount(
			take({ aspectRatio: "9:16", formatFollowCursor: true, fillPosition: { x: 0.2, y: 0.5 } }),
		);
		expect(screen.queryByText("Frame position")).not.toBeInTheDocument();
	});
});

describe("frame position of a screen take's camera", () => {
	it("is offered in a vertical format, filled or not, beside the camera's own controls", () => {
		for (const formatFollowCursor of [true, false]) {
			mount(screenWithCamera({ aspectRatio: "9:16", formatFollowCursor }));
			expect(screen.getByText("Frame position")).toBeInTheDocument();
			expect(screen.getAllByText("Webcam crop").length).toBeGreaterThan(0);
			cleanup();
		}
	});

	it("is not offered where the camera is not cut narrower", () => {
		mount(screenWithCamera({ aspectRatio: "16:9", formatFollowCursor: true }));
		expect(screen.queryByText("Frame position")).not.toBeInTheDocument();
	});

	it("moves the camera, never the screen", async () => {
		mount(
			screenWithCamera({
				aspectRatio: "9:16",
				formatFollowCursor: true,
				webcamLayoutPreset: "picture-in-picture",
			}),
		);
		expect(autoToggle()).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(autoToggle());
		await vi.waitFor(() => expect(editor().webcamCoverPan).toEqual({ x: 0.5, y: 0.5 }));
		// One axis: the camera filling a 9:16 frame is cut narrower, never shorter.
		expect(screen.queryByRole("slider", { name: /Top to bottom/ })).not.toBeInTheDocument();
		// The slider is the pan itself: 0 the left edge of the camera, 100 its right edge.
		fireEvent.change(horizontal(), { target: { value: "20" } });
		expect(editor().webcamCoverPan).toEqual({ x: 0.2, y: 0.5 });
		expect(editor().fillPosition).toBeUndefined();
		// The crop's own pan and rect stay as they were.
		expect(editor().webcamCropPan).toBeUndefined();
		fireEvent.click(autoToggle());
		await vi.waitFor(() => expect(editor().webcamCoverPan).toBeNull());
		expect(editor().fillPosition).toBeUndefined();
	});

	it("runs left to right across the mirrored camera as it is seen", () => {
		mount(
			screenWithCamera({
				aspectRatio: "9:16",
				webcamMirrored: true,
				webcamCoverPan: { x: 0.5, y: 0.5 },
			}),
		);
		fireEvent.change(horizontal(), { target: { value: "20" } });
		expect((editor().webcamCoverPan as { x: number }).x).toBeCloseTo(0.8, 6);
		expect(horizontal()).toHaveValue("20");
	});

	// A clip's own look would switch off the timeline's camera-fullscreen moments, so a screen
	// take's camera is placed for the whole project: no "This clip" for it.
	it("places a screen take's camera for the whole project, with no clip scope", () => {
		mount(
			screenWithCamera({ aspectRatio: "9:16", webcamCoverPan: { x: 0.5, y: 0.5 } }, { clips: 2 }),
		);
		expect(screen.queryByRole("group", { name: "Apply to" })).not.toBeInTheDocument();
		expect(screen.getByText("Places your camera when it fills the frame.")).toBeInTheDocument();
		fireEvent.change(horizontal(), { target: { value: "90" } });
		expect(editor().webcamCoverPan).toEqual({ x: 0.9, y: 0.5 });
		expect(lookOf("c1")).toBeUndefined();
		expect(lookOf("c2")).toBeUndefined();
	});

	it("still lets clips that already have their own camera position follow the project", async () => {
		const doc = screenWithCamera({ aspectRatio: "9:16" }, { clips: 2 });
		const clips = doc.timeline.clips.map((c, i) =>
			i === 0 ? { ...c, look: { webcamCoverPan: { x: 0.9, y: 0.5 } } } : c,
		);
		mount({ ...doc, timeline: { ...doc.timeline, clips } });
		expect(screen.getByText("1 clip has its own position")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Use project position" }));
		await vi.waitFor(() => expect(lookOf("c1")).toBeUndefined());
	});

	it("does not count a screen take's old fixed fillPosition, which the scene ignores", () => {
		const doc = screenWithCamera({ aspectRatio: "9:16" }, { clips: 2 });
		const clips = doc.timeline.clips.map((c, i) =>
			i === 0 ? { ...c, look: { fillPosition: { x: 0.9, y: 0.5 } } } : c,
		);
		mount({ ...doc, timeline: { ...doc.timeline, clips } });
		expect(screen.getByText("Frame position")).toBeInTheDocument();
		expect(screen.queryByText(/own position/)).not.toBeInTheDocument();
	});

	it("leaves a zoomed crop to the Webcam crop framing: no Frame position", () => {
		mount(
			screenWithCamera({
				aspectRatio: "9:16",
				webcamCropRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
				webcamCropPan: { x: 0.5, y: 0.5 },
			}),
		);
		expect(screen.queryByText("Frame position")).not.toBeInTheDocument();
	});
});

describe("camera crop in the vertical layouts", () => {
	it.each([
		"vertical-stack",
		"dual-frame",
		"cutout-stack",
	])("is in the layout pane under %s", (preset) => {
		mount(
			take({ aspectRatio: "9:16", webcamLayoutPreset: preset }, { camera: true }),
			<LayoutPane />,
		);
		expect(screen.getAllByText("Webcam crop").length).toBeGreaterThan(0);
		// At 100% there is no room for the frame, yet the camera is cover-cut to a box that is not
		// its own shape: the pan places that cut, so the control moves.
		expect(screen.getByRole("slider", { name: "Webcam crop" })).toHaveAttribute(
			"data-movable",
			"true",
		);
	});

	it("does not move at 100% under a picture-in-picture that keeps the camera's shape", () => {
		mount(
			take(
				{
					aspectRatio: "9:16",
					webcamLayoutPreset: "picture-in-picture",
					webcamMaskShape: "rectangle",
				},
				{ camera: true },
			),
			<LayoutPane />,
		);
		expect(screen.getByRole("slider", { name: "Webcam crop" })).toHaveAttribute(
			"data-movable",
			"false",
		);
	});

	describe("cover pan", () => {
		const key = (k: string, times = 1) => {
			const frame = screen.getByRole("slider", { name: "Webcam crop" });
			for (let i = 0; i < times; i++) fireEvent.keyDown(frame, { key: k });
		};
		const stored = () => editor() as Record<string, any>;
		const stale = {
			aspectRatio: "9:16",
			webcamLayoutPreset: "vertical-stack",
			webcamCropRegion: { x: 0, y: 0, width: 1, height: 1 },
			webcamCropPan: { x: 0.7, y: 0.3 },
		};

		it("moving the frame at 100% writes the cover pan and leaves the crop pan alone", () => {
			mount(take(stale, { camera: true }), <LayoutPane />);
			key("ArrowRight", 2);
			expect(stored().webcamCoverPan.x).toBeCloseTo(0.6, 6);
			expect(stored().webcamCoverPan.y).toBeCloseTo(0.5, 6);
			expect(stored().webcamCropPan).toEqual({ x: 0.7, y: 0.3 });
		});

		it("moving a frame that has room still writes the crop pan only", () => {
			mount(
				take(
					{ ...stale, webcamCropRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
					{ camera: true },
				),
				<LayoutPane />,
			);
			key("ArrowRight");
			expect(stored().webcamCropPan.x).toBeCloseTo(0.75, 6);
			expect(stored().webcamCoverPan).toBeUndefined();
		});

		it("zooming in and back out restores both pans", () => {
			mount(
				take({ ...stale, webcamCoverPan: { x: 0.6, y: 0.5 } }, { camera: true }),
				<LayoutPane />,
			);
			key("+", 8);
			expect(stored().webcamCropRegion.width).toBeLessThan(1);
			expect(stored().webcamCropPan).toEqual({ x: 0.7, y: 0.3 });
			key("-", 12);
			expect(stored().webcamCropRegion.width).toBe(1);
			expect(stored().webcamCropPan).toEqual({ x: 0.7, y: 0.3 });
			expect(stored().webcamCoverPan).toEqual({ x: 0.6, y: 0.5 });
		});
	});
});
