// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { RecordingKindModal } from "./Modals";

function renderModal(open = true) {
	const onPick = vi.fn();
	const onClose = vi.fn();
	render(
		<I18nProvider>
			<RecordingKindModal open={open} onClose={onClose} onPick={onPick} />
		</I18nProvider>,
	);
	return { onPick, onClose };
}

describe("RecordingKindModal", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("asks what is being recorded and offers three kinds and Cancel", () => {
		renderModal();

		expect(screen.getByText("What are you recording?")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /talking head/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /screen \+ camera/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /screen only/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
	});

	it.each([
		[/talking head/i, "talking-head"],
		[/screen \+ camera/i, "screen-camera"],
		[/screen only/i, "screen-only"],
	] as const)("picking %s reports %s and closes", (name, kind) => {
		const { onPick, onClose } = renderModal();

		fireEvent.click(screen.getByRole("button", { name }));

		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick).toHaveBeenCalledWith(kind);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("Cancel closes and picks nothing", () => {
		const { onPick, onClose } = renderModal();

		fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

		expect(onPick).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("renders nothing while closed", () => {
		renderModal(false);

		expect(screen.queryByText("What are you recording?")).not.toBeInTheDocument();
	});
});
