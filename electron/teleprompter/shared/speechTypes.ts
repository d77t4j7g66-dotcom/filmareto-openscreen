/** One recognised word. `t` = when it was spoken, `at` = when the recogniser first reported it (seconds). */
export type RecognizedWord = { text: string; t: number; final: boolean; at?: number };

/** The current best transcription of one recognition request. Later updates replace earlier ones. */
export type Hypothesis = { requestId: string; words: RecognizedWord[] };
