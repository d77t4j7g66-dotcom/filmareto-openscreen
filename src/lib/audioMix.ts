/**
 * Mic gain applied when mixing the microphone with system audio into the recorder's
 * destination stream. Boosted slightly above unity so the voice is clearly audible
 * over typical system-audio levels.
 */
export const MIC_GAIN_BOOST = 1.4;

/**
 * The mic gain the capture paths apply: the user's own gain and nothing else. Until 1.2.0 it was
 * boosted by MIC_GAIN_BOOST over system audio; Kostas wants the level OBS records, and a hot mic
 * had +2.9 dB it could not spend. Kept as a function so every request builder asks one place.
 */
export function nativeMicrophoneGain(_systemAudioEnabled: boolean, userGainDb = 0): number {
	// 1.2.0: the microphone at unity, "the same level as OBS". The boost over system audio is
	// gone: the mix of the two is soft-limited instead, and the WAV master is never touched.
	return dbToGain(userGainDb);
}

/** A level in decibels as the factor the samples are multiplied by. */
export function dbToGain(db: number): number {
	return Number.isFinite(db) ? 10 ** (db / 20) : 1;
}

/**
 * Duration of the mic fade-in applied at the start of a recording. Masks the
 * click/pop that the mic produces at its first packet (echo-canceller warm-up,
 * DC offset, gain-stage step) without audibly muting speech.
 */
export const MIC_FADE_IN_S = 0.02;

export type MixAudioTracksInput = {
	systemAudioTrack?: MediaStreamTrack | null | undefined;
	micAudioTrack?: MediaStreamTrack | null | undefined;
	/** The user's own level for the microphone, in decibels. */
	micGainDb?: number;
};

export type MixAudioTracksResult = {
	/** AudioContext created to mix the two tracks. `null` when no mixing was needed. */
	context: AudioContext | null;
	/** The track to add to the recorder's MediaStream, or `null` when neither input was given. */
	track: MediaStreamTrack | null;
};

/**
 * Combine system audio and the microphone into a single audio track for the recorder.
 *
 * Whenever a mic track is present it is routed through an AudioContext + GainNode with
 * a short fade-in so its first packet doesn't click — mic-only recordings (a common
 * mode) get the same anti-click treatment as mixed ones, so `context` is non-null
 * whenever a mic track is present. The mic is boosted above unity only when it has to
 * sit over system audio; on its own it rides at unity so mic-only loudness is unchanged.
 * Caller owns the returned `context` and must `.close()` it on teardown.
 *
 * - System audio only: returned verbatim, no AudioContext created (no warm-up click).
 * - Neither present: returns `{ context: null, track: null }`.
 */
export function mixAudioTracks({
	systemAudioTrack,
	micAudioTrack,
	micGainDb = 0,
}: MixAudioTracksInput): MixAudioTracksResult {
	if (!micAudioTrack) {
		return { context: null, track: systemAudioTrack ?? null };
	}

	const context = new AudioContext();
	const destination = context.createMediaStreamDestination();
	if (systemAudioTrack) {
		const systemSource = context.createMediaStreamSource(new MediaStream([systemAudioTrack]));
		systemSource.connect(destination);
	}
	// Unity when the mic is on its own; boosted only when competing with system audio.
	const micTargetGain = nativeMicrophoneGain(Boolean(systemAudioTrack), micGainDb);
	const micSource = context.createMediaStreamSource(new MediaStream([micAudioTrack]));
	const micGain = context.createGain();
	micGain.gain.setValueAtTime(0, context.currentTime);
	micGain.gain.linearRampToValueAtTime(micTargetGain, context.currentTime + MIC_FADE_IN_S);
	micSource.connect(micGain).connect(destination);
	return { context, track: destination.stream.getAudioTracks()[0] };
}
