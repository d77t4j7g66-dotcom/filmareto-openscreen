import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { luaString } from "../../src/lib/resolve-export/dataFile";

/**
 * Puts the Resolve side of the export where Resolve looks for it. The Fuse must ship with this build
 * (a missing one fails the export); the other parts are copied when present, nothing is ever deleted, and files this app did
 * not install (the FilmaretoScreenSpike ones) are never touched.
 */

/** File names under `resolveDir`, and where each lands under Resolve's `Fusion` user folder. */
const FUSE_NAME = "FilmaretoScreen.fuse";
const PARTS: Array<{ from: string; to: string[] }> = [
	{ from: FUSE_NAME, to: ["Fuses", "Filmareto", FUSE_NAME] },
	{
		from: "Filmareto Screen.setting",
		to: ["Templates", "Edit", "Effects", "Filmareto Screen.setting"],
	},
	{ from: "Filmareto Import.lua", to: ["Scripts", "Utility", "Filmareto Import.lua"] },
];

export interface InstallResult {
	/** The Fuse is new or changed: Resolve loads Fuses only at start-up. */
	restartNeeded: boolean;
	/** Files written (copied because new or different). */
	installed: string[];
}

async function readOrNull(file: string): Promise<Buffer | null> {
	try {
		return await readFile(file);
	} catch {
		return null;
	}
}

/** Copies the Resolve parts. Run it BEFORE any media work: a missing Fuse then fails at once. */
export async function installResolveParts(input: {
	resolveDir: string;
	resolveUserDir: string;
}): Promise<InstallResult> {
	const installed: string[] = [];
	let restartNeeded = false;
	for (const part of PARTS) {
		const source = await readOrNull(path.join(input.resolveDir, part.from));
		if (!source) {
			// Without the Fuse the effect cannot draw: an export would look fine here and be broken in Resolve.
			if (part.from === FUSE_NAME) {
				throw new Error(
					`${FUSE_NAME} is missing from the app resources (${input.resolveDir}); reinstall the app.`,
				);
			}
			continue;
		}
		const dst = path.join(input.resolveUserDir, ...part.to);
		const existing = await readOrNull(dst);
		if (existing?.equals(source)) continue;
		await mkdir(path.dirname(dst), { recursive: true });
		await copyFile(path.join(input.resolveDir, part.from), dst);
		installed.push(dst);
		if (part.from === FUSE_NAME) restartNeeded = true;
	}
	return { restartNeeded, installed };
}

/**
 * Where the import script looks first: the folder of the latest export. Written only once the
 * export folder is complete, so the script never picks up a half-written one.
 */
export async function writeLastExport(input: {
	resolveUserDir: string;
	exportFolder: string;
}): Promise<void> {
	const lastExport = path.join(input.resolveUserDir, "Filmareto", "last-export.lua");
	await mkdir(path.dirname(lastExport), { recursive: true });
	await writeFile(lastExport, `return { folder = ${luaString(input.exportFolder)} }\n`, "utf8");
}
