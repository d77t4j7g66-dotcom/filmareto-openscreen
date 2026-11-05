import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useScopedT } from "@/contexts/I18nContext";
import {
	type CropCorner,
	type CropRect,
	moveCrop,
	resizeCrop,
} from "@/lib/ai-edition/annotations/pipCrop";

interface PipCropDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** A `file://` URL of the recording to pick the area on. */
	videoSrc: string | null;
	/** Where in the recording the still is taken, in seconds. */
	seekSec: number;
	/** The area now replayed, in fractions of the frame. */
	value: CropRect;
	/** The chosen area, and the frame's own width over height (to turn it into a pixel shape). */
	onApply: (rect: CropRect, sourceAspect: number) => void;
}

const HANDLE = 14;
const CORNERS: Array<{ corner: CropCorner; left: string; top: string; cursor: string }> = [
	{ corner: "nw", left: "0%", top: "0%", cursor: "nwse-resize" },
	{ corner: "ne", left: "100%", top: "0%", cursor: "nesw-resize" },
	{ corner: "sw", left: "0%", top: "100%", cursor: "nesw-resize" },
	{ corner: "se", left: "100%", top: "100%", cursor: "nwse-resize" },
];

/**
 * A still of the recording with a rectangle on it: drag the rectangle to move it, drag a corner to
 * resize it. What is inside is what the PiP replays.
 */
export function PipCropDialog({
	open,
	onOpenChange,
	videoSrc,
	seekSec,
	value,
	onApply,
}: PipCropDialogProps) {
	const ts = useScopedT("settings");
	const [rect, setRect] = useState<CropRect>(value);
	const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const drag = useRef<{
		kind: "move" | CropCorner;
		startX: number;
		startY: number;
		start: CropRect;
	} | null>(null);

	useEffect(() => {
		if (open) setRect(value);
	}, [open, value]);

	const sourceAspect = natural ? natural.width / natural.height : 16 / 9;

	const begin = (kind: "move" | CropCorner) => (event: React.PointerEvent) => {
		event.preventDefault();
		event.stopPropagation();
		(event.currentTarget as Element).setPointerCapture(event.pointerId);
		drag.current = { kind, startX: event.clientX, startY: event.clientY, start: rect };
	};
	const onMove = (event: React.PointerEvent) => {
		const current = drag.current;
		const box = boxRef.current?.getBoundingClientRect();
		if (!current || !box || box.width === 0 || box.height === 0) return;
		const dx = (event.clientX - current.startX) / box.width;
		const dy = (event.clientY - current.startY) / box.height;
		setRect(
			current.kind === "move"
				? moveCrop(current.start, dx, dy)
				: resizeCrop(current.start, current.kind, dx, dy, { aspect: null, sourceAspect }),
		);
	};
	const end = () => {
		drag.current = null;
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-3xl" data-testid="pip-crop-dialog">
				<DialogHeader>
					<DialogTitle>{ts("annotation.pipCropTitle")}</DialogTitle>
				</DialogHeader>
				<p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>
					{ts("annotation.pipCropHint")}
				</p>
				{videoSrc ? (
					<div
						ref={boxRef}
						style={{
							position: "relative",
							userSelect: "none",
							touchAction: "none",
							overflow: "hidden",
						}}
						onPointerMove={onMove}
						onPointerUp={end}
						onPointerCancel={end}
					>
						{/* A still: the video is only ever seeked, never played. */}
						<video
							src={videoSrc}
							muted
							preload="auto"
							style={{ width: "100%", display: "block", borderRadius: 8 }}
							onLoadedMetadata={(event) => {
								const video = event.currentTarget;
								setNatural({ width: video.videoWidth, height: video.videoHeight });
								video.currentTime = Math.max(0, seekSec);
							}}
						>
							<track kind="captions" />
						</video>
						<div
							onPointerDown={begin("move")}
							style={{
								position: "absolute",
								left: `${rect.x * 100}%`,
								top: `${rect.y * 100}%`,
								width: `${rect.width * 100}%`,
								height: `${rect.height * 100}%`,
								border: "2px solid var(--accent, #34b27b)",
								boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
								cursor: "move",
								boxSizing: "border-box",
							}}
						>
							{CORNERS.map(({ corner, left, top, cursor }) => (
								<div
									key={corner}
									data-testid={`pip-crop-handle-${corner}`}
									onPointerDown={begin(corner)}
									style={{
										position: "absolute",
										left,
										top,
										width: HANDLE,
										height: HANDLE,
										marginLeft: -HANDLE / 2,
										marginTop: -HANDLE / 2,
										borderRadius: 4,
										background: "#fff",
										border: "2px solid var(--accent, #34b27b)",
										cursor,
										boxSizing: "border-box",
									}}
								/>
							))}
						</div>
					</div>
				) : (
					<p style={{ margin: 0 }}>{ts("annotation.pipCropNoVideo")}</p>
				)}
				<div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
					<button
						type="button"
						onClick={() => onOpenChange(false)}
						style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid var(--border)" }}
					>
						{ts("annotation.pipCropCancel")}
					</button>
					<button
						type="button"
						disabled={!videoSrc}
						onClick={() => {
							onApply(rect, sourceAspect);
							onOpenChange(false);
						}}
						style={{
							padding: "8px 14px",
							borderRadius: 10,
							background: "var(--accent, #34b27b)",
							color: "#fff",
							fontWeight: 600,
						}}
					>
						{ts("annotation.pipCropApply")}
					</button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
