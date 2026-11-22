/** The teleprompter opened `segment` at `atMs` into the take. */
export type TakeMark = { atMs: number; segment: number };

/**
 * Which attempt at `segment` the running take is on: each time the prompter opened it (its first
 * time, "again", or coming back to it) started one. 1 before it was opened at all.
 */
export function segmentAttempt(marks: readonly TakeMark[], segment: number): number {
	return Math.max(1, marks.filter((mark) => mark.segment === segment).length);
}
