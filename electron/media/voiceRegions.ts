import { spawn } from "node:child_process";
import { type DuckRegion, findSpeechRegions } from "../../src/lib/ai-edition/recordingDuck";
import { countAudioStreams, resolveFfmpeg } from "./audioPeaks";

/**
 * Where the voice speaks in a take that carries its sources on separate tracks.
 *
 * Reads the microphone track (the third of three: the mix, the system audio, the microphone) as
 * mono PCM and hands it to `findSpeechRegions`. The result is stored in the project once; see
 * `recordingDuck.ts`. `regions: null` on success means there is no such track to read.
 */
export interface VoiceRegionsResult {
	success: boolean;
	regions?: DuckRegion[] | null;
	message?: string;
}

const PCM_RATE = 16_000;
const TIMEOUT_MS = 60_000;

export function analyseVoiceRegions(filePath: string): Promise<DuckRegion[] | null> {
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) return Promise.resolve(null);
	return new Promise((resolve, reject) => {
		let listing = "";
		const probe = spawn(ffmpeg, ["-hide_banner", "-i", filePath], {
			stdio: ["ignore", "ignore", "pipe"],
			timeout: 10_000,
			killSignal: "SIGKILL",
		});
		probe.stderr.on("data", (chunk: Buffer) => {
			listing += chunk.toString();
		});
		probe.once("error", () => resolve(null));
		probe.once("close", () => {
			if (countAudioStreams(listing) !== 3) {
				resolve(null);
				return;
			}
			const chunks: Buffer[] = [];
			const child = spawn(
				ffmpeg,
				[
					"-hide_banner",
					"-loglevel",
					"error",
					"-i",
					filePath,
					"-map",
					"0:a:2",
					// Padded at the front when the track starts late, so sample zero is the
					// recording's zero, as the exporter aligns its tracks.
					"-af",
					"aresample=first_pts=0",
					"-ac",
					"1",
					"-ar",
					String(PCM_RATE),
					"-f",
					"f32le",
					"-",
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error("ffmpeg timed out reading the voice track"));
			}, TIMEOUT_MS);
			child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				if (code !== 0) {
					reject(new Error(`ffmpeg exited ${code} reading the voice track`));
					return;
				}
				const bytes = Buffer.concat(chunks);
				const samples = new Float32Array(
					bytes.buffer.slice(
						bytes.byteOffset,
						bytes.byteOffset + bytes.length - (bytes.length % 4),
					),
				);
				resolve(findSpeechRegions(samples, PCM_RATE));
			});
		});
	});
}
