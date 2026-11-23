import AppKit
import PrompterCore

/// Borderless window that covers one display with the camera, for the person on camera. Hidden from
/// screen capture and from the mouse, and one level under the prompter panel, so a full-screen
/// prompter on the same display covers it.
final class CameraPreviewWindow: NSWindow {
    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 640, height: 360), styleMask: [.borderless], backing: .buffered, defer: false)
        isReleasedWhenClosed = false
        isOpaque = true
        backgroundColor = .black
        hasShadow = false
        hidesOnDeactivate = false
        ignoresMouseEvents = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        // Same rule as PrompterPanel: FILMARETO_ALLOW_CAPTURE=1 lets debug screenshots see it.
        sharingType = ProcessInfo.processInfo.environment["FILMARETO_ALLOW_CAPTURE"] == nil ? .none : .readOnly
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Lets the window cover the menu bar and the Dock.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

/// Handles `cameraPreview.set`. The decisions are in `CameraPreview.decide`; this only applies them.
final class CameraPreviewController: MessageHandler {
    private let window = CameraPreviewWindow()
    private let backdrop = CameraBackdrop(frame: NSRect(x: 0, y: 0, width: 640, height: 360))
    /// The config the window shows now. Nil while it is closed.
    private var active: CameraPreviewConfig?
    private var screenObserver: NSObjectProtocol?

    init() {
        backdrop.purpose = "on the second display"
        backdrop.autoresizingMask = [.width, .height]
        backdrop.onProblem = { [weak self] text in
            Outbox.error("camera_preview_failed", "Η κάμερα στη δεύτερη οθόνη σταμάτησε: \(text)")
            self?.close()
        }
        window.contentView = backdrop
        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.displaysChanged()
        }
        // The window exists from launch, so its id is known before any pick or take.
        reportState(displayNumber: nil)
    }

    deinit {
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
    }

    func handle(_ msg: Inbound) -> Bool {
        guard case let .cameraPreviewSet(config) = msg else { return false }
        apply(config)
        return true
    }

    private static func number(of screen: NSScreen) -> Int? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue
    }

    /// The displays that exist now, with the screen behind each, found by the same
    /// NSScreenNumber the full-screen prompter uses.
    private static func displays() -> [(ref: DisplayRef, screen: NSScreen)] {
        NSScreen.screens.compactMap { screen in
            guard let number = number(of: screen) else { return nil }
            return (DisplayRef(number: number, uuid: PrompterWindowController.uuid(of: screen)), screen)
        }
    }

    private func apply(_ config: CameraPreviewConfig) {
        let displays = Self.displays()
        switch CameraPreview.decide(config: config, active: active, displays: displays.map(\.ref)) {
        case .none:
            return
        case .close:
            close()
            // A wanted preview that cannot show is worth a word; a plain "off" is not.
            if config.enabled, config.cameraName != nil, CameraPreview.display(forId: config.displayId, in: displays.map(\.ref)) == nil {
                Outbox.error("camera_preview_display", "Η οθόνη για την κάμερα δεν βρέθηκε")
            }
        case let .show(number):
            guard let screen = displays.first(where: { $0.ref.number == number })?.screen, let name = config.cameraName else {
                close()
                return
            }
            guard CameraBackdrop.device(named: name) != nil else {
                close()
                Outbox.error("camera_preview_camera", "Δεν βρέθηκε κάμερα για τη δεύτερη οθόνη")
                return
            }
            window.setFrame(screen.frame, display: true)
            window.level = Self.level(for: screen)
            active = config
            // A problem inside show() calls close() and clears `active`; then nothing is ordered front.
            backdrop.show(cameraName: name, opacity: 1, mirror: config.mirror)
            guard active != nil else { return }
            window.orderFrontRegardless()
            reportState(displayNumber: number)
        }
    }

    /// One level under the prompter panel (.statusBar). On the main display a full-screen prompter
    /// sits at raw level 2 while the person works there, so the preview goes below that.
    private static func level(for screen: NSScreen) -> NSWindow.Level {
        if screen == NSScreen.screens.first { return NSWindow.Level(rawValue: 1) }
        return NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue - 1)
    }

    private func close() {
        let wasActive = active != nil
        active = nil
        backdrop.hide()
        window.orderOut(nil)
        if wasActive { reportState(displayNumber: nil) }
    }

    /// A display was plugged, unplugged or resized: follow it, or close when it is gone.
    private func displaysChanged() {
        guard let config = active else { return }
        let displays = Self.displays()
        guard let target = CameraPreview.display(forId: config.displayId, in: displays.map(\.ref)),
              let screen = displays.first(where: { $0.ref.number == target.number })?.screen else {
            close()
            return
        }
        window.setFrame(screen.frame, display: true)
        window.level = Self.level(for: screen)
    }

    private func reportState(displayNumber: Int?) {
        // The window id is always included: the recorder leaves the window out by id.
        Outbox.send(["type": "cameraPreview.state", "active": displayNumber != nil, "windowId": window.windowNumber])
    }
}
