import { describe, expect, it } from "vitest";
import {
	PACKAGE_FORMAT_VERSION,
	PACKAGE_MANIFEST_NAME,
	PACKAGE_PROJECT_NAME,
	parsePackageManifest,
} from "./manifest";

const valid = {
	format: 1,
	createdAt: "2026-11-20T10:00:00.000Z",
	appVersion: "1.2.3",
	projectId: "abc",
	title: "My project",
	files: [{ path: "media/a.mov", sizeBytes: 12 }],
};

describe("package constants", () => {
	it("uses the agreed names", () => {
		expect(PACKAGE_MANIFEST_NAME).toBe("filmareto-package.json");
		expect(PACKAGE_PROJECT_NAME).toBe("project.openscreen");
		expect(PACKAGE_FORMAT_VERSION).toBe(1);
	});
});

describe("parsePackageManifest", () => {
	it("returns the object for a valid manifest", () => {
		expect(parsePackageManifest(JSON.stringify(valid))).toEqual(valid);
	});

	it("returns null for an unknown format version", () => {
		expect(parsePackageManifest(JSON.stringify({ ...valid, format: 2 }))).toBeNull();
	});

	it("returns null when files is missing", () => {
		const { files: _files, ...rest } = valid;
		expect(parsePackageManifest(JSON.stringify(rest))).toBeNull();
	});

	it("returns null for a negative, fractional or non-numeric size, or an empty path", () => {
		for (const bad of [
			{ path: "a", sizeBytes: -1 },
			{ path: "a", sizeBytes: 1.5 },
			{ path: "", sizeBytes: 1 },
		]) {
			expect(parsePackageManifest(JSON.stringify({ ...valid, files: [bad] }))).toBeNull();
		}
	});

	it("returns null for non-JSON", () => {
		expect(parsePackageManifest("not json {")).toBeNull();
	});
});
