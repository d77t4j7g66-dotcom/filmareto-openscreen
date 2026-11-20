// One recording, split where the teleprompter changed segment. Nothing is cut from the file: a
// segment said again keeps its last attempt on the timeline and the earlier ones as other takes.

/** The teleprompter opened `segment` at `atMs` into the take. */
export type TakeMark = { atMs: number; segment: number };

export type TakeSpan = { startSec: number; endSec: number };

/** One attempt at a clip. No `assetId`: in the clip's own recording. */
export type ClipTake = { assetId?: string; sourceStartSec: number; sourceEndSec: number };

export type TakeSegment = TakeSpan & {
	segment: number;
	/** Earlier attempts at this segment, oldest first. */
	earlier: TakeSpan[];
};

/** Shorter than this and it is a skipped segment or a double press, not something that was said. */
const MIN_SEGMENT_SEC = 0.3;

/** The take's clips in script order, or nothing when it never changed segment and stays one clip. */
export function takeSegments(marks: TakeMark[], durationSec: number): TakeSegment[] {
	const sorted = [...marks]
		.map((mark) => ({ startSec: Math.max(0, mark.atMs / 1000), segment: mark.segment }))
		.sort((a, b) => a.startSec - b.startSec);
	const kept = sorted.filter((mark, index) => {
		const end = sorted[index + 1]?.startSec ?? durationSec;
		return end - mark.startSec >= MIN_SEGMENT_SEC;
	});
	if (kept.length < 2) return [];
	const attempts = new Map<number, TakeSpan[]>();
	kept.forEach((mark, index) => {
		const span = {
			// The first attempt takes whatever came before its mark, so nothing said is out of reach.
			startSec: index === 0 ? 0 : mark.startSec,
			endSec: kept[index + 1]?.startSec ?? durationSec,
		};
		attempts.set(mark.segment, [...(attempts.get(mark.segment) ?? []), span]);
	});
	return [...attempts.entries()]
		.sort(([a], [b]) => a - b)
		.map(([segment, spans]) => ({
			...(spans.at(-1) as TakeSpan),
			segment,
			earlier: spans.slice(0, -1),
		}));
}

/**
 * All the takes of a clip in the order they were said, and which one it is showing. Pure, so the
 * menu and the swap read the same numbering.
 */
export function clipTakes(
	clip: {
		assetId?: string;
		sourceStartSec: number;
		sourceEndSec?: number;
		alternates?: ClipTake[];
	},
	/** The project's recordings in the order they were made, for takes in files of their own. */
	assetOrder: string[] = [],
): { takes: ClipTake[]; current: number } {
	const shown: ClipTake = {
		assetId: clip.assetId,
		sourceStartSec: clip.sourceStartSec,
		sourceEndSec: clip.sourceEndSec ?? 0,
	};
	const file = (take: ClipTake) => assetOrder.indexOf(take.assetId ?? clip.assetId ?? "");
	const takes = [shown, ...(clip.alternates ?? [])].sort(
		(a, b) => file(a) - file(b) || a.sourceStartSec - b.sourceStartSec,
	);
	return { takes, current: takes.indexOf(shown) };
}
