// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { HudSegmentControls } from "./HudControls";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: (scope: string) => (key: string, vars?: Record<string, unknown>) =>
		vars ? `${scope}.${key}:${JSON.stringify(vars)}` : `${scope}.${key}`,
}));

const wrap = (node: React.ReactElement) => <TooltipProvider>{node}</TooltipProvider>;

afterEach(cleanup);

describe("HudSegmentControls", () => {
	const props = {
		vertical: false,
		stageIndex: 0,
		stageCount: 4,
		onRetry: () => {},
		onNext: () => {},
	};

	it("shows only where the script stands on a first attempt", () => {
		render(wrap(<HudSegmentControls {...props} take={1} />));
		expect(screen.getByText("1/4")).toBeTruthy();
		expect(screen.queryByTestId("hud-segment-take")).toBeNull();
	});

	// "This segment again" keeps recording and the editor keeps the last attempt, so without a
	// sign on the bar the press looks like it did nothing.
	it("names the attempt once the segment is said again", () => {
		render(wrap(<HudSegmentControls {...props} take={2} />));
		expect(screen.getByTestId("hud-segment-take").textContent).toBe(
			'launch.scene.take:{"number":2}',
		);
	});
});
