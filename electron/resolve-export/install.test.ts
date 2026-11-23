import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installResolveParts, writeLastExport } from "./install";

let root = "";
let resolveDir = "";
let userDir = "";
const fuse = () => path.join(userDir, "Fuses", "Filmareto", "FilmaretoScreen.fuse");

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-install-"));
	resolveDir = path.join(root, "resolve");
	userDir = path.join(root, "user");
	await fs.mkdir(resolveDir, { recursive: true });
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

const install = () => installResolveParts({ resolveDir, resolveUserDir: userDir });

describe("installResolveParts", () => {
	it("copies the parts that exist and asks for a restart only when the Fuse is new or changed", async () => {
		await fs.writeFile(path.join(resolveDir, "FilmaretoScreen.fuse"), "v1");
		await fs.writeFile(path.join(resolveDir, "Filmareto Screen.setting"), "macro");
		expect((await install()).restartNeeded).toBe(true);
		expect(await fs.readFile(fuse(), "utf8")).toBe("v1");
		expect(
			await fs.readFile(
				path.join(userDir, "Templates", "Edit", "Effects", "Filmareto Screen.setting"),
				"utf8",
			),
		).toBe("macro");

		// Unchanged: nothing to restart for.
		expect((await install()).restartNeeded).toBe(false);

		// A changed macro alone does not need a restart; a changed Fuse does.
		await fs.writeFile(path.join(resolveDir, "Filmareto Screen.setting"), "macro2");
		expect((await install()).restartNeeded).toBe(false);
		await fs.writeFile(path.join(resolveDir, "FilmaretoScreen.fuse"), "v2");
		expect((await install()).restartNeeded).toBe(true);
		expect(await fs.readFile(fuse(), "utf8")).toBe("v2");
	});

	it("fails when the Fuse does not ship, and installs nothing", async () => {
		await expect(install()).rejects.toThrow(/FilmaretoScreen.fuse/);
		await expect(fs.stat(path.join(userDir, "Filmareto", "last-export.lua"))).rejects.toThrow();
	});

	it("skips the optional parts that do not ship and deletes nothing", async () => {
		await fs.writeFile(path.join(resolveDir, "FilmaretoScreen.fuse"), "v1");
		const spike = path.join(userDir, "Fuses", "FilmaretoScreenSpike.fuse");
		await fs.mkdir(path.dirname(spike), { recursive: true });
		await fs.writeFile(spike, "spike");
		const result = await install();
		expect(result.restartNeeded).toBe(true);
		expect(result.installed).toEqual([fuse()]);
		expect(await fs.readFile(spike, "utf8")).toBe("spike");
		// The pointer is not written by the install: only after a finished export.
		await expect(fs.stat(path.join(userDir, "Filmareto", "last-export.lua"))).rejects.toThrow();
	});

	it("writes last-export.lua with the folder escaped", async () => {
		await writeLastExport({ resolveUserDir: userDir, exportFolder: '/Movies/A "B"' });
		expect(await fs.readFile(path.join(userDir, "Filmareto", "last-export.lua"), "utf8")).toBe(
			'return { folder = "/Movies/A \\"B\\"" }\n',
		);
	});
});
