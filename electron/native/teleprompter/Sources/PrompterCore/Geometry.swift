import CoreGraphics

public enum Geometry {
    public static func lineHeight(fontSize: CGFloat) -> CGFloat { (fontSize * 1.35).rounded() }

    public static func headerHeight(fontSize: CGFloat) -> CGFloat { min(26, max(18, (fontSize * 0.5).rounded())) + 10 }

    public static func contentHeight(fontSize: CGFloat, visibleLines: Int) -> CGFloat {
        headerHeight(fontSize: fontSize) + lineHeight(fontSize: fontSize) * CGFloat(visibleLines) + 16
    }

    /// AppKit screen coordinates (origin bottom-left). With a notch the panel starts at the very top and its
    /// first `notchHeight` points stay empty (black, merging with the notch); without one it sits under the menu bar.
    public static func notchFrame(screenFrame: CGRect, notchHeight: CGFloat, menuBarHeight: CGFloat, width: CGFloat, contentHeight: CGFloat) -> (frame: CGRect, topInset: CGFloat) {
        let w = min(width, screenFrame.width)
        let x = screenFrame.midX - w / 2
        if notchHeight > 0 {
            let h = notchHeight + contentHeight
            return (CGRect(x: x, y: screenFrame.maxY - h, width: w, height: h), notchHeight)
        }
        return (CGRect(x: x, y: screenFrame.maxY - menuBarHeight - contentHeight, width: w, height: contentHeight), 0)
    }

    public static func centeredFrame(visibleFrame: CGRect, width: CGFloat, height: CGFloat) -> CGRect {
        CGRect(x: visibleFrame.midX - width / 2, y: visibleFrame.midY - height / 2, width: width, height: height)
    }

    public static func clamp(_ frame: CGRect, to visible: CGRect) -> CGRect {
        var f = frame
        f.size.width = min(f.width, visible.width)
        f.size.height = min(f.height, visible.height)
        f.origin.x = min(max(f.minX, visible.minX), visible.maxX - f.width)
        f.origin.y = min(max(f.minY, visible.minY), visible.maxY - f.height)
        return f
    }

    public static func shouldFade(mouse: CGPoint, frame: CGRect, margin: CGFloat = 40) -> Bool {
        frame.insetBy(dx: -margin, dy: -margin).contains(mouse)
    }

    public static func targetOffset(lineTop: CGFloat, viewportHeight: CGFloat, readingFraction: CGFloat) -> CGFloat {
        max(0, lineTop - viewportHeight * readingFraction)
    }

    /// Top of the wrapped line a word ends on, from the height of the text up to and including it.
    public static func wordLineTop(textHeightThroughWord: CGFloat, singleLineHeight: CGFloat) -> CGFloat {
        max(0, textHeightThroughWord - singleLineHeight)
    }
}
