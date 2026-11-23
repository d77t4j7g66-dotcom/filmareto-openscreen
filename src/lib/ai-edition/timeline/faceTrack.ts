export type FacePoint = { t: number; x: number; y: number; h?: number };
export type FaceSample = FacePoint | { t: number; none: true };

/** A hole in the faces this long or shorter is bridged; a longer one holds the last face. */
const BRIDGE_SEC = 3;
/** The width of the centred moving average. */
const WINDOW_SEC = 1.5;

const isFace = (sample: FaceSample): sample is FacePoint => !("none" in sample);

const median3 = (a: number, b: number, c: number) =>
	a + b + c - Math.min(a, b, c) - Math.max(a, b, c);

/** The middle of a value and its neighbours (an end uses the one neighbour it has). */
function medianAt(values: number[], i: number): number {
	const here = values[i];
	const before = values[i - 1] ?? here;
	const after = values[i + 1] ?? here;
	return median3(before, here, after);
}

/**
 * The face over a take, from one look per sample: a single wrong look is dropped (median of 3),
 * a hole of up to 3 s is bridged in a line and a longer one holds the last face, then a 1.5 s
 * centred average takes the jitter out. Null when no sample had a face.
 */
export function smoothFaceTrack(samples: FaceSample[]): FacePoint[] | null {
	const sorted = [...samples].sort((a, b) => a.t - b.t);
	const faces = sorted.filter(isFace);
	if (faces.length === 0) return null;

	// Median of 3 over the faces found, so a hole does not hide a wrong look next to it.
	const xs = faces.map((f) => f.x);
	const ys = faces.map((f) => f.y);
	const hs = faces.map((f) => f.h);
	const cleaned = new Map<number, FacePoint>();
	faces.forEach((f, i) => {
		const h = hs.every((value) => value !== undefined) ? medianAt(hs as number[], i) : f.h;
		cleaned.set(i, {
			t: f.t,
			x: medianAt(xs, i),
			y: medianAt(ys, i),
			...(h === undefined ? {} : { h }),
		});
	});

	// Every sample gets a point: its own, a bridged one, or the last face held.
	const filled: FacePoint[] = [];
	let faceIndex = -1;
	for (const sample of sorted) {
		if (isFace(sample)) {
			faceIndex += 1;
			filled.push(cleaned.get(faceIndex) as FacePoint);
			continue;
		}
		const previous = faceIndex >= 0 ? cleaned.get(faceIndex) : undefined;
		const next = cleaned.get(faceIndex + 1);
		if (!previous) {
			const first = next as FacePoint;
			filled.push({ ...first, t: sample.t });
		} else if (next && next.t - previous.t <= BRIDGE_SEC) {
			const k = (sample.t - previous.t) / (next.t - previous.t);
			const h =
				previous.h !== undefined && next.h !== undefined
					? previous.h + (next.h - previous.h) * k
					: undefined;
			filled.push({
				t: sample.t,
				x: previous.x + (next.x - previous.x) * k,
				y: previous.y + (next.y - previous.y) * k,
				...(h === undefined ? {} : { h }),
			});
		} else {
			filled.push({ ...previous, t: sample.t });
		}
	}

	const half = WINDOW_SEC / 2;
	return filled.map((point) => {
		let x = 0;
		let y = 0;
		let h = 0;
		let hCount = 0;
		let count = 0;
		for (const other of filled) {
			if (Math.abs(other.t - point.t) > half + 1e-9) continue;
			x += other.x;
			y += other.y;
			count += 1;
			if (other.h !== undefined) {
				h += other.h;
				hCount += 1;
			}
		}
		return {
			t: point.t,
			x: x / count,
			y: y / count,
			...(hCount === count ? { h: h / count } : {}),
		};
	});
}

/**
 * The face at second `t` of the take: a straight line between the two points around it, the end
 * point held past either end. Null for an empty track. The compositor's `face_at`, in TS.
 */
export function faceAt(track: readonly FacePoint[], t: number): FacePoint | null {
	if (track.length === 0) return null;
	if (t <= track[0].t) return track[0];
	const last = track[track.length - 1];
	if (t >= last.t) return last;
	const after = track.findIndex((point) => point.t >= t);
	const a = track[after - 1];
	const b = track[after];
	const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
	const h = a.h !== undefined && b.h !== undefined ? { h: a.h + (b.h - a.h) * k } : {};
	return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, ...h };
}
