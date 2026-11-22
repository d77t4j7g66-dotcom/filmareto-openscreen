// Builds an editor package: a folder (and its zip) holding a project and every file it needs, with
// the project's paths rewritten to be relative. The originals are only ever read.

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import {
	PACKAGE_FORMAT_VERSION,
	PACKAGE_MANIFEST_NAME,
	PACKAGE_PROJECT_NAME,
	type PackageManifest,
} from "./manifest";
import { collectPackageRefs, packageFolderName, rewriteDocumentPaths } from "./packageReferences";
import { zipFolder } from "./zip";

export interface PackageProgress {
	copiedBytes: number;
	totalBytes: number;
}

export type BuildPackageResult =
	| { ok: true; folderPath: string; zipPath: string; totalBytes: number }
	| { ok: false; reason: "missing-files"; missing: string[] }
	| { ok: false; reason: "unsafe-path"; paths: string[] };

export interface BuildPackageInput {
	doc: AxcutDocument;
	outRoot: string;
	appVersion: string;
	now?: Date;
	onProgress?: (p: PackageProgress) => void;
}

const PROGRESS_INTERVAL_MS = 100;

interface CopyJob {
	from: string;
	/** POSIX path relative to the package root. */
	to: string;
	sizeBytes: number;
}

function isSafePackagePath(packagePath: string): boolean {
	if (packagePath === "" || packagePath.startsWith("/") || path.isAbsolute(packagePath))
		return false;
	if (packagePath.split("/").some((s) => s === "" || s === "." || s === "..")) return false;
	const resolved = path.resolve("/pkg", packagePath);
	return resolved.startsWith("/pkg/");
}

async function statOrNull(p: string) {
	try {
		return await fs.stat(p);
	} catch {
		return null;
	}
}

async function freeName(outRoot: string, base: string): Promise<string> {
	for (let n = 1; ; n++) {
		const name = n === 1 ? base : `${base} (${n})`;
		const taken =
			(await statOrNull(path.join(outRoot, name))) ||
			(await statOrNull(path.join(outRoot, `${name}.zip`)));
		if (!taken) return name;
	}
}

// Optional fields whose file is not coming along are cleared, so the project never points at a
// package path that does not exist. An asset's originalPath cannot be cleared: it keeps its
// package path (the app regenerates derived clips).
function clearSkipped(doc: AxcutDocument, skipped: Set<string>): AxcutDocument {
	const out = structuredClone(doc);
	for (const asset of out.assets) {
		if (asset.proxyPath && skipped.has(asset.proxyPath)) delete asset.proxyPath;
		if (asset.waveformPath && skipped.has(asset.waveformPath)) delete asset.waveformPath;
	}
	for (const transcript of [out.transcript, ...out.transcripts]) {
		if (!transcript) continue;
		if (transcript.sourceDslPath && skipped.has(transcript.sourceDslPath))
			delete transcript.sourceDslPath;
		if (transcript.sourceJsonPath && skipped.has(transcript.sourceJsonPath))
			delete transcript.sourceJsonPath;
	}
	return out;
}

async function copyCounting(from: string, to: string, onBytes: (n: number) => void): Promise<void> {
	await fs.mkdir(path.dirname(to), { recursive: true });
	const counter = new Transform({
		transform(chunk: Buffer, _enc, cb) {
			onBytes(chunk.length);
			cb(null, chunk);
		},
	});
	await pipeline(createReadStream(from), counter, createWriteStream(to));
}

export async function buildEditorPackage(input: BuildPackageInput): Promise<BuildPackageResult> {
	const { doc, outRoot, appVersion, onProgress } = input;
	const now = input.now ?? new Date();
	const refs = collectPackageRefs(doc);

	// Nothing is written until every path is known to stay inside the package.
	const unsafe = refs.filter((r) => !isSafePackagePath(r.packagePath)).map((r) => r.packagePath);
	if (unsafe.length > 0) return { ok: false, reason: "unsafe-path", paths: unsafe };

	const jobs: CopyJob[] = [];
	const missing: string[] = [];
	const rewrites = new Map<string, string>();
	const skipped = new Set<string>();
	for (const ref of refs) {
		const stat = await statOrNull(ref.sourcePath);
		if (!stat?.isFile()) {
			if (ref.required) missing.push(path.basename(ref.sourcePath));
			else {
				skipped.add(ref.sourcePath);
				rewrites.set(ref.sourcePath, ref.packagePath);
			}
			continue;
		}
		rewrites.set(ref.sourcePath, ref.packagePath);
		jobs.push({ from: ref.sourcePath, to: ref.packagePath, sizeBytes: stat.size });
	}
	if (missing.length > 0) return { ok: false, reason: "missing-files", missing };

	const totalBytes = jobs.reduce((sum, j) => sum + j.sizeBytes, 0);
	await fs.mkdir(outRoot, { recursive: true });
	const finalName = await freeName(outRoot, packageFolderName(doc.project.title, now));
	const staging = path.join(outRoot, `.partial-${randomUUID()}`);
	const folder = path.join(staging, finalName);
	const zip = path.join(staging, `${finalName}.zip`);

	try {
		await fs.mkdir(folder, { recursive: true });
		let copied = 0;
		let lastReport = 0;
		const report = (force: boolean) => {
			const t = Date.now();
			if (!force && t - lastReport < PROGRESS_INTERVAL_MS) return;
			lastReport = t;
			onProgress?.({ copiedBytes: copied, totalBytes });
		};
		for (const job of jobs) {
			await copyCounting(job.from, path.join(folder, ...job.to.split("/")), (n) => {
				copied += n;
				report(false);
			});
		}
		report(true);

		const projectDoc = rewriteDocumentPaths(
			clearSkipped(doc, skipped),
			(p) => rewrites.get(p) ?? p,
		);
		await fs.writeFile(
			path.join(folder, PACKAGE_PROJECT_NAME),
			JSON.stringify(projectDoc, null, 2),
		);
		const manifest: PackageManifest = {
			format: PACKAGE_FORMAT_VERSION,
			createdAt: now.toISOString(),
			appVersion,
			projectId: doc.project.id,
			title: doc.project.title,
			files: jobs.map((j) => ({ path: j.to, sizeBytes: j.sizeBytes })),
		};
		await fs.writeFile(path.join(folder, PACKAGE_MANIFEST_NAME), JSON.stringify(manifest, null, 2));
		await zipFolder(folder, zip);

		const finalFolder = path.join(outRoot, finalName);
		const finalZip = path.join(outRoot, `${finalName}.zip`);
		await fs.rename(folder, finalFolder);
		try {
			await fs.rename(zip, finalZip);
		} catch (error) {
			await fs.rm(finalFolder, { recursive: true, force: true });
			throw error;
		}
		await fs.rm(staging, { recursive: true, force: true });
		return { ok: true, folderPath: finalFolder, zipPath: finalZip, totalBytes };
	} catch (error) {
		await fs.rm(staging, { recursive: true, force: true });
		throw error;
	}
}
