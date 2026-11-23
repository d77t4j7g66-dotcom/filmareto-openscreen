import type {
	CursorRecordingData,
	CursorRecordingKey,
	CursorRecordingSample,
} from "../../../../src/native/contracts";

export interface CursorPauseRange {
	startMs: number;
	endMs: number;
}

export function compactCursorTelemetryPauseRanges(
	recording: CursorRecordingData,
	ranges: CursorPauseRange[],
): CursorRecordingData {
	if (ranges.length === 0) return recording;

	const normalizedRanges = ranges
		.map((range) => ({
			startMs: Math.max(0, Math.min(range.startMs, range.endMs)),
			endMs: Math.max(0, Math.max(range.startMs, range.endMs)),
		}))
		.filter((range) => Number.isFinite(range.startMs) && Number.isFinite(range.endMs))
		.filter((range) => range.endMs > range.startMs)
		.sort((a, b) => a.startMs - b.startMs);

	if (normalizedRanges.length === 0) return recording;

	return {
		...recording,
		samples: recording.samples
			.map((sample) => {
				let pausedBeforeSampleMs = 0;
				for (const range of normalizedRanges) {
					if (sample.timeMs >= range.startMs && sample.timeMs <= range.endMs) {
						return null;
					}
					if (sample.timeMs > range.endMs) {
						pausedBeforeSampleMs += range.endMs - range.startMs;
					}
				}

				return { ...sample, timeMs: Math.max(0, sample.timeMs - pausedBeforeSampleMs) };
			})
			.filter((sample): sample is CursorRecordingSample => Boolean(sample))
			.sort((a, b) => a.timeMs - b.timeMs),
		...(recording.keys
			? {
					// Same clock as the samples: a shortcut after a pause moves up with them.
					keys: recording.keys
						.map((key) => {
							let pausedBeforeKeyMs = 0;
							for (const range of normalizedRanges) {
								if (key.timeMs >= range.startMs && key.timeMs <= range.endMs) {
									return null;
								}
								if (key.timeMs > range.endMs) {
									pausedBeforeKeyMs += range.endMs - range.startMs;
								}
							}
							return { ...key, timeMs: Math.max(0, key.timeMs - pausedBeforeKeyMs) };
						})
						.filter((key): key is CursorRecordingKey => Boolean(key))
						.sort((a, b) => a.timeMs - b.timeMs),
				}
			: {}),
	};
}

/**
 * Puts the pointer and the keys on the take's clock: the cursor recording starts before the
 * take's first frame (a held take, during its countdown), so `offsetMs` comes off every time.
 * What happened before the take's t=0 is not the take's: clicks and shortcuts then are dropped,
 * and of the pointer's moves only the last one stays, at 0, so the take knows where it starts.
 */
export function shiftCursorTelemetry(
	recording: CursorRecordingData,
	offsetMs: number,
): CursorRecordingData {
	if (!Number.isFinite(offsetMs) || offsetMs <= 0) {
		return recording;
	}
	const shifted = recording.samples
		.map((sample) => ({ ...sample, timeMs: sample.timeMs - offsetMs }))
		.sort((a, b) => a.timeMs - b.timeMs);
	const before = shifted.filter((sample) => sample.timeMs < 0);
	const startPosition = before
		.filter((sample) => !sample.interactionType || sample.interactionType === "move")
		.at(-1);
	const samples = [
		...(startPosition && !shifted.some((sample) => sample.timeMs === 0)
			? [{ ...startPosition, timeMs: 0 }]
			: []),
		...shifted.filter((sample) => sample.timeMs >= 0),
	];
	return {
		...recording,
		samples,
		...(recording.keys
			? {
					keys: recording.keys
						.map((key) => ({ ...key, timeMs: key.timeMs - offsetMs }))
						.filter((key) => key.timeMs >= 0)
						.sort((a, b) => a.timeMs - b.timeMs),
				}
			: {}),
	};
}
