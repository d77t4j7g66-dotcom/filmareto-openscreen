/**
 * Where a recording's system audio dips under its own voice.
 *
 * The voice track of a take is analysed once, when the take first opens in the editor, into the
 * stretches where it speaks. Those stretches are stored in the project; nothing listens to the
 * voice while editing or exporting. The preview and the exporter (`stem_duck_db_at` in
 * audio.rs) read the same rule from them.
 */
export const STEM_DUCK = {
	/** Mean power above this, over one block, counts as speech. */
	thresholdDbfs: -35,
	/** The dip is complete this long before a stretch starts… */
	attackSec: 0.25,
	/** …lasts this long past its end… */
	holdSec: 0.5,
	/** …and takes this long to come back. */
	releaseSec: 0.6,
	blockSec: 0.01,
	/** Shorter stretches are a cough or a click, not speech. */
	minRegionSec: 0.15,
} as const;

/** A stretch of the recording, in seconds of the recording itself, where the voice speaks. */
export type DuckRegion = [start: number, end: number];

/** The stretches where `samples` (mono) carry speech. Gaps shorter than the hold are one stretch. */
export function findSpeechRegions(samples: Float32Array, sampleRate: number): DuckRegion[] {
	const block = Math.max(1, Math.round(sampleRate * STEM_DUCK.blockSec));
	const blocks = Math.floor(samples.length / block);
	const threshold = 10 ** (STEM_DUCK.thresholdDbfs / 10);
	const spans: DuckRegion[] = [];
	let open: number | null = null;
	for (let index = 0; index < blocks; index += 1) {
		let energy = 0;
		for (let i = index * block; i < (index + 1) * block; i += 1) energy += samples[i] * samples[i];
		const speaking = energy / block > threshold;
		if (speaking && open === null) open = index;
		if (!speaking && open !== null) {
			spans.push([open * STEM_DUCK.blockSec, index * STEM_DUCK.blockSec]);
			open = null;
		}
	}
	if (open !== null) spans.push([open * STEM_DUCK.blockSec, blocks * STEM_DUCK.blockSec]);

	const merged: DuckRegion[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && span[0] - last[1] <= STEM_DUCK.holdSec) last[1] = span[1];
		else merged.push([span[0], span[1]]);
	}
	return merged
		.filter(([start, end]) => end - start >= STEM_DUCK.minRegionSec)
		.map(([start, end]) => [round3(start), round3(end)]);
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** The dip in dB (zero or negative) at `sec` for a dip `depthDb` deep. */
export function duckDbAt(regions: readonly DuckRegion[], sec: number, depthDb: number): number {
	const { attackSec, holdSec, releaseSec } = STEM_DUCK;
	let down = 0;
	for (const [start, end] of regions) {
		const amount =
			sec < start
				? 1 - (start - sec) / attackSec
				: sec <= end + holdSec
					? 1
					: 1 - (sec - end - holdSec) / releaseSec;
		down = Math.max(down, Math.min(1, Math.max(0, amount)));
	}
	return down === 0 ? 0 : -Math.abs(depthDb) * down;
}

export function isDuckRegions(value: unknown): value is DuckRegion[] {
	return (
		Array.isArray(value) &&
		value.every(
			(region) =>
				Array.isArray(region) &&
				region.length === 2 &&
				Number.isFinite(region[0]) &&
				Number.isFinite(region[1]) &&
				region[1] >= region[0],
		)
	);
}
