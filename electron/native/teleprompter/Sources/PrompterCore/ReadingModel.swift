import CoreGraphics

public enum WordState: Equatable { case spoken, current, upcoming, previous }

public enum ReadingModel {
    public static func state(lineIndex: Int, wordIndex: Int, cursorLine: Int, cursorWord: Int) -> WordState {
        if lineIndex < cursorLine { return .previous }
        if lineIndex > cursorLine { return .upcoming }
        return wordIndex <= cursorWord ? .spoken : .current
    }

    public static func alpha(_ state: WordState) -> CGFloat {
        switch state {
        case .previous, .spoken: return 0.35
        case .current: return 1.0
        case .upcoming: return 0.85
        }
    }
}
