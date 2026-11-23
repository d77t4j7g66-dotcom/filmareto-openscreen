import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createFaceTrackLooks,
	faceTrackArgs,
	faceTrackInterval,
	findFaceTrack,
	helperTimeoutMs,
	runFfmpegProcess,
} from "./talkingHead";

describe("faceTrackInterval", () => {
	it("is half a second for a short take and keeps a long one to 1200 samples", () => {
		expect(faceTrackInterval(10)).toBe(0.5);
		expect(faceTrackInterval(20 * 60)).toBe(1);
		expect(faceTrackInterval(40 * 60)).toBe(2);
		expect(Math.ceil((40 * 60) / faceTrackInterval(40 * 60))).toBeLessThanOrEqual(1200);
	});
});

describe("faceTrackArgs", () => {
	it("takes frames at 1 / interval, 640 px wide, in one call", () => {
		const args = faceTrackArgs("/in.mov", "/tmp/dir", 0.5);
		expect(args).toContain("/in.mov");
		expect(args[args.indexOf("-vf") + 1]).toBe("fps=1/0.5,scale=640:-2");
		expect(args[args.length - 1]).toBe("/tmp/dir/f_%05d.jpg");
	});
});

function harness(helperOutput: string | Error, frames = 3) {
	const calls: { ffmpegArgs?: string[]; dir?: string; helper?: string } = {};
	return {
		calls,
		opts: {
			ffmpeg: "ffmpeg",
			runFfmpeg: async (args: string[]) => {
				calls.ffmpegArgs = args;
				calls.dir = args[args.length - 1].replace(/\/f_%05d\.jpg$/, "");
				for (let i = 1; i <= frames; i += 1) {
					await fs.writeFile(`${calls.dir}/f_${String(i).padStart(5, "0")}.jpg`, "x");
				}
			},
			runHelper: async (helper: string, dir: string) => {
				calls.helper = helper;
				expect(dir).toBe(calls.dir);
				if (helperOutput instanceof Error) throw helperOutput;
				return helperOutput;
			},
		},
	};
}

describe("findFaceTrack", () => {
	it("uses the interval for a 10 s take, reads faces and misses, and removes the folder", async () => {
		const h = harness("f_00001.jpg 0.5 0.4 0.2\nf_00002.jpg none\nf_00003.jpg 0.5 0.4 0.2\n");
		const track = await findFaceTrack("/in.mov", 10, "/helper", h.opts);
		expect(h.calls.ffmpegArgs?.join(" ")).toContain("fps=1/0.5");
		expect(h.calls.helper).toBe("/helper");
		// Frame n shows (n - 0.5) * interval; the one with no face is bridged.
		expect(track?.map((p) => p.t)).toEqual([0.25, 0.75, 1.25]);
		expect(track?.[1].x).toBeCloseTo(0.5, 5);
		await expect(fs.access(h.calls.dir as string)).rejects.toThrow();
	});

	it("uses a 1 s interval for a 20 minute take", async () => {
		const h = harness("f_00001.jpg 0.5 0.4 0.2\nf_00002.jpg 0.5 0.4 0.2\n");
		await findFaceTrack("/in.mov", 20 * 60, "/helper", h.opts);
		expect(h.calls.ffmpegArgs?.join(" ")).toContain("fps=1/1,");
	});

	it("shifts every time by the camera's offset into the take's seconds, and drops what is before the take", async () => {
		const h = harness(
			"f_00001.jpg 0.5 0.4 0.2\nf_00002.jpg 0.5 0.4 0.2\nf_00003.jpg 0.5 0.4 0.2\nf_00004.jpg 0.5 0.4 0.2\n",
			4,
		);
		// The camera started 1 s before the take: its 0 s is the take's -1 s (take = camera + offset).
		const track = await findFaceTrack("/in.mov", 10, "/helper", { ...h.opts, offsetSec: -1 });
		expect(track?.map((p) => p.t)).toEqual([0.25, 0.75]);
		const later = await findFaceTrack("/in.mov", 10, "/helper", { ...h.opts, offsetSec: 2 });
		expect(later?.map((p) => p.t)).toEqual([2.25, 2.75, 3.25, 3.75]);
	});

	it("is null when no frame has a face", async () => {
		const h = harness("f_00001.jpg none\nf_00002.jpg none\n");
		expect(await findFaceTrack("/in.mov", 10, "/helper", h.opts)).toBeNull();
	});

	it("removes the folder when the helper fails", async () => {
		const h = harness(new Error("helper died"));
		await expect(findFaceTrack("/in.mov", 10, "/helper", h.opts)).rejects.toThrow("helper died");
		await expect(fs.access(h.calls.dir as string)).rejects.toThrow();
	});
});

describe("runFfmpegProcess", () => {
	it("resolves on exit 0, rejects on a failure and on a kill", async () => {
		await expect(runFfmpegProcess("/bin/sh", ["-c", "exit 0"])).resolves.toBeUndefined();
		await expect(runFfmpegProcess("/bin/sh", ["-c", "exit 3"])).rejects.toThrow();
		await expect(runFfmpegProcess("/bin/sh", ["-c", "kill -9 $$"])).rejects.toThrow();
	});
});

describe("helperTimeoutMs", () => {
	it("is 30 s plus 50 ms a frame, at most 15 minutes", () => {
		expect(helperTimeoutMs(1200)).toBe(90_000);
		expect(helperTimeoutMs(10_000_000)).toBe(15 * 60_000);
	});
});

describe("faceTrackArgs threads", () => {
	it("keeps ffmpeg to 2 threads", () => {
		const args = faceTrackArgs("/in.mov", "/d", 1);
		expect(args[args.indexOf("-threads") + 1]).toBe("2");
	});
});

/** Whether a process with this id still runs. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function until(check: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("a recording starting stops the face look", () => {
	it("kills the running ffmpeg, answers busy, and leaves no temp folder", async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "facetrack-test-"));
		const pidFile = path.join(scratch, "pid");
		let folder = "";
		const runHelper = vi.fn();
		// The real child-process path, with a stand-in for ffmpeg that runs until it is killed.
		const looks = createFaceTrackLooks((filePath, durationSec, helper, opts) =>
			findFaceTrack(filePath, durationSec, helper, {
				...opts,
				ffmpeg: "/bin/sh",
				runFfmpeg: (args, signal) => {
					folder = path.dirname(args[args.length - 1]);
					return runFfmpegProcess(
						"/bin/sh",
						["-c", `echo $$ > "${pidFile}"; exec sleep 30`],
						signal,
					);
				},
				runHelper,
			}),
		);
		const answer = looks.look("/in.mov", 10, "/helper", 0);
		let pid = 0;
		await until(async () => {
			pid = Number((await fs.readFile(pidFile, "utf8").catch(() => "")).trim());
			return pid > 0;
		});
		expect(alive(pid)).toBe(true);
		expect(looks.stopAll()).toBe(1);
		await expect(answer).resolves.toBe("busy");
		await until(() => !alive(pid));
		expect(runHelper).not.toHaveBeenCalled();
		await expect(fs.access(folder)).rejects.toThrow();
		expect(looks.stopAll()).toBe(0);
		await fs.rm(scratch, { recursive: true, force: true });
	});

	it("does not start the helper when stopped between ffmpeg and the helper", async () => {
		const runHelper = vi.fn();
		let looks: ReturnType<typeof createFaceTrackLooks> | null = null;
		looks = createFaceTrackLooks((filePath, durationSec, helper, opts) =>
			findFaceTrack(filePath, durationSec, helper, {
				...opts,
				ffmpeg: "ffmpeg",
				runFfmpeg: async () => {
					looks?.stopAll();
				},
				runHelper,
			}),
		);
		await expect(looks.look("/in.mov", 10, "/helper")).resolves.toBe("busy");
		expect(runHelper).not.toHaveBeenCalled();
	});

	it("answers the track, or undefined when it could not look, when nothing stops it", async () => {
		const h = harness("f_00001.jpg 0.5 0.4 0.2\n");
		const looks = createFaceTrackLooks((filePath, durationSec, helper, opts) =>
			findFaceTrack(filePath, durationSec, helper, { ...opts, ...h.opts }),
		);
		const track = await looks.look("/in.mov", 10, "/helper");
		expect(Array.isArray(track)).toBe(true);
		expect((track as Array<{ y: number }>)[0].y).toBeCloseTo(0.4, 5);
		const failing = createFaceTrackLooks(async () => {
			throw new Error("no pictures");
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(await failing.look("/in.mov", 10, "/helper")).toBeUndefined();
		warn.mockRestore();
	});
});

describe("runFfmpegProcess with a signal", () => {
	it("kills the child when the signal aborts", async () => {
		const controller = new AbortController();
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ffmpeg-signal-"));
		const pidFile = path.join(scratch, "pid");
		const run = runFfmpegProcess(
			"/bin/sh",
			["-c", `echo $$ > "${pidFile}"; exec sleep 30`],
			controller.signal,
		);
		let pid = 0;
		await until(async () => {
			pid = Number((await fs.readFile(pidFile, "utf8").catch(() => "")).trim());
			return pid > 0;
		});
		controller.abort();
		await expect(run).rejects.toThrow();
		await until(() => !alive(pid));
		await fs.rm(scratch, { recursive: true, force: true });
	});
});
