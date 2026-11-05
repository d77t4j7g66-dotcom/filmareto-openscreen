import type { CursorRecordingData } from "../../../../src/native/contracts";

export interface CursorRecordingSession {
	start(): Promise<void>;
	stop(): Promise<CursorRecordingData>;
	/** Keys pressed while paused are dropped before they are stored. Optional: macOS only. */
	setKeysPaused?(paused: boolean): void;
}
