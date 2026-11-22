// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { EditorPackageDialog, type PackageDialogState } from "./EditorPackageDialog";

afterEach(cleanup);

function setup(state: PackageDialogState | null) {
	const handlers = { onReveal: vi.fn(), onChoose: vi.fn(), onClose: vi.fn() };
	render(
		<I18nProvider>
			<EditorPackageDialog state={state} {...handlers} />
		</I18nProvider>,
	);
	return handlers;
}

describe("EditorPackageDialog", () => {
	it("renders nothing without a state", () => {
		setup(null);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("shows a progress bar at copiedBytes / totalBytes while packing", () => {
		setup({ kind: "packing", progress: { copiedBytes: 250, totalBytes: 1000 } });
		const bar = screen.getByRole("progressbar");
		expect(bar).toHaveAttribute("aria-valuenow", "25");
		expect(bar).toHaveAttribute("aria-valuemin", "0");
		expect(bar).toHaveAttribute("aria-valuemax", "100");
	});

	it("does not divide by zero when the total is not known yet", () => {
		setup({ kind: "packing", progress: { copiedBytes: 0, totalBytes: 0 } });
		expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
	});

	it("lists every missing file", () => {
		setup({ kind: "missing", files: ["a/take1.mp4", "b/take2.mov", "voice.wav"] });
		for (const name of ["a/take1.mp4", "b/take2.mov", "voice.wav"]) {
			expect(screen.getByText(name)).toBeInTheDocument();
		}
	});

	it("offers replace and copy on a conflict", () => {
		const { onChoose } = setup({ kind: "conflict", title: "My Film" });
		expect(screen.getByText(/My Film/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /replace/i }));
		expect(onChoose).toHaveBeenLastCalledWith("replace");
		fireEvent.click(screen.getByRole("button", { name: /copy/i }));
		expect(onChoose).toHaveBeenLastCalledWith("copy");
	});

	it("makes Open as copy the primary button and Replace the secondary", () => {
		setup({ kind: "conflict", title: "My Film" });
		expect(screen.getByRole("button", { name: /copy/i }).className).toMatch(/btnPrimary/);
		expect(screen.getByRole("button", { name: /replace/i }).className).toMatch(/btnSecondary/);
	});

	it("reveals the package from the packed state", () => {
		const { onReveal } = setup({ kind: "packed", zipPath: "/rec/Πακέτα/Film.zip" });
		expect(screen.getByText(/Film\.zip/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /show in folder/i }));
		expect(onReveal).toHaveBeenCalledTimes(1);
	});

	it("names the opened project and the error reason", () => {
		const first = render(
			<I18nProvider>
				<EditorPackageDialog
					state={{ kind: "opened", title: "My Film" }}
					onReveal={vi.fn()}
					onChoose={vi.fn()}
					onClose={vi.fn()}
				/>
			</I18nProvider>,
		);
		expect(screen.getByText(/My Film/)).toBeInTheDocument();
		first.unmount();
		setup({ kind: "error", reason: "disk full" });
		expect(screen.getByText("disk full")).toBeInTheDocument();
	});

	it("closes from the close button", () => {
		const { onClose } = setup({ kind: "error", reason: "x" });
		fireEvent.click(screen.getAllByRole("button", { name: /close/i })[0]);
		expect(onClose).toHaveBeenCalled();
	});
});
