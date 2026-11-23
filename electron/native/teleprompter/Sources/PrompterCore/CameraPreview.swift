import Foundation

/// What `cameraPreview.set` asks for: the camera full screen on one display, for the person on camera.
public struct CameraPreviewConfig: Equatable {
    public var enabled: Bool
    /// The display, as a string: its decimal NSScreenNumber (Electron's `display.id`), or its UUID.
    public var displayId: String?
    /// The camera as Chromium labels it. Nil while the app's camera is off.
    public var cameraName: String?
    public var mirror: Bool

    public init(enabled: Bool, displayId: String?, cameraName: String?, mirror: Bool) {
        self.enabled = enabled
        self.displayId = displayId
        self.cameraName = cameraName
        self.mirror = mirror
    }
}

/// A display as the window layer sees it.
public struct DisplayRef: Equatable {
    public var number: Int
    public var uuid: String

    public init(number: Int, uuid: String) {
        self.number = number
        self.uuid = uuid
    }
}

public enum CameraPreviewAction: Equatable {
    /// Nothing to do: the window already shows exactly this, or there is nothing to close.
    case none
    /// Close the window and stop the capture session.
    case close
    /// Show (or update) the camera on the display with this NSScreenNumber.
    case show(displayNumber: Int)
}

public enum CameraPreview {
    /// The display an id names, or nil when it is absent, empty, or no display has it any more.
    public static func display(forId id: String?, in displays: [DisplayRef]) -> DisplayRef? {
        guard let id = id?.trimmingCharacters(in: .whitespaces), !id.isEmpty else { return nil }
        if let number = Int(id), let found = displays.first(where: { $0.number == number }) { return found }
        return displays.first(where: { $0.uuid.caseInsensitiveCompare(id) == .orderedSame })
    }

    /// `active` is the config the window currently shows, nil when it is closed.
    public static func decide(config: CameraPreviewConfig, active: CameraPreviewConfig?, displays: [DisplayRef]) -> CameraPreviewAction {
        let name = config.cameraName?.trimmingCharacters(in: .whitespaces) ?? ""
        guard config.enabled, !name.isEmpty, let target = display(forId: config.displayId, in: displays) else {
            return active == nil ? .none : .close
        }
        return active == config ? .none : .show(displayNumber: target.number)
    }
}
