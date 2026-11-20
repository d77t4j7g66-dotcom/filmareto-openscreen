import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PrompterController } from "./main/prompterController";
import { scriptFromText } from "./script";
import type { FromHelper, ToHelper } from "./shared/protocol";
import { encodeMessage, LineDecoder } from "./shared/protocol";
import { normalizeSettings } from "./shared/settings";

// Runs the real helper on a spoken file, so it needs Speech Recognition permission:
// FILMARETO_VOICE_TEST=<helper binary> FILMARETO_VOICE_FILE=<audio> npx vitest run voice.e2e
const helper = process.env.FILMARETO_VOICE_TEST;
const audio = process.env.FILMARETO_VOICE_FILE;
const TEXT =
	"Σήμερα θα μιλήσουμε για το μοντάζ στα βίντεο. Το πρόβλημα είναι ότι κανείς δεν το βλέπει. Πάμε να δούμε πώς γίνεται πιο γρήγορα.";

describe.skipIf(!helper || !audio)("voice sync on a real recogniser", () => {
	it("follows a reading to the last sentence and ends", async () => {
		const child = spawn(helper as string, [], { stdio: "pipe" });
		const handlers = new Set<(m: FromHelper) => void>();
		const seen: ToHelper[] = [];
		const states: string[] = [];
		let session = 0;
		const bridge = {
			send(msg: ToHelper) {
				seen.push(msg);
				if (msg.type === "speech.start") {
					session = msg.sessionId;
					child.stdin.write(
						encodeMessage({
							type: "speech.file",
							path: audio as string,
							contextualStrings: msg.contextualStrings,
						}),
					);
				} else if (msg.type !== "speech.stop") {
					child.stdin.write(encodeMessage(msg));
				}
			},
			on(handler: (m: FromHelper) => void) {
				handlers.add(handler);
				return () => handlers.delete(handler);
			},
			onStatus: () => () => {},
		};
		const settings = normalizeSettings(null, "/tmp");
		const controller = new PrompterController({
			bridge,
			getSettings: () => settings,
			updatePrompterSettings: () => {},
			nextAttempt: () => 1,
			writeLog: () => {},
		});
		const decoder = new LineDecoder();
		const script = scriptFromText(TEXT);
		const finished = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timeout; states ${states}`)), 70_000);
			child.stdout.on("data", (chunk: Buffer) => {
				for (const raw of decoder.push(chunk.toString("utf8"))) {
					const msg = raw.type === "speech.words" ? { ...raw, sessionId: session } : raw;
					if (msg.type === "speech.state") states.push(msg.state);
					if (msg.type === "ready" && script) {
						controller.open({ projectDir: "t", script, scriptHash: "", stageIndex: 0 });
						controller.perform("playPause");
					}
					for (const handler of handlers) handler(msg);
					if (seen.some((m) => m.type === "prompter.stageEnd")) {
						clearTimeout(timer);
						resolve();
					}
				}
			});
		});
		try {
			await finished;
		} finally {
			child.kill("SIGTERM");
		}
		const cursors = seen.flatMap((m) => (m.type === "prompter.setCursor" ? [m.lineId] : []));
		console.log("states", states, "cursor moves", cursors.length, "lines", new Set(cursors));
		expect(new Set(cursors)).toContain("segment-1-3");
	}, 80_000);
});
