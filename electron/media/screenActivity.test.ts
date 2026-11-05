import { describe, expect, it } from "vitest";
import { parseFreezeDetect } from "./screenActivity";

const log = `
[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 4.5
[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 3.25
[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 7.75
[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 12
[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 12.5
[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 20
`;

describe("parseFreezeDetect", () => {
	it("reads each freeze, drops the ones that are too short, and runs an open one to the end", () => {
		expect(parseFreezeDetect(log, 30)).toEqual([
			{ startSec: 4.5, endSec: 7.75 },
			{ startSec: 20, endSec: 30 },
		]);
	});

	it("gives nothing for a log with no freeze", () => {
		expect(parseFreezeDetect("Stream mapping:\n  Stream #0:0 -> #0:0", 30)).toEqual([]);
	});
});
