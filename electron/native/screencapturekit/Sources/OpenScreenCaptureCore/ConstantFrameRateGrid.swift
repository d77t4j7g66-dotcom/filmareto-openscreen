import CoreMedia
import Foundation

/// Lays frames that arrive whenever they like on a constant frame-rate grid (1.2.0: "σταθερό ο
/// ρυθμός καρέ, αδιαπραγμάτευτο"). ScreenCaptureKit writes a frame only when the screen changes and
/// a camera's frames jitter, but a broadcast file and Resolve want one frame every 1/fps s.
///
/// Slot `n` is at `anchor + n / fps`. A frame takes the slot nearest its time (or the next free
/// one when it is within 3/4 of a slot of it, see `place`); a slot nothing
/// arrived for repeats the frame before it; a second frame for a slot already written is not
/// written (it becomes the frame a later empty slot repeats). Pure: the caller appends.
public struct ConstantFrameRateGrid {
	public let fps: Int32
	public private(set) var anchor: CMTime?
	/// The last slot written, -1 before the first.
	public private(set) var lastWrittenSlot: Int64 = -1

	public init(fps: Int32) {
		self.fps = max(1, fps)
	}

	/// The grid starts here: slot 0.
	public mutating func begin(at anchor: CMTime) {
		self.anchor = anchor
		lastWrittenSlot = -1
	}

	public func time(ofSlot slot: Int64) -> CMTime {
		CMTimeAdd(anchor ?? .zero, CMTime(value: slot, timescale: fps))
	}

	/// The slot nearest `time`, which may be negative before the anchor.
	public func slot(nearest time: CMTime) -> Int64 {
		guard let anchor else { return 0 }
		let seconds = CMTimeGetSeconds(CMTimeSubtract(time, anchor))
		return Int64((seconds * Double(fps)).rounded())
	}

	/// What to append for a frame that arrived at `time`: the empty slots before it, to repeat the
	/// previous frame into, and the slot for this frame, or `nil` when it lands on a slot already
	/// written (or before the anchor) and must not be written.
	public mutating func place(frameAt time: CMTime) -> (repeats: ClosedRange<Int64>?, slot: Int64?) {
		guard let anchor else { return (nil, nil) }
		// Sticky: a frame within 3/4 of a slot of the next free slot takes it. Nearest-slot
		// rounding alone flips at the half-slot boundary, and a camera's phase against the
		// screen's anchor is arbitrary (and drifts through that boundary over minutes), so a
		// source running at exactly the grid's rate came out as drop-and-repeat pairs: judder.
		let position = CMTimeGetSeconds(CMTimeSubtract(time, anchor)) * Double(fps)
		let next = lastWrittenSlot + 1
		let slot = lastWrittenSlot >= 0 && abs(position - Double(next)) <= 0.75
			? next : Int64(position.rounded())
		guard slot > lastWrittenSlot, slot >= 0 else { return (nil, nil) }
		let repeats = slot - 1 > lastWrittenSlot ? (lastWrittenSlot + 1)...(slot - 1) : nil
		return (repeats, slot)
	}

	/// The slots still empty up to the one that holds `time` minus `latency` slots: what a timer
	/// repeats the last frame into while no new frame comes (a still screen), kept `latency`
	/// slots behind the clock so a frame on its way still finds its own slot free.
	public func dueRepeats(upTo time: CMTime, latency: Int64 = 1) -> ClosedRange<Int64>? {
		guard anchor != nil, lastWrittenSlot >= 0 else { return nil }
		let last = slot(nearest: time) - latency
		return last > lastWrittenSlot ? (lastWrittenSlot + 1)...last : nil
	}

	/// Records that `slot` was written. Slots are written in order.
	public mutating func wrote(slot: Int64) {
		lastWrittenSlot = max(lastWrittenSlot, slot)
	}
}
