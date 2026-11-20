import XCTest
@testable import PrompterCore

final class KeyCodesTests: XCTestCase {
    func testKnownKeys() {
        XCTAssertEqual(KeyCodes.code(for: "Space"), 49)
        XCTAssertEqual(KeyCodes.code(for: "R"), 15)
        XCTAssertEqual(KeyCodes.code(for: "Right"), 124)
        XCTAssertEqual(KeyCodes.code(for: "Equal"), 24)
        XCTAssertEqual(KeyCodes.code(for: "0"), 29)
        XCTAssertNil(KeyCodes.code(for: "F13"))
    }

    func testModifiers() {
        XCTAssertEqual(KeyCodes.modifiers(["ctrl", "alt"]), 4096 + 2048)
        XCTAssertEqual(KeyCodes.modifiers(["cmd", "shift"]), 256 + 512)
        XCTAssertEqual(KeyCodes.modifiers(["bogus"]), 0)
    }

    func testEveryKeyNameTheAppOffersHasACode() {
        let names = ["Space", "Up", "Down", "Left", "Right", "Equal", "Minus"] + "ABCDEFGHIJKLMNOPQRSTUVWXYZ".map(String.init) + "0123456789".map(String.init)
        for n in names { XCTAssertNotNil(KeyCodes.code(for: n), n) }
    }
}
