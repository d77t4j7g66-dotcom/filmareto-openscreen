/// macOS virtual key codes (kVK_*) and Carbon modifier masks, without importing Carbon.
public enum KeyCodes {
    private static let codes: [String: UInt32] = [
        "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9, "B": 11, "Q": 12,
        "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
        "Equal": 24, "9": 25, "7": 26, "Minus": 27, "8": 28, "0": 29, "O": 31, "U": 32, "I": 34, "P": 35,
        "L": 37, "J": 38, "K": 40, "N": 45, "M": 46, "Space": 49,
        "Left": 123, "Right": 124, "Down": 125, "Up": 126,
        // Keypad (kVK_ANSI_Keypad*).
        "Keypad0": 0x52, "Keypad1": 0x53, "Keypad2": 0x54, "Keypad3": 0x55, "Keypad4": 0x56,
        "Keypad5": 0x57, "Keypad6": 0x58, "Keypad7": 0x59, "Keypad8": 0x5B, "Keypad9": 0x5C,
        "KeypadPlus": 0x45, "KeypadMinus": 0x4E, "KeypadMultiply": 0x43, "KeypadDivide": 0x4B,
        "KeypadEnter": 0x4C, "KeypadDecimal": 0x41, "KeypadEquals": 0x51, "KeypadClear": 0x47,
        // Function keys (kVK_F1 ... kVK_F19).
        "F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76, "F5": 0x60, "F6": 0x61, "F7": 0x62,
        "F8": 0x64, "F9": 0x65, "F10": 0x6D, "F11": 0x67, "F12": 0x6F, "F13": 0x69, "F14": 0x6B,
        "F15": 0x71, "F16": 0x6A, "F17": 0x40, "F18": 0x4F, "F19": 0x50,
        // Editing, navigation and punctuation.
        "Return": 0x24, "Tab": 0x30, "Escape": 0x35, "Delete": 0x75,
        "Home": 0x73, "End": 0x77, "PageUp": 0x74, "PageDown": 0x79,
        "Comma": 0x2B, "Period": 0x2F, "Slash": 0x2C, "Semicolon": 0x29, "Quote": 0x27,
        "LeftBracket": 0x21, "RightBracket": 0x1E, "Backslash": 0x2A, "Grave": 0x32,
    ]

    /// Every key name that maps to a code, sorted. The app's shortcut recorder offers these.
    public static let supportedKeys: [String] = codes.keys.sorted()

    public static func code(for key: String) -> UInt32? { codes[key] }

    public static func modifiers(_ names: [String]) -> UInt32 {
        var mask: UInt32 = 0
        for n in names {
            switch n {
            case "cmd": mask |= 256
            case "shift": mask |= 512
            case "alt": mask |= 2048
            case "ctrl": mask |= 4096
            default: break
            }
        }
        return mask
    }
}
