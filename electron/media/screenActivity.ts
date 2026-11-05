import { spawn } from "node:child_process";
import { resolveFfmpeg } from "./audioPeaks";

/**
 * Where nothing changes on the screen, found with ffmpeg's `freezedetect` filter. Used by the smart
 * cuts: a stretch where nothing is said, the pointer rests and the picture does not change is
 * dead time and can go.
 *
 * The recording does not contain the cursor when it is recorded as an editable overlay, so a
 * moving pointer does not count as a change here: the cursor is read separately, from its own
 * sidecar.
 */
export interface FrozenSpan {
	startSec: number;
	endSec: number;
}

export interface ScreenActivityResult {
	success: boolean;
	frozen?: FrozenSpan[];
	message?: string;
}

/** A freeze shorter than this is not worth reporting: a held frame, not an idle screen. */
const MIN_FREEZE_SEC = 0.8;
/** Frames this alike are the same frame: 0.001 of full scale, which absorbs encoder noise. */
const NOISE = "0.001";
/** The picture is analysed small: a freeze does not need pixels, and it is much faster. */
const ANALYSIS_WIDTH = 320;
const TIMEOUT_MS = 10 * 60_000;

/** The spans out of ffmpeg's log. A freeze still going at the end runs to `durationSec`. */
export function parseFreezeDetect(log: string, durationSec: number): FrozenSpan[] {
	const spans: FrozenSpan[] = [];
	let start: number | null = null;
	for (const line of log.split(/\r?\n/)) {
		const s = line.match(/lavfi\.freezedetect\.freeze_start:\s*([0-9.]+)/);
		if (s) {
			start = Number.parseFloat(s[1]);
			continue;
		}
		const e = line.match(/lavfi\.freezedetect\.freeze_end:\s*([0-9.]+)/);
		if (e && start !== null) {
			spans.push({ startSec: start, endSec: Number.parseFloat(e[1]) });
			start = null;
		}
	}
	if (start !== null && durationSec > start) spans.push({ startSec: start, endSec: durationSec });
	return spans.filter(
		(span) => Number.isFinite(span.startSec) && span.endSec - span.startSec >= MIN_FREEZE_SEC,
	);
}

export function detectFrozenSpans(
	filePath: string,
	durationSec: number,
): Promise<ScreenActivityResult> {
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) return Promise.resolve({ success: false, message: "No ffmpeg available" });
	return new Promise((resolve) => {
		const child = spawn(
			ffmpeg,
			[
				"-hide_banner",
				"-nostats",
				"-i",
				filePath,
				"-an",
				"-vf",
				`scale=${ANALYSIS_WIDTH}:-2,freezedetect=n=${NOISE}:d=${MIN_FREEZE_SEC}`,
				"-f",
				"null",
				"-",
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let log = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			log += chunk;
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			resolve({ success: false, message: error.message });
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				resolve({ success: false, message: `ffmpeg exited with ${code}` });
				return;
			}
			resolve({ success: true, frozen: parseFreezeDetect(log, durationSec) });
		});
	});
}
