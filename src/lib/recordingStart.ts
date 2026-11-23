/**
 * How the app starts and how a new project starts. Pure, so the choices are tested without a window.
 */

/** What a new project is about to record. */
export type RecordingKind = "talking-head" | "screen-camera" | "screen-only";

export const RECORDING_KINDS: readonly RecordingKind[] = [
	"talking-head",
	"screen-camera",
	"screen-only",
];

export interface RecordingSetup {
	/** The bar's "Camera only" toggle, the Record tab's Screen Off. A take with no screen in it. */
	cameraOnly: boolean;
	/** What the recording preferences (`recording-settings.json`) should hold. */
	prefs: { camEnabled: boolean; micEnabled: boolean };
}

/** The recording mode a kind of project sets for the Record tab and the recording bar. */
export function recordingSetupFor(kind: RecordingKind): RecordingSetup {
	switch (kind) {
		case "talking-head":
			return { cameraOnly: true, prefs: { camEnabled: true, micEnabled: true } };
		case "screen-camera":
			return { cameraOnly: false, prefs: { camEnabled: true, micEnabled: true } };
		case "screen-only":
			return { cameraOnly: false, prefs: { camEnabled: false, micEnabled: true } };
	}
}

/** The query the main process puts on the editor window it opens at launch. */
export const LAUNCH_QUERY_KEY = "startOn";
export const LAUNCH_ON_RECORD = "record";
/** The recording bar's "Edit script": the editor on the Script tab of the current project. */
export const LAUNCH_ON_SCRIPT = "script";

/** The launch window: the editor on its Record tab with no project. */
export function launchWindowQuery(): Record<string, string> {
	return { [LAUNCH_QUERY_KEY]: LAUNCH_ON_RECORD };
}

/** Whether this editor window was opened by the app's launch, to land on Record with no project. */
export function launchStartsOnRecord(search: string): boolean {
	return new URLSearchParams(search).get(LAUNCH_QUERY_KEY) === LAUNCH_ON_RECORD;
}

/** Whether this editor window was opened from the bar to edit the script of the current project. */
export function launchStartsOnScript(search: string): boolean {
	return new URLSearchParams(search).get(LAUNCH_QUERY_KEY) === LAUNCH_ON_SCRIPT;
}
