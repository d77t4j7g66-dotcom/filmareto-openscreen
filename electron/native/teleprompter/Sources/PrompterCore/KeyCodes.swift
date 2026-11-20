/// macOS virtual key codes (kVK_*) and Carbon modifier masks, without importing Carbon.
public enum KeyCodes {
    private static let codes: [String: UInt32] = [
        "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9, "B": 11, "Q": 12,
        "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
        "Equal": 24, "9": 25, "7": 26, "Minus": 27, "8": 28, "0": 29, "O": 31, "U": 32, "I": 34, "P": 35,
        "L": 37, "J": 38, "K": 40, "N": 45, "M": 46, "Space": 49,
        "Left": 123, "Right": 124, "Down": 125, "Up": 126,
    ]

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
