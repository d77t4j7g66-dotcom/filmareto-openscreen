import XCTest
@testable import PrompterCore

final class KeyCodesTests: XCTestCase {
    func testKnownKeys() {
        XCTAssertEqual(KeyCodes.code(for: "Space"), 49)
        XCTAssertEqual(KeyCodes.code(for: "R"), 15)
        XCTAssertEqual(KeyCodes.code(for: "Right"), 124)
        XCTAssertEqual(KeyCodes.code(for: "Equal"), 24)
        XCTAssertEqual(KeyCodes.code(for: "0"), 29)
        XCTAssertEqual(KeyCodes.code(for: "Keypad0"), 0x52)
        XCTAssertEqual(KeyCodes.code(for: "F1"), 0x7A)
        XCTAssertEqual(KeyCodes.code(for: "KeypadEnter"), 0x4C)
        XCTAssertEqual(KeyCodes.code(for: "Escape"), 0x35)
        XCTAssertEqual(KeyCodes.code(for: "Delete"), 0x75)
        XCTAssertNil(KeyCodes.code(for: "F20"))
        XCTAssertNil(KeyCodes.code(for: "Bogus"))
    }

    func testModifiers() {
        XCTAssertEqual(KeyCodes.modifiers(["ctrl", "alt"]), 4096 + 2048)
        XCTAssertEqual(KeyCodes.modifiers(["cmd", "shift"]), 256 + 512)
        XCTAssertEqual(KeyCodes.modifiers(["bogus"]), 0)
    }

    func testEveryKeyNameTheAppOffersHasACode() {
        let names = ["Space", "Up", "Down", "Left", "Right", "Equal", "Minus"]
            + "ABCDEFGHIJKLMNOPQRSTUVWXYZ".map(String.init)
            + "0123456789".map(String.init)
            + (0...9).map { "Keypad\($0)" }
            + ["KeypadPlus", "KeypadMinus", "KeypadMultiply", "KeypadDivide", "KeypadEnter", "KeypadDecimal", "KeypadEquals", "KeypadClear"]
            + (1...19).map { "F\($0)" }
            + ["Return", "Tab", "Escape", "Delete", "Home", "End", "PageUp", "PageDown", "Comma", "Period", "Slash", "Semicolon", "Quote", "LeftBracket", "RightBracket", "Backslash", "Grave"]
        for n in names {
            XCTAssertNotNil(KeyCodes.code(for: n), n)
            XCTAssertTrue(KeyCodes.supportedKeys.contains(n), n)
        }
        XCTAssertEqual(Set(KeyCodes.supportedKeys), Set(names))
        XCTAssertEqual(KeyCodes.supportedKeys.count, names.count)
    }

    func testEverySupportedKeyMapsAndNoTwoShareACode() {
        let codes = KeyCodes.supportedKeys.compactMap { KeyCodes.code(for: $0) }
        XCTAssertEqual(codes.count, KeyCodes.supportedKeys.count)
        XCTAssertEqual(Set(codes).count, codes.count, "two names share a key code")
    }
}
