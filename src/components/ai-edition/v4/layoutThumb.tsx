import type { SceneChoice } from "@/components/video-editor/types";
import type { EditorSettingsSnapshot } from "@/lib/ai-edition/store/editorSettings";
import {
	computeCompositeLayout,
	paddedContentSize,
	webcamShapeAspect,
} from "@/lib/compositeLayout";
import styles from "./EditorShellV4.module.css";

type Box = { x: number; y: number; width: number; height: number };
export type LayoutBoxes = { screen: Box | null; camera: Box | null; cutout?: boolean };

const THUMB_HEIGHT = 1000;

const boxOf = (rect: Box | null | undefined): Box | null =>
	rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;

/** The real rectangles of a look in this frame, so a drawing changes with the format and the look. */
export function layoutBoxes(
	settings: EditorSettingsSnapshot,
	choice: SceneChoice,
	frame: {
		aspect: number;
		fill: boolean;
		screen: { width: number; height: number };
		camera: { width: number; height: number };
	},
): LayoutBoxes {
	const canvas = { width: THUMB_HEIGHT * frame.aspect, height: THUMB_HEIGHT };
	if (choice === "camera") {
		return { screen: null, camera: { x: 0, y: 0, ...canvas } };
	}
	const preset = choice === "screen" ? ("no-webcam" as const) : choice;
	const maxContentSize = paddedContentSize(
		canvas,
		settings.padding,
		settings.aspectRatio === "auto",
	);
	const layout = computeCompositeLayout({
		canvasSize: canvas,
		maxContentSize,
		screenSize: frame.fill ? maxContentSize : frame.screen,
		webcamSize: preset === "no-webcam" ? null : frame.camera,
		layoutPreset: preset,
		webcamSizePreset: settings.webcamSizePreset,
		webcamAnchor: settings.webcamAnchor,
		webcamAspect: webcamShapeAspect(settings.webcamAspect),
		webcamMaskShape: settings.webcamMaskShape,
		webcamRoundness: settings.webcamRoundness,
		webcamOverlap: settings.webcamOverlap,
		webcamStackSize: settings.webcamStackSize,
		webcamMargin: settings.webcamMargin,
		freeLayout: {
			screen: {
				x: settings.freeScreenX,
				y: settings.freeScreenY,
				width: settings.freeScreenWidth,
			},
			camera: { x: settings.freeCamX, y: settings.freeCamY, width: settings.freeCamWidth },
		},
		webcamPad: {
			left: settings.webcamPadLeft,
			right: settings.webcamPadRight,
			bottom: settings.webcamPadBottom,
			top: settings.webcamPadTop,
			matchScreen: settings.webcamPadMatchScreen,
		},
		screenFill: frame.fill,
		frame: settings.frame,
	});
	return {
		screen: boxOf(layout?.screenRect),
		camera: boxOf(layout?.webcamRect),
		cutout:
			preset === "cutout-stack" ||
			(preset === "free-layout" && settings.webcamBackgroundMode === "transparent"),
	};
}

/** A drawing of a layout: the screen with a pointer on it, the speaker in green. */
export function LayoutThumb({
	aspect,
	boxes,
	height,
}: {
	aspect: number;
	boxes: LayoutBoxes;
	height?: number;
}) {
	const width = THUMB_HEIGHT * aspect;
	const { screen, camera, cutout } = boxes;
	const size = height
		? { height, width: height * aspect }
		: aspect < 1
			? { height: 60 }
			: { width: "100%" };
	return (
		<svg
			className={styles.layoutThumb}
			viewBox={`0 0 ${width} ${THUMB_HEIGHT}`}
			style={{ aspectRatio: aspect, ...size }}
			aria-hidden="true"
		>
			<rect width={width} height={THUMB_HEIGHT} fill="currentColor" fillOpacity={0.08} />
			{screen ? (
				<svg {...screen} viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
					<rect
						x={-1000}
						y={-1000}
						width={2100}
						height={2100}
						fill="currentColor"
						fillOpacity={0.24}
					/>
					<path d="M44 34 L44 64 L51 57 L56 68 L61 66 L56 55 L65 55 Z" fill="currentColor" />
				</svg>
			) : null}
			{camera ? (
				<svg
					{...camera}
					viewBox="0 0 100 100"
					preserveAspectRatio={cutout ? "xMidYMax meet" : "xMidYMax slice"}
				>
					{/* A cut-out speaker stands over the screen with no box around them. */}
					{cutout ? null : <rect x={-1000} y={-1000} width={2100} height={2100} fill="#34b27b" />}
					<circle cx={50} cy={40} r={17} fill={cutout ? "#34b27b" : "#fff"} />
					<path
						d="M16 100 C16 74 32 63 50 63 C68 63 84 74 84 100 Z"
						fill={cutout ? "#34b27b" : "#fff"}
					/>
				</svg>
			) : null}
		</svg>
	);
}
