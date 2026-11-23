import AppKit
import AVFoundation
import PrompterCore

/// The live camera behind the prompter's text, on a black ground. The session only runs while the
/// prompter shows it: `hide()` stops and tears it down. Starting and stopping never happen on the
/// main thread. With no permission or no device nothing is shown, and a line goes to stderr.
final class CameraBackdrop: NSView {
    private let queue = DispatchQueue(label: "filmareto.prompter.camera")
    private var session: AVCaptureSession?
    private var preview: AVCaptureVideoPreviewLayer?
    private var observers: [NSObjectProtocol] = []
    /// The camera asked for; a permission answer that arrives after a change is ignored.
    private var wanted: String?
    private var runningName: String?
    /// What the camera is for, in the log lines ("no camera <purpose>").
    var purpose = "behind the text"
    /// Called, on the main thread, with every problem that leaves nothing on screen. Besides the
    /// log line: the prompter ignores it, the second-display window reports it and closes.
    var onProblem: ((String) -> Void)?

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layout() {
        super.layout()
        preview?.frame = bounds
    }

    /// The camera with this name, matched as `PrompterCamera.matches` does.
    static func device(named name: String) -> AVCaptureDevice? {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .externalUnknown],
            mediaType: .video,
            position: .unspecified
        )
        // A suspended camera (a MacBook's FaceTime camera with the lid closed) is listed but shows
        // nothing: it does not count.
        let usable = discovery.devices.filter { !$0.isSuspended }
        if let named = usable.first(where: { PrompterCamera.matches(label: name, localizedName: $0.localizedName) }) {
            return named
        }
        // The app's saved camera can name one that is not there or suspended: the app then
        // records the default camera, and so does this.
        log("camera \"\(name)\" not available; showing the default camera")
        if let fallback = AVCaptureDevice.default(for: .video), !fallback.isSuspended {
            return fallback
        }
        return usable.first
    }

    /// Shows the camera at this opacity. Calling it again with the same camera only updates the look.
    func show(cameraName: String, opacity: Double, mirror: Bool) {
        wanted = cameraName
        if runningName == cameraName, session != nil {
            apply(opacity: opacity, mirror: mirror)
            return
        }
        teardown()
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            start(cameraName: cameraName, opacity: opacity, mirror: mirror)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self, self.wanted == cameraName else { return }
                    if granted {
                        self.start(cameraName: cameraName, opacity: opacity, mirror: mirror)
                    } else {
                        self.report("camera access was not granted; no camera \(self.purpose)")
                    }
                }
            }
        default:
            report("camera access is denied; no camera \(purpose)")
        }
    }

    /// Stops the camera and drops the session.
    func hide() {
        wanted = nil
        teardown()
    }

    private func start(cameraName: String, opacity: Double, mirror: Bool) {
        guard let device = Self.device(named: cameraName) else {
            report("camera \"\(cameraName)\" not found; no camera \(purpose)")
            return
        }
        let session = AVCaptureSession()
        session.beginConfiguration()
        // Never a format of its own (no preset): the camera runs one format at a time, and the
        // recorder (1.2.0) locks it at its broadcast format for a take; a preset here pulled the
        // camera to another size and left the recording without frames. The device is locked
        // at the format it already runs until the session is up, so the session keeps it.
        let locked = (try? device.lockForConfiguration()) != nil
        if locked { device.activeFormat = device.activeFormat }
        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else {
                session.commitConfiguration()
                if locked { device.unlockForConfiguration() }
                report("camera \"\(device.localizedName)\" cannot be used here; no camera \(purpose)")
                return
            }
            session.addInput(input)
        } catch {
            session.commitConfiguration()
            if locked { device.unlockForConfiguration() }
            report("camera \"\(device.localizedName)\" failed to open: \(error.localizedDescription)")
            return
        }
        session.commitConfiguration()

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = bounds
        self.layer?.addSublayer(layer)
        self.session = session
        preview = layer
        runningName = cameraName
        apply(opacity: opacity, mirror: mirror)

        let center = NotificationCenter.default
        let fail: (Notification) -> Void = { [weak self] note in
            self?.report("camera stopped: \(note.name.rawValue)")
            self?.hide()
        }
        observers = [
            center.addObserver(forName: .AVCaptureSessionRuntimeError, object: session, queue: .main, using: fail),
            center.addObserver(forName: .AVCaptureDeviceWasDisconnected, object: device, queue: .main, using: fail),
        ]
        queue.async {
            session.startRunning()
            if locked { device.unlockForConfiguration() }
        }
    }

    private func apply(opacity: Double, mirror: Bool) {
        guard let preview else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        preview.opacity = Float(min(1, max(0, opacity)))
        CATransaction.commit()
        if let connection = preview.connection, connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = mirror
        }
    }

    private func teardown() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        preview?.removeFromSuperlayer()
        preview = nil
        runningName = nil
        if let session {
            self.session = nil
            queue.async { session.stopRunning() }
        }
    }

    private func report(_ text: String) {
        Self.log(text)
        onProblem?(text)
    }

    private static var lastLog = ""
    /// Settings are pushed on every slider step, so a repeated problem is said once.
    static func log(_ text: String) {
        guard text != lastLog else { return }
        lastLog = text
        FileHandle.standardError.write("camera: \(text)\n".data(using: .utf8)!)
    }
}
