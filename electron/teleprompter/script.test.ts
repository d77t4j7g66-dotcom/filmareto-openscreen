import { describe, expect, it } from "vitest";
import { scriptFromText } from "./script";

describe("scriptFromText", () => {
	it("makes one line per sentence and one step per separator", () => {
		const script = scriptFromText("Γεια σου. Τι κάνεις;\n/\nΠάμε στο δεύτερο βήμα.\n---\nΤέλος!");
		expect(script?.stages.map((stage) => stage.lines.map((line) => line.text))).toEqual([
			["Γεια σου.", "Τι κάνεις;"],
			["Πάμε στο δεύτερο βήμα."],
			["Τέλος!"],
		]);
	});

	it("accepts a slash between words, and keeps one inside a word", () => {
		const script = scriptFromText("Πρώτο βήμα / δεύτερο με AI/ML μέσα");
		expect(script?.stages.map((stage) => stage.lines[0].text)).toEqual([
			"Πρώτο βήμα",
			"δεύτερο με AI/ML μέσα",
		]);
	});

	it("keeps one line per text line for bullets, without the bullet mark", () => {
		const script = scriptFromText("- Πρώτο. Με δύο προτάσεις.\n• Δεύτερο\n/\nΤρίτο", true);
		expect(script?.stages.map((stage) => stage.lines.map((line) => line.text))).toEqual([
			["Πρώτο. Με δύο προτάσεις.", "Δεύτερο"],
			["Τρίτο"],
		]);
	});

	it("has nothing to read in empty text", () => {
		expect(scriptFromText("  \n / \n")).toBeNull();
	});
});
