import { type ChildProcessWithoutNullStreams, spawn as nodeSpawn } from "node:child_process";
import { encodeMessage, type FromHelper, LineDecoder, type ToHelper } from "../shared/protocol";

export type BridgeStatus = "starting" | "ready" | "restarting" | "failed" | "stopped";
export type SpawnFn = (cmd: string, args: string[]) => ChildProcessWithoutNullStreams;

type Options = {
	binaryPath: string;
	spawn?: SpawnFn;
	now?: () => number;
	/** Crashes within `windowMs` that make the bridge give up. */
	maxCrashes?: number;
	windowMs?: number;
	log?: (text: string) => void;
};

export class HelperBridge {
	private child: ChildProcessWithoutNullStreams | null = null;
	private ready = false;
	private queue: ToHelper[] = [];
	private readonly handlers = new Set<(m: FromHelper) => void>();
	private readonly statusHandlers = new Set<(s: BridgeStatus) => void>();
	private crashes: number[] = [];
	private stopping = false;

	constructor(private readonly opts: Options) {}

	get isReady(): boolean {
		return this.ready;
	}

	start(): void {
		this.stopping = false;
		this.launch();
	}

	send(msg: ToHelper): void {
		if (this.ready && this.child) this.child.stdin.write(encodeMessage(msg));
		else this.queue.push(msg);
	}

	on(handler: (m: FromHelper) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	onStatus(handler: (s: BridgeStatus) => void): () => void {
		this.statusHandlers.add(handler);
		return () => this.statusHandlers.delete(handler);
	}

	stop(): void {
		this.stopping = true;
		this.queue = [];
		const child = this.child;
		if (!child) {
			this.emitStatus("stopped");
			return;
		}
		child.stdin.end();
		child.kill("SIGTERM");
	}

	private launch(): void {
		const spawn: SpawnFn =
			this.opts.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: "pipe" }));
		const child = spawn(this.opts.binaryPath, []);
		this.child = child;
		this.ready = false;
		this.emitStatus("starting");
		const decoder = new LineDecoder();
		child.stdout.on("data", (chunk: Buffer) => {
			for (const msg of decoder.push(chunk.toString("utf8"))) this.receive(msg);
		});
		child.stderr.on("data", (chunk: Buffer) => this.opts.log?.(chunk.toString("utf8")));
		child.stdin.on("error", () => {});
		child.on("exit", () => this.onExit(child));
		child.on("error", (err: Error) => {
			this.opts.log?.(`spawn error: ${err.message}\n`);
			this.onExit(child);
		});
	}

	private receive(msg: FromHelper): void {
		if (msg.type === "ready" && this.child) {
			this.ready = true;
			this.emitStatus("ready");
			const pending = this.queue;
			this.queue = [];
			for (const m of pending) this.child.stdin.write(encodeMessage(m));
		}
		for (const h of this.handlers) h(msg);
	}

	private onExit(child: ChildProcessWithoutNullStreams): void {
		if (this.child !== child) return;
		this.child = null;
		this.ready = false;
		if (this.stopping) {
			this.emitStatus("stopped");
			return;
		}
		const now = (this.opts.now ?? Date.now)();
		const windowMs = this.opts.windowMs ?? 60_000;
		this.crashes = this.crashes.filter((t) => now - t < windowMs);
		this.crashes.push(now);
		if (this.crashes.length >= (this.opts.maxCrashes ?? 3)) {
			this.emitStatus("failed");
			return;
		}
		this.emitStatus("restarting");
		this.launch();
	}

	private emitStatus(s: BridgeStatus): void {
		for (const h of this.statusHandlers) h(s);
	}
}
