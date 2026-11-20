import Foundation

public enum PrompterPosition: String, Codable, Equatable { case notch, free, screen, fullscreen }
public enum PrompterMode: String, Codable, Equatable { case voice, manual, bullets }

public struct PrompterSettings: Codable, Equatable {
    public var position: PrompterPosition
    public var fontSize: Double
    public var visibleLines: Int
    public var width: Double
    public var opacity: Double
    public var screenOpacity: Double
    public var mirror: Bool
    public var showCues: Bool
    public var fadeNearCursor: Bool
    public var mode: PrompterMode
    public var speed: Double
    /// Display chosen for the top and full-screen positions. Nil follows the notch, then the mouse.
    public var displayId: Int?
    /// Height of the reading line in the text area, 0 at the top and 1 at the bottom.
    public var activeLine: Double
    public var paddingH: Double
    public var paddingV: Double
    public var lineSpacing: Double
    public var showGuide: Bool

    public static let `default` = PrompterSettings(
        position: .notch, fontSize: 28, visibleLines: 4, width: 560, opacity: 1, screenOpacity: 0.55,
        mirror: false, showCues: false, fadeNearCursor: false, mode: .voice, speed: 4,
        displayId: nil, activeLine: 1.0 / 3.0, paddingH: 16, paddingV: 0, lineSpacing: 1, showGuide: true
    )
}

public struct PrompterWord: Codable, Equatable { public var text: String; public var bold: Bool }
public struct PrompterLine: Codable, Equatable { public var id: String; public var words: [PrompterWord]; public var directions: [String]; public var cues: [String] }
public struct PrompterStage: Codable, Equatable {
    public var id: String
    public var name: String
    public var index: Int
    public var count: Int
    public var startDirections: [String]
    public var startCues: [String]
    public var lines: [PrompterLine]
}
public struct HotkeyBinding: Codable, Equatable { public var action: String; public var key: String; public var modifiers: [String] }

public enum Inbound: Equatable {
    case prompterOpen(stage: PrompterStage, startLineId: String, settings: PrompterSettings)
    case prompterSetCursor(lineId: String, wordIndex: Int)
    case prompterSetSettings(PrompterSettings)
    case prompterSetPlaying(Bool)
    case prompterSetVisible(Bool)
    case prompterStageEnd(hint: String)
    case prompterCountdown(seconds: Int)
    case prompterStatus(String?)
    case prompterClose
    case speechStart(sessionId: Int, deviceId: String?, contextualStrings: [String])
    case speechStop
    case speechFile(path: String, contextualStrings: [String])
    case hotkeysSet([HotkeyBinding])
    case audioListDevices
}

public enum ProtocolError: Error, Equatable {
    case badJSON
    case unknownType(String)
}

private struct Head: Decodable { let type: String }
private struct OpenMsg: Decodable { let stage: PrompterStage; let startLineId: String; let settings: PrompterSettings }
private struct CursorMsg: Decodable { let lineId: String; let wordIndex: Int }
private struct SettingsMsg: Decodable { let settings: PrompterSettings }
private struct PlayingMsg: Decodable { let playing: Bool }
private struct VisibleMsg: Decodable { let visible: Bool }
private struct HintMsg: Decodable { let hint: String }
private struct CountdownMsg: Decodable { let seconds: Int }
private struct StatusMsg: Decodable { let text: String? }
private struct SpeechStartMsg: Decodable { let sessionId: Int; let deviceId: String?; let contextualStrings: [String] }
private struct SpeechFileMsg: Decodable { let path: String; let contextualStrings: [String] }
private struct HotkeysMsg: Decodable { let bindings: [HotkeyBinding] }

public func decodeInbound(_ line: String) throws -> Inbound {
    let decoder = JSONDecoder()
    guard let data = line.data(using: .utf8), let head = try? decoder.decode(Head.self, from: data) else { throw ProtocolError.badJSON }
    func body<T: Decodable>(_ type: T.Type) throws -> T {
        do { return try decoder.decode(type, from: data) } catch { throw ProtocolError.badJSON }
    }
    switch head.type {
    case "prompter.open":
        let m = try body(OpenMsg.self)
        return .prompterOpen(stage: m.stage, startLineId: m.startLineId, settings: m.settings)
    case "prompter.setCursor":
        let m = try body(CursorMsg.self)
        return .prompterSetCursor(lineId: m.lineId, wordIndex: m.wordIndex)
    case "prompter.setSettings": return .prompterSetSettings(try body(SettingsMsg.self).settings)
    case "prompter.setPlaying": return .prompterSetPlaying(try body(PlayingMsg.self).playing)
    case "prompter.setVisible": return .prompterSetVisible(try body(VisibleMsg.self).visible)
    case "prompter.stageEnd": return .prompterStageEnd(hint: try body(HintMsg.self).hint)
    case "prompter.countdown": return .prompterCountdown(seconds: try body(CountdownMsg.self).seconds)
    case "prompter.status": return .prompterStatus(try body(StatusMsg.self).text)
    case "prompter.close": return .prompterClose
    case "speech.start":
        let m = try body(SpeechStartMsg.self)
        return .speechStart(sessionId: m.sessionId, deviceId: m.deviceId, contextualStrings: m.contextualStrings)
    case "speech.stop": return .speechStop
    case "speech.file":
        let m = try body(SpeechFileMsg.self)
        return .speechFile(path: m.path, contextualStrings: m.contextualStrings)
    case "hotkeys.set": return .hotkeysSet(try body(HotkeysMsg.self).bindings)
    case "audio.listDevices": return .audioListDevices
    default: throw ProtocolError.unknownType(head.type)
    }
}

public func encodeOutbound(_ object: [String: Any]) -> String? {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else { return nil }
    return text + "\n"
}
