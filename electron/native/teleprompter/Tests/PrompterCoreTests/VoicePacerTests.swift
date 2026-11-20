import CoreGraphics
import XCTest
@testable import PrompterCore

final class VoicePacerTests: XCTestCase {
    private let dt: CGFloat = 1.0 / 60.0
    /// 40 pt per word, so the default rate of 2.5 words a second is 100 pt/s.
    private func make(maxOffset: CGFloat = 100_000) -> VoicePacer {
        var p = VoicePacer()
        p.configure(maxOffset: maxOffset, defaultRate: 100, backwardThreshold: 20)
        return p
    }

    /// Runs `seconds`, hearing one word every `every` seconds, each `step` points further on.
    private func speak(_ p: inout VoicePacer, from start: CGFloat, every: CGFloat, step: CGFloat, seconds: CGFloat, onFrame: (CGFloat) -> Void = { _ in }) -> CGFloat {
        var position = start
        var nextWord: CGFloat = 0
        var t: CGFloat = 0
        while t < seconds {
            if t >= nextWord {
                position += step
                p.heard(position: position)
                nextWord += every
            }
            onFrame(p.step(dt: dt))
            t += dt
        }
        return position
    }

    private func run(_ p: inout VoicePacer, seconds: CGFloat, onFrame: (CGFloat) -> Void = { _ in }) {
        var t: CGFloat = 0
        while t < seconds {
            onFrame(p.step(dt: dt))
            t += dt
        }
    }

    func testDoesNotMoveBeforeWords() {
        var p = make()
        run(&p, seconds: 5)
        XCTAssertEqual(p.offset, 0)
    }

    func testStartsSmoothlyAfterTheFirstWord() {
        var p = make()
        p.heard(position: 40)
        var last: CGFloat = 0
        run(&p, seconds: 1) { o in
            XCTAssertLessThan(o - last, 300 * self.dt + 0.01, "no jumps")
            last = o
        }
        XCTAssertGreaterThan(p.offset, 20)
    }

    func testUsesTheDefaultRateBeforeThereIsData() {
        var p = make()
        p.heard(position: 40)
        XCTAssertEqual(p.rate, 100)
    }

    func testFollowsTheSpeakingRate() {
        var fast = make()
        _ = speak(&fast, from: 0, every: 0.2, step: 40, seconds: 6) // 5 words/s = 200 pt/s
        XCTAssertEqual(fast.rate, 200, accuracy: 15)
        var slow = make()
        _ = speak(&slow, from: 0, every: 1.0, step: 40, seconds: 8) // 1 word/s = 40 pt/s
        XCTAssertEqual(slow.rate, 40, accuracy: 8)
        XCTAssertGreaterThan(fast.offset, slow.offset)
    }

    func testLeadsHeardPositionByTheRecognizerLag() {
        var p = make()
        let heard = speak(&p, from: 0, every: 0.4, step: 40, seconds: 10) // 100 pt/s
        XCTAssertEqual(p.offset, heard + 100 * 1.0, accuracy: 45)
        XCTAssertGreaterThan(p.offset, heard + 50)
    }

    func testNeverReversesWhenAhead() {
        var p = make()
        var last: CGFloat = 0
        let check: (CGFloat) -> Void = { o in
            XCTAssertGreaterThanOrEqual(o, last)
            last = o
        }
        let heard = speak(&p, from: 0, every: 0.2, step: 40, seconds: 5, onFrame: check)
        // Suddenly much slower, with small forward steps, so the text is ahead.
        let later = speak(&p, from: heard, every: 1.0, step: 5, seconds: 6, onFrame: check)
        XCTAssertGreaterThan(p.offset, later)
    }

    func testEasesToAStopInSilence() {
        var p = make()
        _ = speak(&p, from: 0, every: 0.4, step: 40, seconds: 5)
        run(&p, seconds: 1.0)
        XCTAssertGreaterThan(p.velocity, 50, "still moving just after the words stop")
        run(&p, seconds: 0.6)
        let easing = p.velocity
        XCTAssertLessThan(easing, 100)
        XCTAssertGreaterThan(easing, 0)
        run(&p, seconds: 0.7)
        XCTAssertEqual(p.velocity, 0)
        let held = p.offset
        run(&p, seconds: 3)
        XCTAssertEqual(p.offset, held)
    }

    func testResumesWhenWordsReturn() {
        var p = make()
        let heard = speak(&p, from: 0, every: 0.4, step: 40, seconds: 5)
        run(&p, seconds: 4)
        let held = p.offset
        _ = speak(&p, from: heard + 200, every: 0.4, step: 40, seconds: 2)
        XCTAssertGreaterThan(p.offset, held)
    }

    func testSnapsBackOnALargeBackwardMoveThenContinues() {
        var p = make()
        let heard = speak(&p, from: 0, every: 0.4, step: 40, seconds: 8)
        p.heard(position: heard - 400)
        run(&p, seconds: 0.5)
        XCTAssertLessThan(p.offset, heard - 200)
        XCTAssertGreaterThanOrEqual(p.offset, heard - 400)
        let after = p.offset
        run(&p, seconds: 0.5)
        XCTAssertGreaterThan(p.offset, after, "pacing continues")
    }

    func testJumpNeedsNoWordsAndThenWaits() {
        var p = make()
        _ = speak(&p, from: 0, every: 0.4, step: 40, seconds: 5)
        p.jump(to: 50)
        run(&p, seconds: 1)
        XCTAssertEqual(p.offset, 50)
        run(&p, seconds: 2)
        XCTAssertEqual(p.offset, 50)
    }

    func testAPlacedPacerHoldsUntilWords() {
        var p = make()
        _ = speak(&p, from: 0, every: 0.4, step: 40, seconds: 3)
        p.place(offset: 123, lastHeard: 100)
        run(&p, seconds: 2)
        XCTAssertEqual(p.offset, 123)
        p.heard(position: 140)
        XCTAssertEqual(p.step(dt: dt), 123, accuracy: 3, "a forward word does not snap")
    }

    func testRestingOffsetIsTheJumpTargetDuringASnap() {
        var p = make()
        _ = speak(&p, from: 0, every: 0.4, step: 40, seconds: 8)
        XCTAssertEqual(p.restingOffset, p.offset)
        p.jump(to: 50)
        _ = p.step(dt: dt)
        XCTAssertGreaterThan(p.offset, 50)
        XCTAssertEqual(p.restingOffset, 50)
    }

    func testSnapAfterPlaceReachesTheTargetAndHolds() {
        var p = make()
        p.place(offset: 300, lastHeard: 280)
        p.snap(to: 50)
        run(&p, seconds: 1)
        XCTAssertEqual(p.offset, 50)
    }

    func testClampsAtTheEnd() {
        var p = make(maxOffset: 200)
        _ = speak(&p, from: 0, every: 0.2, step: 40, seconds: 8)
        XCTAssertEqual(p.offset, 200)
        p.jump(to: -50)
        run(&p, seconds: 1)
        XCTAssertEqual(p.offset, 0)
    }

    func testWordPositionsAreTheLineTopPlusProgress() {
        let out = VoicePacer.wordPositions(wrappedTops: [0, 0, 34], lengths: [3, 1, 2], lineHeight: 34)
        XCTAssertEqual(out[0], 25.5, accuracy: 0.001)
        XCTAssertEqual(out[1], 34, accuracy: 0.001)
        XCTAssertEqual(out[2], 68, accuracy: 0.001)
    }
}
