// A motion graphic on the timeline: one pill, drawn by the compositor as the image of the moment.
// Pure, so the timing can be tested without a render.

import type { GraphicData } from "@/components/video-editor/types";
import { coalesceRegionsForRuler } from "@/lib/ai-edition/timeline/timelineMap";

export type GraphicTemplate = Awaited<
	ReturnType<Window["electronAPI"]["graphics"]["list"]>
>[number];

/** Long side of a graphic's frames: the largest an export can ask for. */
const GRAPHIC_LONG_SIDE = 1920;

export function graphicFrameSize(aspect: number): { width: number; height: number } {
	const even = (value: number) => 2 * Math.round(value / 2);
	return aspect < 1
		? { width: even(GRAPHIC_LONG_SIDE * aspect), height: GRAPHIC_LONG_SIDE }
		: { width: GRAPHIC_LONG_SIDE, height: even(GRAPHIC_LONG_SIDE / aspect) };
}

/**
 * When each frame shows in a pill `pillMs` long. The way in keeps its time from the start and the
 * way out its time from the end, so a longer pill holds the frame between them. A pill too short
 * for both plays the whole graphic faster.
 */
export function graphicFrameSpans(
	graphic: Pick<GraphicData, "frames" | "durationMs" | "holdMs">,
	pillMs: number,
): { path: string; startMs: number; endMs: number }[] {
	const { frames, durationMs, holdMs } = graphic;
	const timeOf =
		pillMs >= durationMs
			? (atMs: number) => (atMs <= holdMs ? atMs : pillMs - (durationMs - atMs))
			: (atMs: number) => (atMs * pillMs) / durationMs;
	return frames
		.map((frame, index) => ({
			path: frame.path,
			startMs: Math.round(timeOf(frame.atMs)),
			endMs: Math.round(index + 1 < frames.length ? timeOf(frames[index + 1].atMs) : pillMs),
		}))
		.filter((span) => span.endMs > span.startMs);
}

type GraphicRegion = {
	id: string;
	startMs: number;
	endMs: number;
	content?: string;
	clipId?: string;
	sourceStartSec?: number;
	sourceEndSec?: number;
	graphicData?: GraphicData;
};

/**
 * The regions the compositor draws: each graphic becomes one image region per frame. Worked out on
 * the pill, so a graphic cut in two by a clip boundary still plays once. The frames carry no clip
 * anchor: they are placed by ruler time, which the anchor keeps in step.
 */
export function expandGraphicRegions<T extends GraphicRegion>(regions: T[]): T[] {
	const graphics = regions.filter((region) => region.graphicData);
	if (graphics.length === 0) return regions;
	const frames = coalesceRegionsForRuler(graphics).flatMap((pill) => {
		const { clipId: _c, sourceStartSec: _s, sourceEndSec: _e, ...member } = pill.member;
		const startMs = Math.round(pill.start * 1000);
		const pillMs = Math.round(pill.end * 1000) - startMs;
		return graphicFrameSpans(member.graphicData as GraphicData, pillMs).map(
			(span) =>
				({
					...member,
					// Named by its file: the compositor keeps a texture per id, and a new wording of the
					// same graphic must not draw the old one.
					id: `${pill.ids[0]}~${span.path}`,
					startMs: startMs + span.startMs,
					endMs: startMs + span.endMs,
					content: span.path,
					graphicData: undefined,
				}) as unknown as T,
		);
	});
	return [...regions.filter((region) => !region.graphicData), ...frames];
}
