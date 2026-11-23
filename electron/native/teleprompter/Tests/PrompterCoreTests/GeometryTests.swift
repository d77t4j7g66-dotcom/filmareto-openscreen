import CoreGraphics
import XCTest
@testable import PrompterCore

final class GeometryTests: XCTestCase {
    func testTopFrameIsTopAnchoredAndCentredOnTheGivenDisplay() {
        // A second display placed to the right and above the main one.
        let visible = CGRect(x: 1512, y: 200, width: 1920, height: 1055)
        let f = Geometry.topFrame(visibleFrame: visible, width: 600, height: 180)
        XCTAssertEqual(f, CGRect(x: 1512 + 960 - 300, y: 1255 - 180, width: 600, height: 180))
        XCTAssertEqual(f.maxY, visible.maxY)
    }

    func testTopFrameCapsToTheVisibleArea() {
        let visible = CGRect(x: 0, y: 0, width: 800, height: 500)
        let f = Geometry.topFrame(visibleFrame: visible, width: 2000, height: 900)
        XCTAssertEqual(f, visible)
    }

    func testNotchFrameWithNotch() {
        let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
        let r = Geometry.notchFrame(screenFrame: screen, notchHeight: 32, menuBarHeight: 37, width: 560, contentHeight: 200)
        XCTAssertEqual(r.frame, CGRect(x: 476, y: 750, width: 560, height: 232))
        XCTAssertEqual(r.topInset, 32)
    }

    func testNotchFrameWithoutNotchSitsUnderTheMenuBar() {
        let screen = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let r = Geometry.notchFrame(screenFrame: screen, notchHeight: 0, menuBarHeight: 25, width: 560, contentHeight: 200)
        XCTAssertEqual(r.frame, CGRect(x: 680, y: 855, width: 560, height: 200))
        XCTAssertEqual(r.topInset, 0)
    }

    func testCenteredAndClamped() {
        let visible = CGRect(x: 0, y: 0, width: 1000, height: 800)
        XCTAssertEqual(Geometry.centeredFrame(visibleFrame: visible, width: 400, height: 200), CGRect(x: 300, y: 300, width: 400, height: 200))
        XCTAssertEqual(Geometry.clamp(CGRect(x: 900, y: -50, width: 400, height: 200), to: visible), CGRect(x: 600, y: 0, width: 400, height: 200))
    }

    func testFadeZone() {
        let frame = CGRect(x: 100, y: 100, width: 200, height: 100)
        XCTAssertTrue(Geometry.shouldFade(mouse: CGPoint(x: 70, y: 150), frame: frame))
        XCTAssertFalse(Geometry.shouldFade(mouse: CGPoint(x: 50, y: 150), frame: frame))
    }

    func testTargetOffset() {
        XCTAssertEqual(Geometry.targetOffset(lineTop: 300, viewportHeight: 300, readingFraction: 1.0 / 3.0), 200, accuracy: 0.001)
        XCTAssertEqual(Geometry.targetOffset(lineTop: 50, viewportHeight: 300, readingFraction: 1.0 / 3.0), 0)
    }

    func testWordStates() {
        XCTAssertEqual(ReadingModel.state(lineIndex: 0, wordIndex: 3, cursorLine: 1, cursorWord: 0), .previous)
        XCTAssertEqual(ReadingModel.state(lineIndex: 1, wordIndex: 0, cursorLine: 1, cursorWord: 0), .spoken)
        XCTAssertEqual(ReadingModel.state(lineIndex: 1, wordIndex: 1, cursorLine: 1, cursorWord: 0), .current)
        XCTAssertEqual(ReadingModel.state(lineIndex: 2, wordIndex: 0, cursorLine: 1, cursorWord: 0), .upcoming)
        XCTAssertEqual(ReadingModel.alpha(.current), 1.0)
        XCTAssertEqual(ReadingModel.alpha(.upcoming), 0.85)
        XCTAssertEqual(ReadingModel.alpha(.spoken), 0.35)
        XCTAssertEqual(ReadingModel.alpha(.previous), 0.35)
    }

    func testFrameStoreRoundTrip() {
        final class Memory: KeyValueStore {
            var values: [String: Data] = [:]
            func data(forKey key: String) -> Data? { values[key] }
            func set(_ data: Data?, forKey key: String) { values[key] = data }
        }
        let store = FrameStore(store: Memory())
        XCTAssertNil(store.frame(for: .free, display: "D1"))
        store.save(CGRect(x: 10, y: 20, width: 300, height: 150), for: .free, display: "D1")
        XCTAssertEqual(store.frame(for: .free, display: "D1"), CGRect(x: 10, y: 20, width: 300, height: 150))
        XCTAssertNil(store.frame(for: .screen, display: "D1"))
        XCTAssertNil(store.frame(for: .free, display: "D2"))
    }
}
