// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtInStylePresets, seedBuiltInStylePresets } from "./builtInStylePresets";
import { parseStylePresetAppearance } from "./stylePresets";

describe("builtInStylePresets", () => {
	it("are two valid looks, one vertical and one horizontal", () => {
		const presets = builtInStylePresets();
		expect(presets.map((p) => p.name)).toEqual(["Vertical", "Horizontal"]);
		for (const preset of presets) {
			const roundTripped = parseStylePresetAppearance(
				JSON.parse(JSON.stringify(preset.appearance)),
			);
			expect(roundTripped).toEqual(preset.appearance);
		}
		expect(presets[0].appearance.aspectRatio).toBe("9:16");
		expect(presets[0].appearance.webcamLayoutPreset).toBe("cutout-stack");
		expect(presets[1].appearance.aspectRatio).toBe("16:9");
		expect(presets[1].appearance.webcamLayoutPreset).toBe("picture-in-picture");
	});
});

describe("seedBuiltInStylePresets", () => {
	beforeEach(() => window.localStorage.clear());

	it("writes both once, and not again", async () => {
		const create = vi.fn(async () => ({}));
		const presets = { list: vi.fn(async () => []), create };
		expect(await seedBuiltInStylePresets(presets)).toBe(true);
		expect(create).toHaveBeenCalledTimes(2);
		expect(await seedBuiltInStylePresets(presets)).toBe(false);
		expect(create).toHaveBeenCalledTimes(2);
	});

	it("leaves a preset that already has the name", async () => {
		const create = vi.fn(async () => ({}));
		await seedBuiltInStylePresets({ list: async () => [{ name: "vertical" }], create });
		expect(create).toHaveBeenCalledTimes(1);
		expect(create.mock.calls[0][0]).toBe("Horizontal");
	});

	it("tries again next time when it could not write", async () => {
		const failing = {
			list: async () => [],
			create: vi.fn(async () => {
				throw new Error("disk");
			}),
		};
		await seedBuiltInStylePresets(failing);
		const create = vi.fn(async () => ({}));
		await seedBuiltInStylePresets({ list: async () => [], create });
		expect(create).toHaveBeenCalledTimes(2);
	});
});
