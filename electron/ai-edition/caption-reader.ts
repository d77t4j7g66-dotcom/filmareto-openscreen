// Claude reads the captions once: which word carries each phrase, which phrases earn an emoji, and
// which words the transcriber wrote wrong. On the user's own plan, through `askClaude`.

export interface CaptionWordToRead {
	/** When it is said, in ms of its recording. Names the word in the answer. */
	at: number;
	text: string;
}

export interface CaptionReading {
	keys: number[];
	emoji: Record<number, string>;
	fixes: Array<{ at: number; text: string }>;
}

export const CAPTION_READER_PROMPT = `You prepare short-video captions. You get the words of a talk, each as "time|word".
Answer with one JSON object and nothing else:
{"keys":[time,...],"emoji":{"time":"emoji",...},"fixes":[{"at":time,"text":"corrected word"},...]}

keys: the one word that carries the meaning of each phrase, about one word in every four. A noun, verb or number the viewer should remember. Never a little word.
emoji: an emoji for about one phrase in five, only where a concrete thing is named and the emoji shows that thing. Key it by the time of that word. No decoration, none for abstract words.
fixes: only words the transcriber clearly got wrong: brand and product names, their spelling and capitals (e.g. "premiere" means "Premiere"), words misheard. Keep the speaker's language and punctuation. Do not improve the speaker's wording.

Use only times that appear in the list.`;

/** Claude's answer, keeping only what names a word that exists. */
export function parseCaptionReading(reply: string, words: CaptionWordToRead[]): CaptionReading {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("Claude did not answer with the reading.");
	const raw = JSON.parse(reply.slice(start, end + 1)) as {
		keys?: unknown;
		emoji?: unknown;
		fixes?: unknown;
	};
	const known = new Set(words.map((word) => word.at));
	const keys = (Array.isArray(raw.keys) ? raw.keys : []).filter(
		(at): at is number => typeof at === "number" && known.has(at),
	);
	const emoji: Record<number, string> = {};
	if (raw.emoji && typeof raw.emoji === "object") {
		for (const [at, value] of Object.entries(raw.emoji)) {
			// One emoji, not a sentence: this text goes straight on the picture.
			if (
				known.has(Number(at)) &&
				typeof value === "string" &&
				value.length > 0 &&
				value.length <= 8
			) {
				emoji[Number(at)] = value;
			}
		}
	}
	const fixes = (Array.isArray(raw.fixes) ? raw.fixes : []).flatMap((fix) => {
		const { at, text } = (fix ?? {}) as { at?: unknown; text?: unknown };
		return typeof at === "number" && known.has(at) && typeof text === "string" && text.trim()
			? [{ at, text: text.trim() }]
			: [];
	});
	return { keys, emoji, fixes };
}

export async function readCaptions(
	words: CaptionWordToRead[],
	ask: (systemPrompt: string, userPrompt: string) => Promise<string>,
): Promise<CaptionReading> {
	const list = words.map((word) => `${word.at}|${word.text}`).join("\n");
	return parseCaptionReading(await ask(CAPTION_READER_PROMPT, list), words);
}
