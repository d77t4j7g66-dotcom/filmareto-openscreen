import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ screen: {}, app: { getPath: () => "/tmp" } }));

import { MacNativeCursorRecordingSession } from "./macNativeCursorRecordingSession";

type Internals = {
	rememberKeys(events: unknown): void;
	keys: { key: string }[];
	startTimeMs: number;
};

describe("key capture pause", () => {
	it("drops the keys pressed while paused and keeps the rest", () => {
		const session = new MacNativeCursorRecordingSession({
			captureKeys: true,
			getDisplayBounds: () => null,
			maxSamples: 10,
			sampleIntervalMs: 33,
		} as never);
		const inner = session as unknown as Internals;
		const press = (key: string) => inner.rememberKeys([{ key, timestampMs: 5, modifiers: [] }]);
		press("a");
		session.setKeysPaused(true);
		press("p");
		session.setKeysPaused(false);
		press("b");
		expect(inner.keys.map((k) => k.key)).toEqual(["a", "b"]);
	});
});
