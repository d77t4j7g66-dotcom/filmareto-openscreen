export type Token = {
	/** The word as written, punctuation included, without ** markers. */
	raw: string;
	/** Lowercase, no accents, ς→σ, letters and digits only. Empty for punctuation-only words. */
	norm: string;
	/** Phonetic key used by the matcher (Greek homophones folded). */
	key: string;
	isNumber: boolean;
	bold: boolean;
};

const MARKS = /\p{M}/gu;
const NOT_WORD = /[^\p{L}\p{N}]/gu;
const DIGIT = /\p{N}/u;

export function normalizeWord(raw: string): string {
	return raw
		.normalize("NFD")
		.replace(MARKS, "")
		.toLowerCase()
		.replace(/ς/g, "σ")
		.replace(NOT_WORD, "");
}

/** Folds spellings that sound the same so speech recognition errors still match. */
export function phoneticKey(norm: string): string {
	return norm
		.replace(/ου/g, "\u0001")
		.replace(/ει|οι|υι/g, "ι")
		.replace(/αι/g, "ε")
		.replace(/[ηυ]/g, "ι")
		.replace(/ω/g, "ο")
		.replace(/\u0001/g, "ου")
		.replace(/(.)\1+/gu, "$1");
}

export function hasDigit(raw: string): boolean {
	return DIGIT.test(raw);
}

export function plainText(text: string): string {
	return text.replace(/\*\*/g, "");
}

/** One token per whitespace-separated word, so display words and matcher tokens stay 1:1. */
export function tokenizeLine(text: string): Token[] {
	const tokens: Token[] = [];
	let bold = false;
	for (const part of text.split(/\s+/).filter(Boolean)) {
		const pieces = part.split("**");
		const startsBold = bold || (pieces.length > 1 && pieces[0] === "");
		for (let i = 1; i < pieces.length; i++) bold = !bold;
		const raw = pieces.join("");
		if (raw === "") continue;
		const norm = normalizeWord(raw);
		tokens.push({ raw, norm, key: phoneticKey(norm), isNumber: hasDigit(raw), bold: startsBold });
	}
	return tokens;
}
