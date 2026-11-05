// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeLayoutHandles, snapAxis } from "./FreeLayoutHandles";

afterEach(cleanup);

describe("snapAxis", () => {
	it("jumps onto the frame's centre and onto either edge when close", () => {
		expect(snapAxis(50.9, 20)).toEqual({ value: 50, snapped: true });
		expect(snapAxis(10.8, 20)).toEqual({ value: 10, snapped: true });
		expect(snapAxis(89.4, 20)).toEqual({ value: 90, snapped: true });
	});

	it("leaves a box alone elsewhere, and never lets it leave the frame", () => {
		expect(snapAxis(30, 20)).toEqual({ value: 30, snapped: false });
		expect(snapAxis(2, 20).value).toBe(10);
		expect(snapAxis(99, 20).value).toBe(90);
	});
});

describe("FreeLayoutHandles", () => {
	const frameSize = { width: 1000, height: 500 };
	const frameRef = {
		current: {
			getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 }),
		} as HTMLDivElement,
	};
	const setup = () => {
		const onChange = vi.fn();
		const onCommit = vi.fn();
		render(
			<FreeLayoutHandles
				frameSize={frameSize}
				screenRect={{ x: 100, y: 50, width: 600, height: 375 }}
				cameraRect={{ x: 750, y: 350, width: 200, height: 112 }}
				frameRef={frameRef}
				onChange={onChange}
				onCommit={onCommit}
			/>,
		);
		const camera = screen.getByTestId("free-Cam-move");
		camera.setPointerCapture = vi.fn();
		camera.releasePointerCapture = vi.fn();
		return { camera, onChange, onCommit };
	};

	it("moves the camera by the pointer's travel and commits on release", () => {
		const { camera, onChange, onCommit } = setup();
		fireEvent.pointerDown(camera, { clientX: 850, clientY: 400, pointerId: 1 });
		fireEvent(camera, new MouseEvent("pointermove", { clientX: 750, clientY: 350 }));
		const patch = onChange.mock.calls.at(-1)?.[0];
		expect(patch.freeCamX).toBeCloseTo(75, 0);
		expect(patch.freeCamY).toBeCloseTo(71.2, 1);
		fireEvent(camera, new MouseEvent("pointerup", {}));
		expect(onCommit).toHaveBeenCalledTimes(1);
	});

	it("snaps the camera onto the frame's centre line", () => {
		const { camera, onChange } = setup();
		fireEvent.pointerDown(camera, { clientX: 850, clientY: 400, pointerId: 1 });
		fireEvent(camera, new MouseEvent("pointermove", { clientX: 505, clientY: 400 }));
		expect(onChange.mock.calls.at(-1)?.[0].freeCamX).toBe(50);
	});
});
