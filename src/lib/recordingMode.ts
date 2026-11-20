const CAMERA_ONLY_KEY = "filmareto.cameraOnly";

/** A take with no screen in it. Stored, because the bar and the editor are windows of their own. */
export function readCameraOnly(): boolean {
	try {
		return localStorage.getItem(CAMERA_ONLY_KEY) === "1";
	} catch {
		return false;
	}
}

export function writeCameraOnly(on: boolean): void {
	try {
		if (on) localStorage.setItem(CAMERA_ONLY_KEY, "1");
		else localStorage.removeItem(CAMERA_ONLY_KEY);
	} catch {
		// Without storage the bar's own button still chooses.
	}
}
