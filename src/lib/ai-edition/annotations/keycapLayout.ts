// The keycaps of a video share one layout: moving or resizing any cap moves and scales every key
// combination alike, each one kept centred on the same point, so they all land in the same place
// at the same size. The pieces of one combination keep their spacing, because they scale about
// their own centre.

import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";

type Region = AxcutAnnotationRegion;

/** Within this many percent of the frame's centre lines a moved group snaps onto them. */
export const KEYCAP_SNAP_PCT = 1.5;

interface Box {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

function boxOf(parts: Region[]): Box {
	return {
		minX: Math.min(...parts.map((p) => p.position.x)),
		maxX: Math.max(...parts.map((p) => p.position.x + p.size.width)),
		minY: Math.min(...parts.map((p) => p.position.y)),
		maxY: Math.max(...parts.map((p) => p.position.y + p.size.height)),
	};
}

const centreOf = (box: Box) => ({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 });

/**
 * `patch` on `id`, spread over every keycap when `id` is one and the patch moves or resizes it.
 * Anything else is a plain patch.
 */
export function patchKeycaps(
	annotations: Region[],
	id: string,
	patch: Partial<Region>,
): Region[] | null {
	const target = annotations.find((a) => a.id === id);
	if (!target || target.annotationSource !== "keycap" || !target.annotationGroup) return null;
	const resized = patch.size && patch.size.height !== target.size.height;
	const moved =
		patch.position &&
		(patch.position.x !== target.position.x || patch.position.y !== target.position.y);
	if (!resized && !moved) return null;

	const groups = new Map<string, Region[]>();
	for (const a of annotations) {
		if (a.annotationSource !== "keycap" || !a.annotationGroup) continue;
		groups.set(a.annotationGroup, [...(groups.get(a.annotationGroup) ?? []), a]);
	}
	const own = groups.get(target.annotationGroup) ?? [target];
	const ownBox = boxOf(own);
	const ownCentre = centreOf(ownBox);

	let centre = ownCentre;
	if (!resized && patch.position) {
		centre = {
			x: ownCentre.x + patch.position.x - target.position.x,
			y: ownCentre.y + patch.position.y - target.position.y,
		};
		if (Math.abs(centre.x - 50) <= KEYCAP_SNAP_PCT) centre.x = 50;
		if (Math.abs(centre.y - 50) <= KEYCAP_SNAP_PCT) centre.y = 50;
	}
	const height = resized ? (patch.size?.height ?? target.size.height) : target.size.height;

	const next = new Map<string, Region>();
	for (const parts of groups.values()) {
		const box = boxOf(parts);
		const c = centreOf(box);
		const factor = resized ? height / parts[0].size.height : 1;
		for (const part of parts) {
			next.set(part.id, {
				...part,
				size: { width: part.size.width * factor, height: part.size.height * factor },
				position: {
					x: centre.x + (part.position.x - c.x) * factor,
					y: centre.y + (part.position.y - c.y) * factor,
				},
			});
		}
	}
	return annotations.map((a) => {
		const changed = next.get(a.id);
		if (!changed) return a;
		return a.id === id && patch.style ? { ...changed, style: patch.style } : changed;
	});
}
