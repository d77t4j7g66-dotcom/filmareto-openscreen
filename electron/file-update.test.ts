import { describe, expect, it } from "vitest";
import { compareVersions, designatedLine } from "./file-update";

describe("compareVersions", () => {
	it("orders dotted numbers, not strings", () => {
		expect(compareVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
		expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
		expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
	});
	it("treats a missing part as zero and ignores a suffix", () => {
		expect(compareVersions("1.0", "1.0.0")).toBe(0);
		expect(compareVersions("1.2.0-beta", "1.2.0")).toBe(0);
	});
});

describe("designatedLine", () => {
	it("finds the identity line in codesign's report", () => {
		const report = 'Executable=/x\n# designated => identifier "a" and certificate leaf = H"ab"\n';
		expect(designatedLine(report)).toBe(
			'designated => identifier "a" and certificate leaf = H"ab"',
		);
	});
	it("is null when the app is not signed", () => {
		expect(designatedLine("code object is not signed at all")).toBeNull();
	});
});
