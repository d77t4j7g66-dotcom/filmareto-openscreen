import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HOTKEY_KEY_NAMES } from "./hotkeyKeys";
import { stageEndHint } from "./prompterModel";
import { DEFAULT_HOTKEYS } from "./settings";

describe("shortcut key names", () => {
	it("are the same set in the native helper (KeyCodes.swift) and in the app", () => {
		const source = readFileSync(
			resolve(process.cwd(), "electron/native/teleprompter/Sources/PrompterCore/KeyCodes.swift"),
			"utf8",
		);
		const table = source.slice(
			source.indexOf("codes: [String: UInt32] = ["),
			source.indexOf("]\n"),
		);
		const native = [...table.matchAll(/"([A-Za-z0-9]+)":\s*0x|"([A-Za-z0-9]+)":\s*\d/g)].map(
			(m) => m[1] ?? m[2],
		);
		expect([...native].sort()).toEqual([...HOTKEY_KEY_NAMES].sort());
	});
});

describe("stageEndHint", () => {
	it("names the shortcuts", () => {
		expect(stageEndHint(DEFAULT_HOTKEYS, false)).toBe("End of segment\n⌃⌥→ next · ⌃⌥R again");
		expect(stageEndHint(DEFAULT_HOTKEYS, true)).toBe("End of script\n⌃⌥R again");
	});

	it("leaves out a shortcut that was cleared, with no dangling words", () => {
		const cleared = DEFAULT_HOTKEYS.map((b) =>
			b.action === "nextStage" ? { ...b, key: "", modifiers: [] } : b,
		);
		expect(stageEndHint(cleared, false)).toBe("End of segment\n⌃⌥R again");
		const none = DEFAULT_HOTKEYS.map((b) =>
			b.action === "nextStage" || b.action === "retakeStage" ? { ...b, key: "", modifiers: [] } : b,
		);
		expect(stageEndHint(none, false)).toBe("End of segment");
	});
});
