import XCTest

import OpenScreenCaptureCore

final class CameraFormatChoiceTests: XCTestCase {
	private func format(_ width: Int, _ height: Int, fps: [ClosedRange<Double>], yuv: Bool = true) -> CameraFormatCandidate {
		CameraFormatCandidate(width: width, height: height, frameRateRanges: fps, isYCbCr420: yuv)
	}

	func testTheLargestThirtyFramesASecondFormatUnderTheCeilingWins() {
		let formats = [
			format(1280, 720, fps: [5...60]),
			format(1920, 1080, fps: [5...30]),
			format(3840, 2160, fps: [5...24]),
			format(2560, 1440, fps: [5...30]),
		]
		XCTAssertEqual(chooseCameraFormat(formats, fps: 30, maxWidth: 3840, maxHeight: 2160), 3)
		XCTAssertEqual(chooseCameraFormat(formats, fps: 30, maxWidth: 1920, maxHeight: 1080), 1)
	}

	func testFourTwoZeroBeatsMJPEGAtTheSameSize() {
		let formats = [
			format(1920, 1080, fps: [30...30], yuv: false),
			format(1920, 1080, fps: [30...30], yuv: true),
		]
		XCTAssertEqual(chooseCameraFormat(formats, fps: 30, maxWidth: 3840, maxHeight: 2160), 1)
	}

	func testNoFormatAtThirtyKeepsTheCamerasOwn() {
		XCTAssertNil(chooseCameraFormat([format(1920, 1080, fps: [25...25])], fps: 30, maxWidth: 3840, maxHeight: 2160))
	}

	func testTheCameraIsFoundByNameEvenWithUSBIds() {
		let devices = [(id: "a", name: "FaceTime HD Camera"), (id: "b", name: "Elgato Facecam")]
		XCTAssertEqual(chooseCameraDevice(devices, requestedID: "hash", requestedName: "Elgato Facecam (0fd9:0078)"), 1)
		XCTAssertEqual(chooseCameraDevice(devices, requestedID: "b", requestedName: nil), 1)
		XCTAssertEqual(chooseCameraDevice(devices, requestedID: nil, requestedName: "Gone"), 0)
		XCTAssertNil(chooseCameraDevice([], requestedID: nil, requestedName: nil))
	}
}
