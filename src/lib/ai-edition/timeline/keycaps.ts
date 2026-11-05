// Keyboard shortcuts recorded with a take, planned as on-screen keycaps. Pure: no DOM, no IPC.
//
// The sidecar's `keys` are in SOURCE time, on the clock of the recording they belong to. Where a
// keycap lands on the ruler is decided by the clips that play that recording, so a shortcut
// pressed in a stretch the edit cut out shows nothing, and one in a stretch played twice shows
// twice. Same rule as the captions.

import type { CursorRecordingKey } from "@/native/contracts";
import { sourceSpanToTimelineSpans } from "../captions/cues";
import type { AxcutClip } from "../schema";
import { type KeycapImage, type KeycapLabels, keycapTokens, PLUS } from "./keycapImage";

/** How long a keycap stays up, unless the next shortcut comes sooner. */
export const KEYCAP_HOLD_MS = 1400;
/** The least a keycap stays up: a shortcut followed straight away by another still reads. */
export const KEYCAP_MIN_MS = 350;

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "cmd"] as const;
const MODIFIER_SYMBOL: Record<(typeof MODIFIER_ORDER)[number], string> = {
	ctrl: "⌃",
	alt: "⌥",
	shift: "⇧",
	cmd: "⌘",
};

/** "⌘ K", "⇧⌘ C", "F1": the macOS order of modifiers, then the key. */
export function keycapLabel(key: CursorRecordingKey): string {
	const modifiers = MODIFIER_ORDER.filter((m) => key.modifiers.includes(m))
		.map((m) => MODIFIER_SYMBOL[m])
		.join("");
	return modifiers ? `${modifiers} ${key.key}` : key.key;
}

/** How far apart the caps of one combination come in, so they read as pressed one after another. */
export const KEYCAP_STAGGER_MS = 110;
/** A plain key counts as a shortcut when no other key is pressed this close to it. */
export const KEYCAP_ISOLATED_GAP_MS = 900;
/** A plain key (no ⌘, ⌃ or ⌥) goes up for less time than a combination. */
const PLAIN_HOLD_MS = 900;

/** Which keys without ⌘, ⌃ or ⌥ become keycaps. */
export type PlainKeys = "off" | "isolated" | "all";

/** A key with none of ⌘, ⌃, ⌥ and not a function key: part of ordinary typing. */
export function isPlainKey(key: Pick<CursorRecordingKey, "key" | "modifiers">): boolean {
	if (/^F\d{1,2}$/.test(key.key)) return false;
	return !key.modifiers.some((m) => m === "cmd" || m === "ctrl" || m === "alt");
}

/** The caps of a combination with the "+" between them: ["Cmd", "+", "Shift", "+", "Z"]. */
export function withPlus(tokens: string[]): string[] {
	return tokens.flatMap((token, index) => (index === 0 ? [token] : [PLUS, token]));
}

/** One drawn piece of a keycap: a cap or a "+", and when it comes in after the first. */
export interface KeycapPart {
	token: string;
	image: KeycapImage;
	delayMs: number;
}

export interface KeycapPlan {
	/** On the ruler (raw timeline ms). */
	startMs: number;
	endMs: number;
	label: string;
	/** The caps to draw, left to right (see `keycapTokens`). */
	tokens: string[];
	/** The pieces drawn as pictures, in order. Absent: the keycap is written as text. */
	parts?: KeycapPart[];
}

export function planKeycaps(params: {
	keysByAssetId: Map<string, CursorRecordingKey[]>;
	clips: AxcutClip[];
	holdMs?: number;
	/** Keys without ⌘, ⌃ or ⌥: none, only those pressed alone, or all. Alone by default. */
	plainKeys?: PlainKeys;
	/** When given, only these plain keys (by name, "E", "Q", "Space") are shown. */
	onlyKeys?: string[];
	labels?: KeycapLabels;
}): KeycapPlan[] {
	const { keysByAssetId, clips, holdMs = KEYCAP_HOLD_MS, plainKeys = "isolated" } = params;
	const only = new Set((params.onlyKeys ?? []).map((k) => k.trim().toUpperCase()).filter(Boolean));
	const plans: KeycapPlan[] = [];
	for (const [assetId, keys] of keysByAssetId) {
		const sorted = [...keys].sort((a, b) => a.timeMs - b.timeMs);
		sorted.forEach((key, index) => {
			if (isPlainKey(key)) {
				if (plainKeys === "off") return;
				if (only.size > 0) {
					if (!only.has(key.key.toUpperCase())) return;
				} else if (plainKeys === "isolated") {
					const before = sorted[index - 1];
					const after = sorted[index + 1];
					const crowded =
						(before && key.timeMs - before.timeMs < KEYCAP_ISOLATED_GAP_MS) ||
						(after && after.timeMs - key.timeMs < KEYCAP_ISOLATED_GAP_MS);
					if (crowded) return;
				}
			}
			const next = sorted[index + 1];
			const startMs = key.timeMs;
			const hold = isPlainKey(key) ? Math.min(holdMs, PLAIN_HOLD_MS) : holdMs;
			const endMs = Math.max(
				startMs + KEYCAP_MIN_MS,
				Math.min(startMs + hold, next ? next.timeMs : Number.POSITIVE_INFINITY),
			);
			const spans = sourceSpanToTimelineSpans(assetId, startMs / 1000, endMs / 1000, clips);
			for (const span of spans) {
				plans.push({
					startMs: Math.round(span.startSec * 1000),
					endMs: Math.round(span.endSec * 1000),
					label: keycapLabel(key),
					tokens: withPlus(keycapTokens(key, params.labels)),
				});
			}
		});
	}
	return plans.sort((a, b) => a.startMs - b.startMs);
}
