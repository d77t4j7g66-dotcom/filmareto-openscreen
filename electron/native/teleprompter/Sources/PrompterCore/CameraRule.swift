import Foundation

/// When the prompter shows the live camera behind its text, and how a camera is recognised.
public enum PrompterCamera {
    /// Chromium labels a camera `Name (vid:pid)`; AVFoundation's localizedName is the part before it.
    public static func stripSuffix(_ name: String) -> String {
        let pattern = #"\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{4}\)\s*$"#
        let range = NSRange(name.startIndex..., in: name)
        let stripped = (try? NSRegularExpression(pattern: pattern))?.stringByReplacingMatches(in: name, range: range, withTemplate: "") ?? name
        return stripped.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func matches(label: String, localizedName: String) -> Bool {
        let a = stripSuffix(label).lowercased()
        return !a.isEmpty && a == stripSuffix(localizedName).lowercased()
    }

    /// Full screen, on a screen other than the main one (the one being recorded), with a non-zero
    /// opacity and a camera that exists.
    public static func shouldShow(position: PrompterPosition, isMainScreen: Bool, opacity: Double, cameraAvailable: Bool) -> Bool {
        position == .fullscreen && !isMainScreen && opacity > 0 && cameraAvailable
    }
}
