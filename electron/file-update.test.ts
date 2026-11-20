import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareVersions, designatedLine, downloadUpdate, newerReleaseUpdate } from "./file-update";

const URL_BASE =
	"https://github.com/d77t4j7g66-dotcom/filmareto-openscreen/releases/download/v1.1.0/";
const release = (name: string, url = URL_BASE + name, tag = "v1.1.0") => ({
	tag_name: tag,
	assets: [
		{ name: "Filmareto-OpenScreen-1.1.0-arm64.pkg", browser_download_url: `${URL_BASE}x.pkg` },
		{ name, browser_download_url: url },
	],
});

describe("newerReleaseUpdate", () => {
	const zip = "Filmareto-OpenScreen-Update-1.1.0.zip";
	it("picks the update zip of a newer release", () => {
		expect(newerReleaseUpdate(release(zip), "1.0.0")).toEqual({
			version: "1.1.0",
			url: URL_BASE + zip,
		});
	});
	it("offers nothing for the same version or an older one", () => {
		expect(newerReleaseUpdate(release(zip), "1.1.0")).toBeNull();
		expect(newerReleaseUpdate(release(zip), "1.2.0")).toBeNull();
	});
	it("refuses a download from anywhere but this repo's releases", () => {
		expect(newerReleaseUpdate(release(zip, `https://example.com/${zip}`), "1.0.0")).toBeNull();
	});
	it("offers nothing when the release has no update zip, or the answer is not a release", () => {
		expect(newerReleaseUpdate(release("notes.txt"), "1.0.0")).toBeNull();
		expect(newerReleaseUpdate({ message: "Not Found" }, "1.0.0")).toBeNull();
		expect(newerReleaseUpdate(null, "1.0.0")).toBeNull();
	});
});

describe("downloadUpdate", () => {
	it("saves the body to a file", async () => {
		const { zipPath, workDir } = await downloadUpdate("u", async () => new Response("zip bytes"));
		expect(await fs.readFile(zipPath, "utf8")).toBe("zip bytes");
		await fs.rm(workDir, { recursive: true });
	});
	it("fails on an error status", async () => {
		await expect(
			downloadUpdate("u", async () => new Response("no", { status: 404 })),
		).rejects.toThrow("404");
	});
});

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
