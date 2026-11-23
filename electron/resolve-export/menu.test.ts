import { describe, expect, it, vi } from "vitest";
import { resolveExportFileMenuItems } from "./menu";

describe("resolveExportFileMenuItems", () => {
	it("has no item while the setting is off", () => {
		expect(resolveExportFileMenuItems(false, "Export for Resolve…", vi.fn())).toEqual([]);
	});

	it("has the item, wired to its action, while the setting is on", () => {
		const click = vi.fn();
		const items = resolveExportFileMenuItems(true, "Export for Resolve…", click);
		expect(items).toHaveLength(1);
		expect(items[0].label).toBe("Export for Resolve…");
		(items[0].click as () => void)();
		expect(click).toHaveBeenCalled();
	});
});
