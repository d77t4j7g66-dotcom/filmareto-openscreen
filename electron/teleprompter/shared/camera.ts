import type { PrompterSettings, ToHelper } from "./protocol";

/** Chromium labels a camera `Name (vid:pid)`; AVFoundation's localizedName is the part before it. */
const VENDOR_SUFFIX = /\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i;

export function stripCameraSuffix(label: string): string {
	return label.replace(VENDOR_SUFFIX, "").trim();
}

/** Whether a Chromium camera label and an AVFoundation localizedName name the same camera. */
export function cameraNameMatches(label: string, localizedName: string): boolean {
	const a = stripCameraSuffix(label).toLowerCase();
	const b = stripCameraSuffix(localizedName).toLowerCase();
	return a.length > 0 && a === b;
}

/** The camera the prompter should know about: null while the camera is off or none is chosen. */
export function prompterCameraName(prefs: {
	camEnabled: boolean;
	camDeviceName: string | null;
}): string | null {
	if (!prefs.camEnabled) return null;
	const name = prefs.camDeviceName?.trim();
	return name ? name : null;
}

/**
 * The camera sits behind the text only for a full-screen prompter on a display other than the
 * primary one (the screen being recorded). With no display picked the prompter follows the
 * pointer, so it is not known to be elsewhere and nothing shows.
 */
export function isFullscreenOnOtherDisplay(
	prompter: Pick<PrompterSettings, "position" | "displayId">,
	primaryDisplayId: number,
): boolean {
	return (
		prompter.position === "fullscreen" &&
		prompter.displayId !== null &&
		prompter.displayId !== primaryDisplayId
	);
}

/** Whether the helper has to show the camera: the placement, a non-zero opacity and a camera. */
export function showsCameraBehindText(
	prompter: Pick<PrompterSettings, "position" | "displayId" | "cameraOpacity">,
	primaryDisplayId: number,
	cameraName: string | null,
): boolean {
	return (
		isFullscreenOnOtherDisplay(prompter, primaryDisplayId) &&
		prompter.cameraOpacity > 0 &&
		cameraName !== null
	);
}

/**
 * The display the camera is shown on: the saved one while it is connected and is not the main
 * display (the one being recorded), else the first other display, else none.
 */
export function cameraPreviewDisplay(
	saved: number | null,
	displayIds: number[],
	primaryId: number,
): number | null {
	if (saved !== null && saved !== primaryId && displayIds.includes(saved)) return saved;
	return displayIds.find((id) => id !== primaryId) ?? null;
}

type PreviewMessage = Extract<ToHelper, { type: "cameraPreview.set" }>;

/**
 * Whether sending `next` would start a camera session the helper does not have now. A take must
 * not have one started under it, since it would fight the recorder for the camera.
 */
export function previewStartsSession(next: PreviewMessage, last: PreviewMessage | null): boolean {
	if (!next.enabled) return false;
	return !(last?.enabled && last.cameraName === next.cameraName);
}

/**
 * What the helper is told about the camera on a display of its own. Off, or with no camera named,
 * it is disabled, as for the prompter's camera behind the text.
 */
export function cameraPreviewMessage(
	preview: { enabled: boolean; displayId: number | null },
	cameraName: string | null,
	mirror: boolean,
): Extract<ToHelper, { type: "cameraPreview.set" }> {
	return {
		type: "cameraPreview.set",
		enabled: preview.enabled && cameraName !== null && preview.displayId !== null,
		displayId: preview.displayId === null ? null : String(preview.displayId),
		cameraName,
		mirror,
	};
}
