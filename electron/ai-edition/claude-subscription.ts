// The one place the app talks to Claude: Claude Code on this Mac, on the user's own plan, signed in
// by Claude Code itself. No API key and no second login. The chat's tools are the app's own MCP
// server (`openscreen mcp`), which hands each edit to the open editor, so it lands live and is one
// undo step, as if the user had made it.
//
// Anyone with a Claude plan connects their own: the app runs their unmodified Claude Code and they
// sign in through Anthropic's own page. That is what Anthropic's terms allow: the app never sees or
// keeps their login, and their usage is on their own plan. It must never pay for usage, proxy it, or
// narrow how Claude Code signs in. https://code.claude.com/docs/en/legal-and-compliance
// The API-key engine (`deep-agent/`, `provider-registry.ts`) is still in the tree, with no UI.

import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeStatus {
	installed: boolean;
	signedIn: boolean;
	/** "pro", "max"… as Claude Code reports it. */
	plan: string | null;
}

export interface ClaudeTurnEvents {
	text?: (delta: string) => void;
	thinking?: (delta: string) => void;
	toolStart?: (name: string, args: unknown) => void;
	toolEnd?: (name: string, ok: boolean, summary?: string) => void;
}

export interface ClaudeTurnResult {
	text: string;
	sessionId: string | null;
	/** Set when the turn failed, in words for the user. */
	error?: string;
	/** Claude Code no longer has the conversation asked for: start it again with the transcript. */
	resumeLost?: boolean;
}

/** A GUI app does not get the shell's PATH, so the usual places are tried first. */
const USUAL_PLACES = [
	join(homedir(), ".local/bin/claude"),
	join(homedir(), ".claude/local/claude"),
	"/opt/homebrew/bin/claude",
	"/usr/local/bin/claude",
];

let found: string | null = null;

export function findClaude(): string | null {
	if (found && existsSync(found)) return found;
	found = USUAL_PLACES.find((path) => existsSync(path)) ?? null;
	if (found) return found;
	try {
		const answer = execFileSync("/bin/zsh", ["-lc", "command -v claude"], {
			encoding: "utf8",
			timeout: 5000,
		}).trim();
		found = answer.startsWith("/") ? answer : null;
	} catch {
		found = null;
	}
	return found;
}

/** Electron's own flag would turn the child into Node. How Claude Code signs in is its user's business. */
function childEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
}

export function claudeStatus(): Promise<ClaudeStatus> {
	const claude = findClaude();
	if (!claude) return Promise.resolve({ installed: false, signedIn: false, plan: null });
	return new Promise((resolve) => {
		execFile(claude, ["auth", "status"], { env: childEnv(), timeout: 15_000 }, (_error, stdout) => {
			try {
				const info = JSON.parse(stdout) as { loggedIn?: boolean; subscriptionType?: string };
				resolve({
					installed: true,
					signedIn: info.loggedIn === true,
					plan: info.subscriptionType ?? null,
				});
			} catch {
				resolve({ installed: true, signedIn: false, plan: null });
			}
		});
	});
}

/** Opens Claude's own sign-in page in the browser. Claude Code keeps the login. */
export function claudeSignIn(): void {
	const claude = findClaude();
	if (claude) {
		spawn(claude, ["auth", "login"], { env: childEnv(), stdio: "ignore", detached: true }).unref();
	}
}

/** Claude's failure, in words for the user. */
export function describeFailure(message: string): string {
	const low = message.toLowerCase();
	if (/not logged in|please run \/login|invalid api key|authentication/.test(low)) {
		return "Claude is not signed in on this Mac. Sign in from the chat panel and try again.";
	}
	if (/hit your|usage limit|limit reached|rate.?limit|session limit|weekly limit/.test(low)) {
		return "Your Claude plan's usage limit is reached. Try again when it resets.";
	}
	if (/overloaded|temporarily|timed? ?out|connection|\b(502|503|529)\b/.test(low)) {
		return "Claude is busy right now. Try again in a moment.";
	}
	return message || "Claude did not answer.";
}

const MCP_PREFIX = "mcp__openscreen__";
const shortName = (name: string) =>
	name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;

/** Reads Claude's stream, one JSON line at a time. Pure, so it can be pinned without Claude. */
export function createStreamReader(events: ClaudeTurnEvents) {
	const toolNames = new Map<string, string>();
	let buffer = "";
	const result: ClaudeTurnResult = { text: "", sessionId: null };

	const line = (raw: string) => {
		let event: {
			type?: string;
			subtype?: string;
			session_id?: string;
			is_error?: boolean;
			result?: string;
			event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
			message?: {
				content?: Array<{
					type?: string;
					id?: string;
					name?: string;
					input?: unknown;
					tool_use_id?: string;
					is_error?: boolean;
					content?: unknown;
				}>;
			};
		};
		try {
			event = JSON.parse(raw);
		} catch {
			return;
		}
		if (event.session_id) result.sessionId = event.session_id;
		if (event.type === "stream_event") {
			const delta = event.event?.delta;
			if (delta?.type === "text_delta" && delta.text) events.text?.(delta.text);
			if (delta?.type === "thinking_delta" && delta.thinking) events.thinking?.(delta.thinking);
			return;
		}
		if (event.type === "result") {
			if (event.is_error) result.error = describeFailure(event.result ?? "");
			else result.text = event.result ?? "";
			return;
		}
		for (const block of event.message?.content ?? []) {
			if (block.type === "tool_use" && block.id && block.name) {
				const name = shortName(block.name);
				toolNames.set(block.id, name);
				events.toolStart?.(name, block.input);
			}
			if (block.type === "tool_result" && block.tool_use_id) {
				const name = toolNames.get(block.tool_use_id) ?? "tool";
				const content = Array.isArray(block.content)
					? (block.content[0] as { text?: string } | undefined)?.text
					: String(block.content ?? "");
				const human = name.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
				events.toolEnd?.(name, !block.is_error, block.is_error ? content : human);
			}
		}
	};

	return {
		feed(chunk: string) {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const raw of lines) if (raw.trim()) line(raw);
		},
		finish(): ClaudeTurnResult {
			if (buffer.trim()) line(buffer);
			buffer = "";
			return result;
		},
	};
}

const running = new Set<ReturnType<typeof spawn>>();

/** Nothing of ours should outlive the app, thinking on the user's plan. */
export function stopClaudeTurns(): void {
	for (const child of running) child.kill();
}

function runClaude(args: string[], input: string, cwd: string, events: ClaudeTurnEvents) {
	const claude = findClaude();
	if (!claude) {
		return Promise.resolve<ClaudeTurnResult>({
			text: "",
			sessionId: null,
			error: "Claude Code is not installed on this Mac.",
		});
	}
	mkdirSync(cwd, { recursive: true });
	return new Promise<ClaudeTurnResult>((resolve) => {
		const child = spawn(claude, args, { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
		running.add(child);
		const reader = createStreamReader(events);
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => reader.feed(chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			running.delete(child);
			resolve({ text: "", sessionId: null, error: describeFailure(error.message) });
		});
		child.on("close", () => {
			running.delete(child);
			const result = reader.finish();
			if (!result.text && !result.error)
				result.error = describeFailure(stderr.trim().slice(0, 400));
			resolve(result);
		});
		child.stdin.end(input);
	});
}

/** Fewer tokens per call: no settings, no skills, no project notes, none of Claude Code's own tools. */
const BARE = [
	"-p",
	"--strict-mcp-config",
	"--setting-sources",
	"",
	"--disable-slash-commands",
	"--tools",
	"",
	"--output-format",
	"stream-json",
	"--verbose",
	"--include-partial-messages",
	"--model",
	"sonnet",
];

/** One turn of the chat, with the app's tools. `folder` must stay the same for `resume` to work. */
export async function claudeTurn(options: {
	prompt: string;
	systemPrompt: string;
	resume?: string;
	folder: string;
	/** The app's own binary: `<it> mcp` is its MCP server. */
	appBinary: string;
	events: ClaudeTurnEvents;
}): Promise<ClaudeTurnResult> {
	const args = [
		...BARE,
		"--mcp-config",
		JSON.stringify({
			mcpServers: { openscreen: { type: "stdio", command: options.appBinary, args: ["mcp"] } },
		}),
		"--allowedTools",
		"mcp__openscreen",
		// A chat message should not start the screen recorder.
		"--disallowedTools",
		`${MCP_PREFIX}startRecording,${MCP_PREFIX}stopRecording`,
		"--system-prompt",
		options.systemPrompt,
	];
	const first = await runClaude(
		options.resume ? [...args, "--resume", options.resume] : args,
		options.prompt,
		options.folder,
		options.events,
	);
	// Claude Code's own history can be cleared. The caller's transcript is what counts.
	if (options.resume && first.error && /no conversation found/i.test(first.error)) {
		return { text: "", sessionId: null, resumeLost: true };
	}
	return first;
}

/** A one-off answer with no tools and no history, for a pure text job such as a translation. */
export function askClaude(prompt: string, systemPrompt: string, folder: string) {
	return runClaude(
		[...BARE, "--no-session-persistence", "--system-prompt", systemPrompt],
		prompt,
		folder,
		{},
	);
}
