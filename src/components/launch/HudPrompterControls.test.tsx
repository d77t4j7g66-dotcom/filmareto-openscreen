// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { HudPrompterControls } from "./HudControls";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: (scope: string) => (key: string) => `${scope}.${key}`,
}));

const wrap = (node: React.ReactElement) => <TooltipProvider>{node}</TooltipProvider>;

afterEach(cleanup);

describe("HudPrompterControls", () => {
	const base = { vertical: false, playing: false, speed: 4, onAction: () => {} };

	it("calls onAction with the right action for each button", () => {
		const onAction = vi.fn();
		render(wrap(<HudPrompterControls {...base} onAction={onAction} />));
		const expected: [string, string][] = [
			["launch.scene.action.prevStage", "prevStage"],
			["launch.scene.action.prevLine", "prevLine"],
			["launch.scene.play", "playPause"],
			["launch.scene.action.nextLine", "nextLine"],
			["launch.scene.action.slower", "slower"],
			["launch.scene.action.faster", "faster"],
		];
		for (const [label, action] of expected) {
			fireEvent.click(screen.getByRole("button", { name: label }));
			expect(onAction).toHaveBeenLastCalledWith(action);
		}
		expect(onAction).toHaveBeenCalledTimes(expected.length);
	});

	it("toggles the play button to pause while playing", () => {
		render(wrap(<HudPrompterControls {...base} playing />));
		expect(screen.getByRole("button", { name: "launch.scene.pause" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "launch.scene.play" })).toBeNull();
	});

	it("shows the speed, and omits it when unknown", () => {
		const { rerender } = render(wrap(<HudPrompterControls {...base} />));
		expect(screen.getByTestId("hud-prompter-speed").textContent).toBe("4");
		rerender(wrap(<HudPrompterControls {...base} speed={null} />));
		expect(screen.queryByTestId("hud-prompter-speed")).toBeNull();
	});

	it("renders in a vertical bar as a column", () => {
		render(wrap(<HudPrompterControls {...base} vertical />));
		expect(screen.getByTestId("hud-prompter-controls").className).toContain("flex-col");
	});
});
