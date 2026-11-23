import CoreMedia
import XCTest

import OpenScreenCaptureCore

/// A broadcast file has one frame every 1/30 s whatever the source did: these pin how frames that
/// come late, early, twice or not at all land on that grid.
final class ConstantFrameRateGridTests: XCTestCase {
	private func at(_ seconds: Double) -> CMTime {
		CMTime(seconds: 100 + seconds, preferredTimescale: 600_000)
	}

	/// Writes frames at these times and returns, slot by slot, which frame each slot shows.
	private func run(_ arrivals: [Double], until end: Double? = nil) -> [Int] {
		var grid = ConstantFrameRateGrid(fps: 30)
		grid.begin(at: at(0))
		var slots: [Int] = []
		var last = -1
		for (index, arrival) in arrivals.enumerated() {
			let placed = grid.place(frameAt: at(arrival))
			if let repeats = placed.repeats {
				for slot in repeats {
					XCTAssertEqual(Int(slot), slots.count)
					slots.append(last)
					grid.wrote(slot: slot)
				}
			}
			if let slot = placed.slot {
				XCTAssertEqual(Int(slot), slots.count)
				slots.append(index)
				grid.wrote(slot: slot)
			}
			last = index
		}
		if let end, let repeats = grid.dueRepeats(upTo: at(end), latency: 0) {
			for slot in repeats {
				slots.append(last)
				grid.wrote(slot: slot)
			}
		}
		return slots
	}

	func testFramesOnTimeFillOneSlotEach() {
		XCTAssertEqual(run([0, 1.0 / 30, 2.0 / 30, 3.0 / 30]), [0, 1, 2, 3])
	}

	/// A still screen: one frame, then nothing for a third of a second. The gap repeats it.
	func testAStillScreenRepeatsTheLastFrame() {
		XCTAssertEqual(run([0, 10.0 / 30]), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
	}

	/// Jitter: a frame a few ms off still takes its own slot.
	func testJitterKeepsEachFrameOnItsSlot() {
		XCTAssertEqual(run([0.004, 1.0 / 30 - 0.006, 2.0 / 30 + 0.009]), [0, 1, 2])
	}

	/// Two frames for one slot (a source faster than the grid): the second is not written, and is
	/// what the next empty slot repeats.
	func testASecondFrameForASlotIsNotWrittenButRepeatedLater() {
		XCTAssertEqual(run([0, 0.005, 3.0 / 30]), [0, 1, 1, 2])
	}

	/// A camera exactly at the grid's rate but half a slot out of phase with the anchor, with
	/// ±3 ms of jitter: one frame per slot, never a drop-and-repeat pair.
	func testASourceHalfASlotOutOfPhaseStillFillsOneSlotEach() {
		var arrivals: [Double] = []
		for k in 0..<90 {
			arrivals.append((Double(k) + 0.5) / 30 + (k % 2 == 0 ? 0.003 : -0.003))
		}
		let slots = run(arrivals)
		// The first frame is nearer slot 1, so slot 0 holds it too (-1 here: no frame before it).
		XCTAssertEqual(slots.first, -1)
		XCTAssertEqual(Array(slots.dropFirst()), Array(0..<90), "then each frame in its own slot")
	}

	/// A source a little slow (29.9 fps) repeats a frame now and then; a little fast (30.1 fps)
	/// drops one now and then. Never both at once.
	func testDriftRepeatsOrDropsButNeverBoth() {
		let slow = run((0..<300).map { Double($0) / 29.9 })
		XCTAssertEqual(Set(slow).count, 300, "every frame written")
		XCTAssertGreaterThan(slow.count, 300, "a slot repeated")
		let fast = run((0..<300).map { Double($0) / 30.1 })
		XCTAssertEqual(fast.count, Set(fast).count, "nothing repeated")
		XCTAssertLessThan(fast.count, 300, "a frame dropped")
	}

	/// A frame before the anchor (the camera warming up before the take) is never written.
	func testFramesBeforeTheAnchorAreNotWritten() {
		XCTAssertEqual(run([-0.2, 0, 1.0 / 30]), [1, 2])
	}

	/// At the end of the take the timer fills the slots up to the stop with the last frame.
	func testTheTailIsFilledUpToTheStop() {
		XCTAssertEqual(run([0, 1.0 / 30], until: 4.0 / 30), [0, 1, 1, 1, 1])
	}

	/// A timer keeps a slot of latency, so a frame on its way still finds its own slot.
	func testDueRepeatsKeepALatencySlot() {
		var grid = ConstantFrameRateGrid(fps: 30)
		grid.begin(at: at(0))
		_ = grid.place(frameAt: at(0))
		grid.wrote(slot: 0)
		XCTAssertNil(grid.dueRepeats(upTo: at(1.0 / 30), latency: 1))
		XCTAssertEqual(grid.dueRepeats(upTo: at(3.0 / 30), latency: 1), 1...2)
		XCTAssertEqual(grid.time(ofSlot: 3), CMTimeAdd(at(0), CMTime(value: 3, timescale: 30)))
	}
}
