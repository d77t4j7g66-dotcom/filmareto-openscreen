import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unzipTo, zipFolder } from "./zip";

const run = promisify(execFile);

describe.skipIf(process.platform !== "darwin")("zip helpers", () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "package-zip-"));
		await fs.mkdir(path.join(tmp, "pkg", "media"), { recursive: true });
		await fs.writeFile(path.join(tmp, "pkg", "media", "a.bin"), Buffer.from([1, 2, 3]));
	});

	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	it("zip round trip keeps bytes and the parent folder", async () => {
		const zip = path.join(tmp, "pkg.zip");
		const out = path.join(tmp, "out");
		await zipFolder(path.join(tmp, "pkg"), zip);
		await unzipTo(zip, out);
		const bytes = await fs.readFile(path.join(out, "pkg", "media", "a.bin"));
		expect([...bytes]).toEqual([1, 2, 3]);
	});

	it("zip carries no resource forks", async () => {
		const file = path.join(tmp, "pkg", "media", "a.bin");
		// An extended attribute is what makes ditto emit AppleDouble (`._`) entries without --norsrc.
		execFileSync("/usr/bin/xattr", ["-w", "com.filmareto.test", "x", file]);
		execFileSync("/usr/bin/xattr", [
			"-w",
			"com.filmareto.test",
			"x",
			path.join(tmp, "pkg", "media"),
		]);
		const zip = path.join(tmp, "pkg.zip");
		await zipFolder(path.join(tmp, "pkg"), zip);
		const { stdout } = await run("/usr/bin/zipinfo", ["-1", zip]);
		const entries = stdout.split("\n").filter(Boolean);
		expect(entries).toContain("pkg/media/a.bin");
		for (const entry of entries) {
			expect(entry).not.toContain("__MACOSX");
			expect(entry.split("/").some((segment) => segment.startsWith("._"))).toBe(false);
		}
	});
});
