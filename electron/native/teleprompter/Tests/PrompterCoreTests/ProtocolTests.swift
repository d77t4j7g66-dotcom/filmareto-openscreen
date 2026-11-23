import XCTest
@testable import PrompterCore

final class ProtocolTests: XCTestCase {
    private let settingsJSON = #"{"position":"notch","fontSize":28,"visibleLines":4,"width":560,"opacity":1,"screenOpacity":0.55,"mirror":false,"showCues":false,"fadeNearCursor":false,"mode":"voice","speed":4,"displayId":null,"activeLine":0.3333333333333333,"paddingH":16,"paddingV":0,"lineSpacing":1,"showGuide":true,"cameraOpacity":0}"#

    func testDecodesOpen() throws {
        let json = #"{"type":"prompter.open","startLineId":"hook-1","stage":{"id":"hook","name":"Hook","index":0,"count":2,"startDirections":[],"startCues":[],"lines":[{"id":"hook-1","words":[{"text":"Το","bold":false}],"directions":["κοίτα"],"cues":["sfx · whoosh"]}]},"settings":"# + settingsJSON + "}"
        guard case let .prompterOpen(stage, start, settings) = try decodeInbound(json) else { return XCTFail("wrong case") }
        XCTAssertEqual(stage.lines.first?.words.first?.text, "Το")
        XCTAssertEqual(stage.lines.first?.directions, ["κοίτα"])
        XCTAssertEqual(start, "hook-1")
        XCTAssertEqual(settings, PrompterSettings.default)
    }

    func testDecodesSmallMessages() throws {
        XCTAssertEqual(try decodeInbound(#"{"type":"prompter.setCursor","lineId":"a-1","wordIndex":3}"#), .prompterSetCursor(lineId: "a-1", wordIndex: 3))
        XCTAssertEqual(try decodeInbound(#"{"type":"prompter.setCamera","name":"Lyra-CAM_3UXH (3547:0b05)"}"#), .prompterSetCamera(name: "Lyra-CAM_3UXH (3547:0b05)"))
        XCTAssertEqual(try decodeInbound(#"{"type":"prompter.setCamera","name":null}"#), .prompterSetCamera(name: nil))
        XCTAssertEqual(try decodeInbound(#"{"type":"prompter.setPlaying","playing":true}"#), .prompterSetPlaying(true))
        XCTAssertEqual(try decodeInbound(#"{"type":"prompter.setVisible","visible":false}"#), .prompterSetVisible(false))
        XCTAssertEqual(try decodeInbound(#"{"type":"prompter.stageEnd","hint":"Τέλος"}"#), .prompterStageEnd(hint: "Τέλος"))
        XCTAssertEqual(try decodeInbound(#"{"type":"prompter.countdown","seconds":3}"#), .prompterCountdown(seconds: 3))
        XCTAssertEqual(try decodeInbound(#"{"type":"prompter.status","text":null}"#), .prompterStatus(nil))
        XCTAssertEqual(try decodeInbound(#"{"type":"prompter.close"}"#), .prompterClose)
        XCTAssertEqual(try decodeInbound(#"{"type":"speech.start","sessionId":7,"deviceId":null,"contextualStrings":["Instagram"]}"#), .speechStart(sessionId: 7, deviceId: nil, contextualStrings: ["Instagram"]))
        XCTAssertEqual(try decodeInbound(#"{"type":"speech.stop"}"#), .speechStop)
        XCTAssertEqual(try decodeInbound(#"{"type":"speech.file","path":"/tmp/a.wav","contextualStrings":[]}"#), .speechFile(path: "/tmp/a.wav", contextualStrings: []))
        XCTAssertEqual(try decodeInbound(#"{"type":"hotkeys.set","bindings":[{"action":"playPause","key":"Space","modifiers":["ctrl","alt"]}]}"#), .hotkeysSet([HotkeyBinding(action: "playPause", key: "Space", modifiers: ["ctrl", "alt"])]))
        XCTAssertEqual(try decodeInbound(#"{"type":"audio.listDevices"}"#), .audioListDevices)
        XCTAssertEqual(try decodeInbound(#"{"type":"prompter.setSettings","settings":"# + settingsJSON + "}"), .prompterSetSettings(.default))
    }

    func testRejectsUnknownAndBadInput() {
        XCTAssertThrowsError(try decodeInbound(#"{"type":"nope"}"#)) { XCTAssertEqual($0 as? ProtocolError, .unknownType("nope")) }
        XCTAssertThrowsError(try decodeInbound("not json")) { XCTAssertEqual($0 as? ProtocolError, .badJSON) }
        XCTAssertThrowsError(try decodeInbound(#"{"type":"prompter.setCursor"}"#)) { XCTAssertEqual($0 as? ProtocolError, .badJSON) }
    }

    func testEncodesSortedSingleLine() {
        XCTAssertEqual(encodeOutbound(["type": "ready", "version": "0.1.0"]), "{\"type\":\"ready\",\"version\":\"0.1.0\"}\n")
    }
}
