// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { HudKeysButton } from "./HudControls";

const wrap = (node: React.ReactElement) => <TooltipProvider>{node}</TooltipProvider>;

afterEach(cleanup);

describe("HudKeysButton", () => {
	it("shows its three states and only reports on as pressed", () => {
		const { rerender } = render(
			wrap(<HudKeysButton state="on" locked={false} name="Keys" tooltip="t" onClick={() => {}} />),
		);
		const button = screen.getByTestId("launch-keys-button");
		expect(button.getAttribute("data-state")).toBe("on");
		expect(button.getAttribute("aria-pressed")).toBe("true");
		rerender(
			wrap(
				<HudKeysButton state="paused" locked={false} name="Keys" tooltip="t" onClick={() => {}} />,
			),
		);
		expect(button.getAttribute("data-state")).toBe("paused");
		expect(button.getAttribute("aria-pressed")).toBe("false");
		rerender(
			wrap(<HudKeysButton state="off" locked={false} name="Keys" tooltip="t" onClick={() => {}} />),
		);
		expect(button.getAttribute("data-state")).toBe("off");
	});

	it("does nothing when locked", () => {
		const onClick = vi.fn();
		render(wrap(<HudKeysButton state="off" locked name="Keys" tooltip="t" onClick={onClick} />));
		fireEvent.click(screen.getByTestId("launch-keys-button"));
		expect(onClick).not.toHaveBeenCalled();
	});
});
