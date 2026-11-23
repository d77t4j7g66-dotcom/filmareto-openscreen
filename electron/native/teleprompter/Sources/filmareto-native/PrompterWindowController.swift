import AppKit
import PrompterCore

final class PrompterWindowController: MessageHandler {
    private let panel = PrompterPanel()
    private let view = ReadingView(frame: NSRect(x: 0, y: 0, width: 560, height: 200))
    private let container = NSView(frame: NSRect(x: 0, y: 0, width: 560, height: 200))
    private let camera = CameraBackdrop(frame: NSRect(x: 0, y: 0, width: 560, height: 200))
    /// The camera the app has on, as Chromium labels it. Nil while it is off.
    private var cameraName: String?
    private var settings = PrompterSettings.default
    private let frames = FrameStore(store: UserDefaultsStore())
    private var displayId = "unknown"
    private var screenTimer: Timer?
    private var visible = false
    private var placing = false

    init() {
        camera.autoresizingMask = [.width, .height]
        camera.isHidden = true
        view.autoresizingMask = [.width, .height]
        container.addSubview(camera)
        container.addSubview(view)
        panel.contentView = container
        // The recorder leaves this window out by id. It exists from launch, so the id is known
        // before any source is picked, and the recorder re-reads it while the panel is hidden.
        Outbox.send(["type": "prompter.window", "windowId": panel.windowNumber])
        view.onScrolled = { lineId, byUser in Outbox.send(["type": "prompter.scrolled", "lineId": lineId, "byUser": byUser]) }
        view.onAtEnd = { [weak self] in self?.reportState(atEnd: true) }
        view.onCountdownDone = { Outbox.send(["type": "prompter.countdownDone"]) }
        view.onFrameChanged = { [weak self] in
            self?.saveFrame()
            self?.reportState()
        }
    }

    func handle(_ msg: Inbound) -> Bool {
        switch msg {
        case let .prompterOpen(stage, startLineId, s):
            settings = s
            view.load(stage: stage, startLineId: startLineId, settings: s)
            place()
            panel.orderFrontRegardless()
            visible = true
            updateCamera()
            reportState()
        case let .prompterSetCursor(lineId, wordIndex):
            view.setCursor(lineId: lineId, wordIndex: wordIndex)
        case let .prompterSetSettings(s):
            let geometryChanged = s.position != settings.position || s.width != settings.width || s.fontSize != settings.fontSize || s.visibleLines != settings.visibleLines || s.displayId != settings.displayId || s.paddingV != settings.paddingV
            settings = s
            view.apply(settings: s)
            if geometryChanged { place() } else { applyMouseBehaviour() }
            updateCamera()
            reportState()
        case let .prompterSetCamera(name):
            cameraName = name
            updateCamera()
        case let .prompterSetPlaying(playing):
            view.setPlaying(playing)
        case let .prompterSetVisible(v):
            visible = v
            if v { panel.orderFrontRegardless() } else { panel.orderOut(nil) }
            updateCamera()
            reportState()
        case let .prompterStageEnd(hint):
            view.showOverlay(hint)
        case let .prompterCountdown(seconds):
            view.startCountdown(seconds)
        case let .prompterStatus(text):
            view.status = text
        case .prompterClose:
            panel.orderOut(nil)
            visible = false
            screenTimer?.invalidate()
            screenTimer = nil
            updateCamera()
            reportState()
        default:
            return false
        }
        return true
    }

    private static func number(of screen: NSScreen) -> Int? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue
    }

    /// The camera sits behind the text only while the prompter is shown full screen on a screen
    /// other than the main one (the one being recorded), with an opacity and a camera that exists.
    /// Anything else stops the session.
    private func updateCamera() {
        let main = NSScreen.screens.first
        let isMain = main.map { Self.number(of: targetScreen()) == Self.number(of: $0) } ?? true
        let wanted = visible && panel.isVisible && cameraName != nil
        let available = wanted && cameraName.map { CameraBackdrop.device(named: $0) != nil } ?? false
        if PrompterCamera.shouldShow(position: settings.position, isMainScreen: isMain, opacity: settings.cameraOpacity, cameraAvailable: available), let name = cameraName {
            container.wantsLayer = true
            camera.isHidden = false
            view.drawsBackground = false
            camera.show(cameraName: name, opacity: settings.cameraOpacity, mirror: settings.mirror)
        } else {
            camera.hide()
            camera.isHidden = true
            view.drawsBackground = true
            container.wantsLayer = false
        }
    }

    private func targetScreen() -> NSScreen {
        let screens = NSScreen.screens
        if settings.position == .screen {
            // Top: the chosen display, else the main one. Never the mouse's.
            if let id = settings.displayId, let chosen = screens.first(where: { Self.number(of: $0) == id }) { return chosen }
            return screens[0]
        }
        if settings.position == .notch || settings.position == .fullscreen, let id = settings.displayId,
           let chosen = screens.first(where: { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue == id }) {
            return chosen
        }
        if settings.position == .notch, let notched = screens.first(where: { $0.safeAreaInsets.top > 0 }) { return notched }
        let mouse = NSEvent.mouseLocation
        return screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main ?? screens[0]
    }

    static func uuid(of screen: NSScreen) -> String {
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
              let uuid = CGDisplayCreateUUIDFromDisplayID(number.uint32Value)?.takeRetainedValue() else { return "unknown" }
        return CFUUIDCreateString(nil, uuid) as String
    }

    private func place() {
        placing = true
        defer { placing = false }
        panel.level = .statusBar
        let screen = targetScreen()
        displayId = Self.uuid(of: screen)
        let lines = settings.mode == .bullets ? max(2, settings.visibleLines) : settings.visibleLines
        let content = Geometry.contentHeight(fontSize: CGFloat(settings.fontSize), visibleLines: lines) + CGFloat(settings.paddingV) * 2
        switch settings.position {
        case .notch:
            let menuBar = screen.frame.maxY - screen.visibleFrame.maxY
            let r = Geometry.notchFrame(screenFrame: screen.frame, notchHeight: screen.safeAreaInsets.top, menuBarHeight: menuBar, width: CGFloat(settings.width), contentHeight: content)
            view.topInset = r.topInset
            panel.setFrame(r.frame, display: true)
        case .fullscreen:
            view.topInset = 0
            panel.setFrame(screen.frame, display: true)
            // On the display being worked on, the recorder's bar and the settings must stay above it:
            // they hold Rec and Stop. Any other display it may cover whole, menu bar included.
            panel.level = screen.frame.contains(NSEvent.mouseLocation) ? NSWindow.Level(rawValue: 2) : .statusBar
        case .screen:
            view.topInset = 0
            panel.setFrame(Geometry.topFrame(visibleFrame: screen.visibleFrame, width: CGFloat(settings.width), height: content), display: true)
        case .free:
            view.topInset = 0
            let saved = frames.frame(for: settings.position, display: displayId)
            let fallback = Geometry.centeredFrame(visibleFrame: screen.visibleFrame, width: CGFloat(settings.width), height: content)
            panel.setFrame(Geometry.clamp(saved ?? fallback, to: screen.visibleFrame), display: true)
        }
        applyMouseBehaviour()
    }

    private func saveFrame() {
        guard !placing, settings.position == .free else { return }
        frames.save(panel.frame, for: settings.position, display: displayId)
    }

    private func applyMouseBehaviour() {
        screenTimer?.invalidate()
        screenTimer = nil
        panel.alphaValue = 1
        switch settings.position {
        case .notch, .fullscreen:
            panel.ignoresMouseEvents = false
            view.showsResizeGrip = false
        case .free:
            panel.ignoresMouseEvents = false
            view.showsResizeGrip = true
        case .screen:
            panel.ignoresMouseEvents = true
            view.showsResizeGrip = false
            screenTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.tickScreenMode() }
        }
    }

    /// Screen position: clicks pass through unless ⌥ is held; optional fade when the cursor comes near.
    private func tickScreenMode() {
        let optionHeld = NSEvent.modifierFlags.contains(.option)
        if panel.ignoresMouseEvents == optionHeld { panel.ignoresMouseEvents = !optionHeld }
        let fade = settings.fadeNearCursor && !optionHeld && Geometry.shouldFade(mouse: NSEvent.mouseLocation, frame: panel.frame)
        let goal: CGFloat = fade ? 0.1 : 1.0
        if abs(panel.alphaValue - goal) > 0.01 { panel.alphaValue += (goal - panel.alphaValue) * 0.35 }
    }

    private func reportState(atEnd: Bool = false) {
        let f = panel.frame
        Outbox.send([
            "type": "prompter.state",
            "visible": visible && panel.isVisible,
            "position": settings.position.rawValue,
            "frame": ["x": f.minX, "y": f.minY, "width": f.width, "height": f.height],
            "atEnd": atEnd,
            "displayId": displayId,
        ])
    }
}
