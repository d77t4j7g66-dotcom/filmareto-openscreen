import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";

type Box = { x: number; y: number; width: number; height: number };
type Key = "Screen" | "Cam";
type Setter = (patch: Record<string, number>) => void;

/** How close (percent of the frame) a box has to come to a centre or an edge to jump onto it. */
const SNAP = 1.5;

/**
 * Where a box's centre lands on one axis: on the frame's centre, or flush with either edge,
 * when it is close to one. `size` is the box's extent on that axis, in percent of the frame.
 */
export function snapAxis(centre: number, size: number): { value: number; snapped: boolean } {
	const half = size / 2;
	const targets = [50, half, 100 - half];
	let best = centre;
	let bestDistance = SNAP;
	let snapped = false;
	for (const target of targets) {
		const distance = Math.abs(centre - target);
		if (distance <= bestDistance) {
			best = target;
			bestDistance = distance;
			snapped = true;
		}
	}
	return { value: Math.min(100 - half, Math.max(half, best)), snapped };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Free layout: drag the screen (by its grip) and the camera (anywhere on it) to place them, and
 * pull the corner handle to size them. A box jumps onto the frame's centre and edges. Boxes are in
 * frame pixels; the settings are the box centre and width in percent of the frame.
 */
export function FreeLayoutHandles(props: {
	frameSize: { width: number; height: number };
	screenRect: Box;
	cameraRect: Box | null;
	frameRef: React.RefObject<HTMLDivElement | null>;
	onChange: Setter;
	onCommit: () => void;
}) {
	const { frameSize, screenRect, cameraRect, frameRef, onChange, onCommit } = props;
	const [guides, setGuides] = useState({ v: false, h: false });
	const drag = useRef<{ stop: () => void } | null>(null);

	const start = (
		event: ReactPointerEvent<HTMLElement>,
		key: Key,
		rect: Box,
		mode: "move" | "size",
	) => {
		const frame = frameRef.current?.getBoundingClientRect();
		if (!frame || frame.width <= 0) return;
		event.preventDefault();
		event.stopPropagation();
		const target = event.currentTarget;
		target.setPointerCapture(event.pointerId);
		const wPct = (rect.width / frameSize.width) * 100;
		const hPct = (rect.height / frameSize.height) * 100;
		const leftPct = (rect.x / frameSize.width) * 100;
		const topPct = (rect.y / frameSize.height) * 100;
		const aspect = rect.width / Math.max(1, rect.height);
		const grabX = ((event.clientX - frame.left) / frame.width) * 100 - (leftPct + wPct / 2);
		const grabY = ((event.clientY - frame.top) / frame.height) * 100 - (topPct + hPct / 2);
		const minWidth = key === "Screen" ? 10 : 5;

		const move = (e: PointerEvent) => {
			const px = ((e.clientX - frame.left) / frame.width) * 100;
			const py = ((e.clientY - frame.top) / frame.height) * 100;
			if (mode === "move") {
				const x = snapAxis(px - grabX, wPct);
				const y = snapAxis(py - grabY, hPct);
				setGuides({ v: x.snapped, h: y.snapped });
				onChange({
					[`free${key}X`]: Math.round(x.value * 10) / 10,
					[`free${key}Y`]: Math.round(y.value * 10) / 10,
				});
				return;
			}
			// The top-left corner stays put; the box keeps its shape as it grows.
			const width = clamp(px - leftPct, minWidth, 100 - leftPct);
			const height = ((width / 100) * frameSize.width) / aspect / frameSize.height;
			const heightPct = height * 100;
			onChange({
				[`free${key}Width`]: Math.round(width * 10) / 10,
				[`free${key}X`]: Math.round((leftPct + width / 2) * 10) / 10,
				[`free${key}Y`]: Math.round((topPct + heightPct / 2) * 10) / 10,
			});
		};
		const stop = () => {
			target.removeEventListener("pointermove", move as EventListener);
			target.removeEventListener("pointerup", up);
			target.removeEventListener("pointercancel", up);
			try {
				target.releasePointerCapture(event.pointerId);
			} catch {
				// already released
			}
			drag.current = null;
		};
		const up = () => {
			stop();
			setGuides({ v: false, h: false });
			onCommit();
		};
		target.addEventListener("pointermove", move as EventListener);
		target.addEventListener("pointerup", up);
		target.addEventListener("pointercancel", up);
		drag.current = { stop };
	};

	const pct = (rect: Box) => ({
		position: "absolute" as const,
		left: `${(rect.x / frameSize.width) * 100}%`,
		top: `${(rect.y / frameSize.height) * 100}%`,
		width: `${(rect.width / frameSize.width) * 100}%`,
		height: `${(rect.height / frameSize.height) * 100}%`,
	});
	const outline = "1.5px dashed rgba(255,255,255,0.75)";
	const handle = (rect: Box, key: Key, label: string) => (
		<>
			<div
				data-testid={`free-${key}-outline`}
				style={{ ...pct(rect), border: outline, pointerEvents: "none", borderRadius: 4 }}
			/>
			<div
				aria-hidden="true"
				title={label}
				data-testid={`free-${key}-resize`}
				onPointerDown={(e) => start(e, key, rect, "size")}
				style={{
					position: "absolute",
					left: `calc(${((rect.x + rect.width) / frameSize.width) * 100}% - 7px)`,
					top: `calc(${((rect.y + rect.height) / frameSize.height) * 100}% - 7px)`,
					width: 14,
					height: 14,
					borderRadius: 4,
					background: "#10b981",
					border: "2px solid #08090d",
					cursor: "nwse-resize",
					touchAction: "none",
					pointerEvents: "auto",
				}}
			/>
		</>
	);

	return (
		<div
			data-testid="free-layout-handles"
			// Above the screen stage (1) and the camera slot (2), which would otherwise take every grab.
			style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 3 }}
		>
			{guides.v ? (
				<div
					style={{
						position: "absolute",
						left: "50%",
						top: 0,
						bottom: 0,
						width: 0,
						borderLeft: "1px dashed #10b981",
					}}
				/>
			) : null}
			{guides.h ? (
				<div
					style={{
						position: "absolute",
						top: "50%",
						left: 0,
						right: 0,
						height: 0,
						borderTop: "1px dashed #10b981",
					}}
				/>
			) : null}
			{handle(screenRect, "Screen", "Screen size")}
			<div
				data-testid="free-Screen-move"
				onPointerDown={(e) => start(e, "Screen", screenRect, "move")}
				style={{
					position: "absolute",
					left: `calc(${((screenRect.x + screenRect.width / 2) / frameSize.width) * 100}% - 22px)`,
					top: `calc(${(screenRect.y / frameSize.height) * 100}% + 6px)`,
					width: 44,
					height: 18,
					borderRadius: 9,
					background: "rgba(8,9,13,0.75)",
					border: "1px solid rgba(255,255,255,0.6)",
					color: "#fff",
					fontSize: 11,
					lineHeight: "16px",
					textAlign: "center",
					cursor: "move",
					touchAction: "none",
					userSelect: "none",
					pointerEvents: "auto",
				}}
			>
				✥
			</div>
			{cameraRect ? (
				<>
					<div
						data-testid="free-Cam-move"
						onPointerDown={(e) => start(e, "Cam", cameraRect, "move")}
						style={{
							...pct(cameraRect),
							cursor: "move",
							touchAction: "none",
							pointerEvents: "auto",
						}}
					/>
					{handle(cameraRect, "Cam", "Camera size")}
				</>
			) : null}
		</div>
	);
}
