import { describe, expect, it } from "vitest";
import { parseCaptionReading } from "./caption-reader";

const words = [
	{ at: 100, text: "το" },
	{ at: 400, text: "premiere" },
];

describe("parseCaptionReading", () => {
	it("keeps what names a real word, and takes the JSON out of any wrapping", () => {
		const reply =
			'Here it is:\n{"keys":[400,999],"emoji":{"400":"🎬","999":"🔥"},"fixes":[{"at":400,"text":"Premiere"},{"at":5,"text":"x"}]}';
		expect(parseCaptionReading(reply, words)).toEqual({
			keys: [400],
			emoji: { 400: "🎬" },
			fixes: [{ at: 400, text: "Premiere" }],
		});
	});

	it("refuses text that is not an emoji and an answer with no JSON", () => {
		const long = '{"emoji":{"400":"a whole sentence of text"}}';
		expect(parseCaptionReading(long, words).emoji).toEqual({});
		expect(() => parseCaptionReading("sorry", words)).toThrow();
	});
});
