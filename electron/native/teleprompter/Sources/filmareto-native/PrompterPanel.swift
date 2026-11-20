import AppKit

/// Borderless, non-activating panel: it never takes the keyboard from the app being recorded.
final class PrompterPanel: NSPanel {
    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 560, height: 200), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        hidesOnDeactivate = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        // Hidden from screen capture; FILMARETO_ALLOW_CAPTURE=1 lets debug screenshots see it.
        sharingType = ProcessInfo.processInfo.environment["FILMARETO_ALLOW_CAPTURE"] == nil ? .none : .readOnly
        becomesKeyOnlyIfNeeded = true
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Lets the panel sit over the menu bar (notch position).
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}
