import type { HotkeyBinding, PrompterStage } from "./protocol";
import type { Cue, Script } from "./script/types";
import { formatHotkey } from "./settings";

export function cueLabel(c: Cue): string {
	return c.payload ? `${c.type} · ${c.payload}` : c.type;
}

export function toPrompterStage(script: Script, stageIndex: number): PrompterStage {
	const s = script.stages[stageIndex];
	return {
		id: s.id,
		name: s.name,
		index: stageIndex,
		count: script.stages.length,
		startDirections: [...s.startDirections],
		startCues: s.startCues.map(cueLabel),
		lines: s.lines.map((l) => ({
			id: l.id,
			words: l.tokens.map((t) => ({ text: t.raw, bold: t.bold })),
			directions: [...l.directions],
			cues: l.cues.map(cueLabel),
		})),
	};
}

/** Words of the stage for the recogniser's vocabulary hint: rarest across the script first, then longest. */
export function contextualStrings(script: Script, stageIndex: number, max = 100): string[] {
	const freq = new Map<string, number>();
	for (const st of script.stages) {
		for (const l of st.lines)
			for (const t of l.tokens)
				if (t.norm && !t.isNumber) freq.set(t.norm, (freq.get(t.norm) ?? 0) + 1);
	}
	const picked = new Map<string, string>();
	for (const l of script.stages[stageIndex].lines) {
		for (const t of l.tokens) {
			if (!t.norm || t.isNumber || t.norm.length < 3 || picked.has(t.norm)) continue;
			picked.set(t.norm, t.raw.replace(/[^\p{L}\p{N}'-]/gu, ""));
		}
	}
	return [...picked.entries()]
		.sort((a, b) => (freq.get(a[0]) ?? 0) - (freq.get(b[0]) ?? 0) || b[0].length - a[0].length)
		.slice(0, max)
		.map(([, raw]) => raw);
}

export function stageEndHint(bindings: HotkeyBinding[], isLastStage: boolean): string {
	// A cleared shortcut has no keys to show, so its part of the hint is left out.
	const part = (action: "retakeStage" | "nextStage", word: string) => {
		const keys = formatHotkey(bindings, action);
		return keys ? `${keys} ${word}` : "";
	};
	const hints = [isLastStage ? "" : part("nextStage", "next"), part("retakeStage", "again")].filter(
		Boolean,
	);
	const title = isLastStage ? "End of script" : "End of segment";
	return hints.length > 0 ? `${title}\n${hints.join(" · ")}` : title;
}
