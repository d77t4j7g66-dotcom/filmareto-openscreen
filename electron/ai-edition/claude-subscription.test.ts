import { describe, expect, it, vi } from "vitest";
import { createStreamReader, describeFailure } from "./claude-subscription";

const lines = (...events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

describe("reading Claude's stream", () => {
	it("hands on text, thinking and tools, and keeps the answer and the session", () => {
		const text = vi.fn();
		const thinking = vi.fn();
		const toolStart = vi.fn();
		const toolEnd = vi.fn();
		const reader = createStreamReader({ text, thinking, toolStart, toolEnd });
		reader.feed(
			lines(
				{ type: "system", subtype: "init", session_id: "s1" },
				{ type: "stream_event", event: { delta: { type: "thinking_delta", thinking: "hm" } } },
				{ type: "stream_event", event: { delta: { type: "text_delta", text: "Έγινε" } } },
				{
					type: "assistant",
					message: {
						content: [
							{ type: "tool_use", id: "t1", name: "mcp__openscreen__addZoom", input: { depth: 3 } },
						],
					},
				},
				{
					type: "user",
					message: {
						content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "{}" }] }],
					},
				},
				{ type: "result", subtype: "success", is_error: false, result: "Έγινε.", session_id: "s1" },
			),
		);
		const result = reader.finish();
		expect(text).toHaveBeenCalledWith("Έγινε");
		expect(thinking).toHaveBeenCalledWith("hm");
		expect(toolStart).toHaveBeenCalledWith("addZoom", { depth: 3 });
		expect(toolEnd).toHaveBeenCalledWith("addZoom", true, "add zoom");
		expect(result).toEqual({ text: "Έγινε.", sessionId: "s1" });
	});

	it("copes with a line cut across two chunks, and with junk", () => {
		const reader = createStreamReader({});
		const raw = lines({ type: "result", is_error: false, result: "ok" });
		reader.feed("not json\n");
		reader.feed(raw.slice(0, 10));
		reader.feed(raw.slice(10));
		expect(reader.finish().text).toBe("ok");
	});

	it("passes a tool's error on, and reports a failed turn in words", () => {
		const toolEnd = vi.fn();
		const reader = createStreamReader({ toolEnd });
		reader.feed(
			lines(
				{
					type: "assistant",
					message: { content: [{ type: "tool_use", id: "t", name: "mcp__openscreen__addTrim" }] },
				},
				{
					type: "user",
					message: {
						content: [
							{ type: "tool_result", tool_use_id: "t", is_error: true, content: [{ type: "text", text: "no" }] },
						],
					},
				},
				{ type: "result", is_error: true, result: "You've hit your session limit" },
			),
		);
		expect(toolEnd).toHaveBeenCalledWith("addTrim", false, "no");
		expect(reader.finish().error).toMatch(/usage limit/);
	});
});

describe("describing a failure", () => {
	it("tells sign-in, limit and busy apart, and keeps anything else as it came", () => {
		expect(describeFailure("Not logged in · Please run /login")).toMatch(/not signed in/);
		expect(describeFailure("API Error: 529 overloaded")).toMatch(/busy/);
		expect(describeFailure("Something odd")).toBe("Something odd");
	});
});
