import { tokenizeLine } from "./shared/normalize";
import type { Line, Script, Stage } from "./shared/script/types";

const SENTENCE_END = /(?<=[.!;?…»])\s+/u;

/**
 * Turns the text of the settings window into a script. A line holding only `/` or `---`, or a `/`
 * standing alone between words, starts the next segment. Each sentence is one line of the
 * prompter, or with `bullets` each line of text.
 */
export function scriptFromText(text: string, bullets = false): Script | null {
	const steps = text
		.split(/(?:^|\n|\s)(?:\/|---)(?=\s|$)/u)
		.map((step) => step.trim())
		.filter(Boolean);
	const stages: Stage[] = [];
	steps.forEach((step, stageIndex) => {
		const sentences = step
			.split(/\n+/)
			.flatMap((block) => (bullets ? [block] : block.split(SENTENCE_END)))
			.map((sentence) => (bullets ? sentence.replace(/^\s*[-•*]\s*/u, "") : sentence).trim())
			.filter((sentence) => tokenizeLine(sentence).length > 0);
		if (sentences.length === 0) return;
		const id = `segment-${stageIndex + 1}`;
		const lines: Line[] = sentences.map((sentence, lineIndex) => ({
			id: `${id}-${lineIndex + 1}`,
			text: sentence,
			tokens: tokenizeLine(sentence),
			cues: [],
			directions: [],
			sourceLine: 0,
		}));
		stages.push({
			id,
			name: `Segment ${stages.length + 1}`,
			startCues: [],
			startDirections: [],
			lines,
			sourceLine: 0,
		});
	});
	if (stages.length === 0) return null;
	return {
		meta: { version: 1, title: "Notes", mode: "screen", format: "9:16", language: "el" },
		stages,
	};
}
