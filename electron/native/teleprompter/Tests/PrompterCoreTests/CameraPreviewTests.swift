import XCTest
@testable import PrompterCore

final class CameraPreviewTests: XCTestCase {
    private let main = DisplayRef(number: 1, uuid: "AAAA-1111")
    private let second = DisplayRef(number: 69733254, uuid: "BBBB-2222")
    private var displays: [DisplayRef] { [main, second] }

    private func config(enabled: Bool = true, display: String? = "69733254", camera: String? = "Cam (1234:abcd)", mirror: Bool = true) -> CameraPreviewConfig {
        CameraPreviewConfig(enabled: enabled, displayId: display, cameraName: camera, mirror: mirror)
    }

    // MARK: decoding

    func testDecodesSet() throws {
        XCTAssertEqual(
            try decodeInbound(#"{"type":"cameraPreview.set","enabled":true,"displayId":"69733254","cameraName":"Cam (1234:abcd)","mirror":true}"#),
            .cameraPreviewSet(config())
        )
    }

    func testDecodesNullsAndMissingMirror() throws {
        XCTAssertEqual(
            try decodeInbound(#"{"type":"cameraPreview.set","enabled":false,"displayId":null,"cameraName":null,"mirror":false}"#),
            .cameraPreviewSet(config(enabled: false, display: nil, camera: nil, mirror: false))
        )
        XCTAssertEqual(
            try decodeInbound(#"{"type":"cameraPreview.set","enabled":true,"displayId":"1","cameraName":"Cam"}"#),
            .cameraPreviewSet(config(display: "1", camera: "Cam", mirror: false))
        )
    }

    func testToleratesNumericDisplayId() throws {
        XCTAssertEqual(
            try decodeInbound(#"{"type":"cameraPreview.set","enabled":true,"displayId":69733254,"cameraName":"Cam","mirror":false}"#),
            .cameraPreviewSet(config(display: "69733254", camera: "Cam", mirror: false))
        )
    }

    func testRejectsSetWithoutEnabled() {
        XCTAssertThrowsError(try decodeInbound(#"{"type":"cameraPreview.set","displayId":"1","cameraName":"Cam","mirror":false}"#)) {
            XCTAssertEqual($0 as? ProtocolError, .badJSON)
        }
    }

    // MARK: display lookup

    func testFindsDisplayByNumberOrUUID() {
        XCTAssertEqual(CameraPreview.display(forId: "69733254", in: displays), second)
        XCTAssertEqual(CameraPreview.display(forId: " 1 ", in: displays), main)
        XCTAssertEqual(CameraPreview.display(forId: "bbbb-2222", in: displays), second)
    }

    func testMissingDisplayIsNil() {
        XCTAssertNil(CameraPreview.display(forId: "42", in: displays))
        XCTAssertNil(CameraPreview.display(forId: "69733254", in: [main]))
        XCTAssertNil(CameraPreview.display(forId: nil, in: displays))
        XCTAssertNil(CameraPreview.display(forId: "", in: displays))
        XCTAssertNil(CameraPreview.display(forId: "69733254", in: []))
    }

    // MARK: decide

    func testShowsWhenClosed() {
        XCTAssertEqual(CameraPreview.decide(config: config(), active: nil, displays: displays), .show(displayNumber: 69733254))
    }

    func testRepeatedSetWithSameValuesIsANoOp() {
        let c = config()
        XCTAssertEqual(CameraPreview.decide(config: c, active: c, displays: displays), .none)
    }

    func testAChangedValueShowsAgain() {
        let active = config()
        XCTAssertEqual(CameraPreview.decide(config: config(mirror: false), active: active, displays: displays), .show(displayNumber: 69733254))
        XCTAssertEqual(CameraPreview.decide(config: config(camera: "Other"), active: active, displays: displays), .show(displayNumber: 69733254))
        XCTAssertEqual(CameraPreview.decide(config: config(display: "1"), active: active, displays: displays), .show(displayNumber: 1))
    }

    func testDisabledNullCameraOrGoneDisplayCloses() {
        let active = config()
        XCTAssertEqual(CameraPreview.decide(config: config(enabled: false), active: active, displays: displays), .close)
        XCTAssertEqual(CameraPreview.decide(config: config(camera: nil), active: active, displays: displays), .close)
        XCTAssertEqual(CameraPreview.decide(config: config(camera: "  "), active: active, displays: displays), .close)
        XCTAssertEqual(CameraPreview.decide(config: config(display: nil), active: active, displays: displays), .close)
        XCTAssertEqual(CameraPreview.decide(config: active, active: active, displays: [main]), .close)
    }

    func testNothingToCloseIsANoOp() {
        XCTAssertEqual(CameraPreview.decide(config: config(enabled: false), active: nil, displays: displays), .none)
        XCTAssertEqual(CameraPreview.decide(config: config(), active: nil, displays: []), .none)
    }
}
