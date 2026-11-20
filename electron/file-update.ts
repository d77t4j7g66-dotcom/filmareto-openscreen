// Updating the app from a zip of it, downloaded from the public GitHub repo or sent by somebody
// (`packaging/make-pkg.sh` makes the zip). This module checks that zip is really a newer version of
// THIS app, signed by the same identity, and then swaps it in for the running app once that has quit.
//
// The signature check is the whole point: anyone can hand over a zip, and the one thing that says
// it comes from the same maker is the certificate it was signed with, which `codesign -dr -`
// reports as the designated requirement. The two apps must report the same line.

import { execFile, spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { promisify } from "node:util";

const run = promisify(execFile);

export const APP_BUNDLE_ID = "com.filmareto.openscreen";

/** Public releases carry the stable identity, so a Beta could never install one. */
export const UPDATES_FROM_GITHUB = !APP_BUNDLE_ID.endsWith(".beta");
const UPDATE_REPO = "d77t4j7g66-dotcom/filmareto-openscreen";
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const RELEASE_DOWNLOADS = `https://github.com/${UPDATE_REPO}/releases/download/`;

/** Positive when `a` is newer than `b`. Compares the dotted numbers; a suffix such as
 *  `-beta` is ignored, and a missing part counts as 0 (so 1.0 equals 1.0.0). */
export function compareVersions(a: string, b: string): number {
	const parts = (version: string) =>
		version
			.split("-")[0]
			.split(".")
			.map((part) => Number.parseInt(part, 10) || 0);
	const [left, right] = [parts(a), parts(b)];
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** The "designated => …" line of `codesign -dr -`, which names the signing identity. */
export function designatedLine(output: string): string | null {
	const match = output.match(/^#?\s*(designated => .+)$/m);
	return match ? match[1].trim() : null;
}

export type ReleaseUpdate = { version: string; url: string };

/** The update zip of the latest GitHub release, when that release is newer than this copy. */
export function newerReleaseUpdate(release: unknown, currentVersion: string): ReleaseUpdate | null {
	const { tag_name: tag, assets } = (release ?? {}) as {
		tag_name?: unknown;
		assets?: { name?: unknown; browser_download_url?: unknown }[];
	};
	if (typeof tag !== "string" || !Array.isArray(assets)) return null;
	const version = tag.replace(/^v/, "");
	if (compareVersions(version, currentVersion) <= 0) return null;
	const asset = assets.find(
		({ name }) => typeof name === "string" && /^Filmareto-OpenScreen-Update-.+\.zip$/.test(name),
	);
	const url = asset?.browser_download_url;
	if (typeof url !== "string" || !url.startsWith(RELEASE_DOWNLOADS)) return null;
	return { version, url };
}

/** Saves the zip to a temporary folder. The caller removes that folder. */
export async function downloadUpdate(
	url: string,
	fetchFile: (url: string, init: RequestInit) => Promise<Response>,
): Promise<{ zipPath: string; workDir: string }> {
	const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "filmareto-download-"));
	try {
		const response = await fetchFile(url, { signal: AbortSignal.timeout(15 * 60_000) });
		if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);
		const zipPath = path.join(workDir, "update.zip");
		await pipeline(
			Readable.fromWeb(response.body as WebReadableStream),
			createWriteStream(zipPath),
		);
		return { zipPath, workDir };
	} catch (error) {
		await fs.rm(workDir, { recursive: true, force: true });
		throw error;
	}
}

export type PreparedUpdate =
	| { ok: true; version: string; appPath: string; workDir: string }
	| {
			ok: false;
			reason: "damaged" | "no-app" | "wrong-app" | "not-newer" | "other-signature";
			version?: string;
	  };

async function plistValue(appPath: string, key: string): Promise<string> {
	const { stdout } = await run("/usr/libexec/PlistBuddy", [
		"-c",
		`Print :${key}`,
		path.join(appPath, "Contents", "Info.plist"),
	]);
	return stdout.trim();
}

async function signingIdentity(appPath: string): Promise<string | null> {
	// codesign prints this to stderr.
	const { stdout, stderr } = await run("/usr/bin/codesign", ["-dr", "-", appPath]);
	return designatedLine(`${stdout}\n${stderr}`);
}

/** Unpacks the zip and checks what is inside. On success the caller owns `workDir` and removes it. */
export async function prepareUpdate(
	zipPath: string,
	currentAppPath: string,
	currentVersion: string,
): Promise<PreparedUpdate> {
	const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "filmareto-update-"));
	const fail = async (
		reason: Extract<PreparedUpdate, { ok: false }>["reason"],
		version?: string,
	): Promise<PreparedUpdate> => {
		await fs.rm(workDir, { recursive: true, force: true });
		return { ok: false, reason, version };
	};
	try {
		await run("/usr/bin/ditto", ["-x", "-k", zipPath, workDir]);
	} catch {
		return fail("damaged");
	}
	const apps = (await fs.readdir(workDir)).filter((name) => name.endsWith(".app"));
	if (apps.length !== 1) return fail("no-app");
	const appPath = path.join(workDir, apps[0]);
	try {
		if ((await plistValue(appPath, "CFBundleIdentifier")) !== APP_BUNDLE_ID) {
			return fail("wrong-app");
		}
		const version = await plistValue(appPath, "CFBundleShortVersionString");
		await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
		const [incoming, installed] = await Promise.all([
			signingIdentity(appPath),
			signingIdentity(currentAppPath),
		]);
		if (!incoming || incoming !== installed) return fail("other-signature", version);
		if (compareVersions(version, currentVersion) <= 0) return fail("not-newer", version);
		return { ok: true, version, appPath, workDir };
	} catch {
		return fail("damaged");
	}
}

/** Whether this install can replace itself: the app bundle must belong to the person running it. */
export async function canReplaceInPlace(appPath: string): Promise<boolean> {
	try {
		await fs.access(appPath, fs.constants.W_OK);
		await fs.access(path.dirname(appPath), fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** Waits for the app to quit, puts the new one in its place (the old one back if that fails),
 *  opens it, and removes the unpacked update. Runs after this process is gone, so it is a shell
 *  script and not code of ours. */
export const SWAP_SCRIPT = `
PID="$1"; NEW="$2"; TARGET="$3"; WORK="$4"
for i in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
OLD="$TARGET.replaced-$$"
if mv "$TARGET" "$OLD"; then
  if ditto "$NEW" "$TARGET"; then
    xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
    rm -rf "$OLD"
  else
    rm -rf "$TARGET"
    mv "$OLD" "$TARGET"
  fi
fi
open "$TARGET"
rm -rf "$WORK"
`;

export function startSwap(
	prepared: Extract<PreparedUpdate, { ok: true }>,
	targetApp: string,
): void {
	const child = spawn(
		"/bin/bash",
		["-c", SWAP_SCRIPT, "bash", String(process.pid), prepared.appPath, targetApp, prepared.workDir],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();
}
