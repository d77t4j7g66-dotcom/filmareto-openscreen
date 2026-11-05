import { useSyncExternalStore } from "react";

/**
 * Whether the recording under the playhead carries its system audio and microphone on tracks of
 * their own (a macOS take with both). Only then do the two recording levels do anything; an older
 * take has one mixed track. The preview learns this when it prepares the take's audio, and the
 * audio pane reads it here.
 */
let hasStems = false;
const listeners = new Set<() => void>();

export function setRecordingHasStems(next: boolean): void {
	if (hasStems === next) return;
	hasStems = next;
	for (const listener of listeners) listener();
}

export function useRecordingHasStems(): boolean {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => hasStems,
		() => false,
	);
}
