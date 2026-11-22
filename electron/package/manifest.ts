// The manifest at the root of an editor package: a folder (and its zip) holding a project and all
// of its media. It lets the other Mac check what it was handed before opening anything.

import { z } from "zod";

export const PACKAGE_MANIFEST_NAME = "filmareto-package.json";
export const PACKAGE_PROJECT_NAME = "project.openscreen";
export const PACKAGE_FORMAT_VERSION = 1;

const packageManifestSchema = z.object({
	format: z.literal(PACKAGE_FORMAT_VERSION),
	createdAt: z.string(),
	appVersion: z.string(),
	projectId: z.string(),
	title: z.string(),
	files: z.array(z.object({ path: z.string().min(1), sizeBytes: z.number().int().nonnegative() })),
});

export interface PackageManifest {
	format: 1;
	createdAt: string;
	appVersion: string;
	projectId: string;
	title: string;
	files: { path: string; sizeBytes: number }[];
}

/** Parses the manifest text; anything that is not a valid version-1 manifest gives null. */
export function parsePackageManifest(raw: string): PackageManifest | null {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	const result = packageManifestSchema.safeParse(json);
	return result.success ? result.data : null;
}
