import XCTest
@testable import PrompterCore

final class CameraRuleTests: XCTestCase {
    func testMatchesIgnoringChromiumSuffixAndCase() {
        XCTAssertTrue(PrompterCamera.matches(label: "Lyra-CAM_3UXH (3547:0b05)", localizedName: "Lyra-CAM_3UXH"))
        XCTAssertTrue(PrompterCamera.matches(label: "  facetime hd camera (05AC:8514)", localizedName: "FaceTime HD Camera"))
        XCTAssertFalse(PrompterCamera.matches(label: "Cam (2)", localizedName: "Cam"))
        XCTAssertFalse(PrompterCamera.matches(label: "Cam A", localizedName: "Cam B"))
        XCTAssertFalse(PrompterCamera.matches(label: "", localizedName: ""))
    }

    func testShowsOnlyFullScreenOnAnotherScreenWithOpacityAndCamera() {
        XCTAssertTrue(PrompterCamera.shouldShow(position: .fullscreen, isMainScreen: false, opacity: 0.4, cameraAvailable: true))
        XCTAssertFalse(PrompterCamera.shouldShow(position: .fullscreen, isMainScreen: true, opacity: 0.4, cameraAvailable: true))
        XCTAssertFalse(PrompterCamera.shouldShow(position: .fullscreen, isMainScreen: false, opacity: 0, cameraAvailable: true))
        XCTAssertFalse(PrompterCamera.shouldShow(position: .fullscreen, isMainScreen: false, opacity: 0.4, cameraAvailable: false))
        for position in [PrompterPosition.notch, .free, .screen] {
            XCTAssertFalse(PrompterCamera.shouldShow(position: position, isMainScreen: false, opacity: 1, cameraAvailable: true))
        }
    }
}
