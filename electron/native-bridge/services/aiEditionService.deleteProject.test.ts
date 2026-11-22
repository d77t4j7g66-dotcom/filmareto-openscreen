import { describe, expect, it, vi } from "vitest";
import { AiEditionService, type AiEditionServiceOptions } from "./aiEditionService";

/**
 * Deleting a project used to unlink its file and leave every take on the disk ("Your recordings
 * are kept"), so the disk filled with takes nothing could reach. Now the project file goes to the
 * Trash, then its recordings, read from the document before it went.
 */
function service(overrides: Partial<AiEditionServiceOptions> = {}) {
	const calls: string[] = [];
	const doc = { project: { id: "proj_1" }, assets: [] };
	const options = {
		documents: {
			getProject: vi.fn(async () => {
				calls.push("read");
				return doc;
			}),
			filePathFor: (id: string) => `/projects/${id}.openscreen`,
			deleteProject: vi.fn(async () => {
				calls.push("delete");
			}),
		},
		llmConfig: () => {
			throw new Error("not used");
		},
		deleteChatHistory: async () => {
			calls.push("chat");
		},
		recordings: {
			trashFile: vi.fn(async (file: string) => {
				calls.push(`trash ${file}`);
			}),
			trashDeletedProject: vi.fn(async () => {
				calls.push("recordings");
				return { trashed: [], kept: [], failedClosed: false };
			}),
		},
		...overrides,
	} as unknown as AiEditionServiceOptions;
	return { service: new AiEditionService(options), calls, doc, options };
}

describe("AiEditionService.deleteProject", () => {
	it("sends the project file to the Trash, then its recordings", async () => {
		const { service: s, calls, doc, options } = service();

		expect(await s.deleteProject("proj_1")).toEqual({ success: true });

		expect(calls).toEqual([
			"read",
			"trash /projects/proj_1.openscreen",
			"delete",
			"recordings",
			"chat",
		]);
		expect(options.recordings?.trashDeletedProject).toHaveBeenCalledWith(doc);
	});

	it("still deletes a project whose recordings could not be cleaned", async () => {
		const { service: s } = service({
			recordings: {
				trashFile: async () => {},
				trashDeletedProject: async () => {
					throw new Error("disk");
				},
			},
		} as Partial<AiEditionServiceOptions>);

		expect(await s.deleteProject("proj_1")).toEqual({ success: true });
	});

	it("still removes the project when its file cannot go to the Trash", async () => {
		const { service: s, calls } = service({
			recordings: {
				trashFile: async () => {
					throw new Error("no Trash on this volume");
				},
				trashDeletedProject: async () => ({ trashed: [], kept: [], failedClosed: false }),
			},
		} as Partial<AiEditionServiceOptions>);

		expect(await s.deleteProject("proj_1")).toEqual({ success: true });
		expect(calls).toContain("delete");
	});

	it("deletes as before where nothing cleans recordings (CLI, tests)", async () => {
		const { service: s, calls } = service({ recordings: undefined });

		expect(await s.deleteProject("proj_1")).toEqual({ success: true });
		expect(calls).toEqual(["delete", "chat"]);
	});
});
