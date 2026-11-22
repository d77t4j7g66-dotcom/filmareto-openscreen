// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { TakeRow } from "./LayoutPanel";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: (scope: string) => (key: string) => `${scope}.${key}`,
}));

type Row = Parameters<typeof TakeRow>[0]["tl"];

/** Just what the row reads of a timeline: the clips and the take swap. */
function timeline(alternates?: { sourceStartSec: number; sourceEndSec: number }[]): Row {
	return {
		clips: [
			{
				id: "clip_1",
				assetId: "asset_1",
				sourceStartSec: 17,
				sourceEndSec: 28,
				timelineStartSec: 0,
				timelineEndSec: 11,
				alternates,
			},
		],
		showClipTake: vi.fn(),
	} as unknown as Row;
}

describe("TakeRow", () => {
	beforeEach(() => {
		useProjectStore.setState({ currentTimeSec: 0, document: null });
	});

	// A take with "segment again" opens the editor before its clips arrive: the row first renders
	// with nothing to show, then with the attempts. That second render used to throw React #310
	// (more hooks than the render before), which emptied the whole editor window.
	it("survives a clip gaining its attempts after the first render", () => {
		const { rerender } = render(<TakeRow tl={timeline()} onSeek={vi.fn()} />);
		expect(screen.queryByRole("group")).toBeNull();

		rerender(
			<TakeRow
				tl={timeline([
					{ sourceStartSec: 0, sourceEndSec: 8 },
					{ sourceStartSec: 8, sourceEndSec: 17 },
				])}
				onSeek={vi.fn()}
			/>,
		);

		expect(screen.getByRole("group", { name: "editor.studio.takes" })).toBeInTheDocument();
		expect(screen.getAllByRole("button")).toHaveLength(3);
		expect(screen.getByRole("button", { name: "3" })).toHaveAttribute("aria-pressed", "true");
	});

	// The take switch changes how long the clip is, so the playhead left where it was can be in
	// another clip, or past every clip: playback then jumped to a later scene instead of playing the
	// take that was picked. The picked take plays from its start, once the switch is saved.
	it("puts the playhead at the start of the clip once the picked take is in place", async () => {
		const order: string[] = [];
		const tl = timeline([{ sourceStartSec: 0, sourceEndSec: 8 }]);
		const clip = (tl as unknown as { clips: { timelineStartSec: number }[] }).clips[0];
		clip.timelineStartSec = 5.891;
		useProjectStore.setState({ currentTimeSec: 8.4 });
		(tl.showClipTake as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			order.push("switch");
		});
		const onSeek = vi.fn(() => order.push("seek"));
		render(<TakeRow tl={tl} onSeek={onSeek} />);

		fireEvent.click(screen.getByRole("button", { name: "1" }));

		await waitFor(() => expect(onSeek).toHaveBeenCalledWith(5.891));
		expect(order).toEqual(["switch", "seek"]);
	});

	it("survives a clip losing its attempts", () => {
		const { rerender } = render(
			<TakeRow tl={timeline([{ sourceStartSec: 0, sourceEndSec: 8 }])} onSeek={vi.fn()} />,
		);
		expect(screen.getAllByRole("button")).toHaveLength(2);

		rerender(<TakeRow tl={timeline()} onSeek={vi.fn()} />);

		expect(screen.queryByRole("group")).toBeNull();
	});
});
