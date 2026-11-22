// Zips and unzips an editor package with the system `ditto`, so nothing new is bundled.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const DITTO = "/usr/bin/ditto";

/** Zips `folder` (keeping the folder itself as the top entry) to `zipPath`. Stored without
 *  compression, since the media inside is already compressed, and without resource-fork
 *  `__MACOSX` entries. */
export async function zipFolder(folder: string, zipPath: string): Promise<void> {
	await run(DITTO, [
		"-c",
		"-k",
		"--norsrc",
		"--keepParent",
		"--zlibCompressionLevel",
		"0",
		folder,
		zipPath,
	]);
}

/** Unzips `zipPath` into `destDir`. */
export async function unzipTo(zipPath: string, destDir: string): Promise<void> {
	await run(DITTO, ["-x", "-k", zipPath, destDir]);
}
