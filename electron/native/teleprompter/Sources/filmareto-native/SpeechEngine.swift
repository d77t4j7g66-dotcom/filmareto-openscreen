import AVFoundation
import Foundation
import PrompterCore
import Speech

/// Greek on-device recognition from the microphone, or from a file fed at real-time pace.
/// Emits the whole current hypothesis of the active request on every update.
///
/// Live audio always comes from the Mac's input device (System Settings → Sound → Input). Picking another
/// device inside the app did not work: AVAudioEngine falls back to its default aggregate for mixers such as
/// the GCS-8, and AVCaptureSession does not list USB inputs such as the Lyra or the GCS-8 at all.
final class SpeechEngine: MessageHandler {
    private let locale = Locale(identifier: "el-GR")
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var requestCounter = 0
    private var session = 0
    private var requestId = ""
    private var requestOffset = 0.0
    private var firstSeen: [Int: Double] = [:]
    /// The Greek on-device recognizer restarts its partial text after a pause instead of accumulating it.
    /// Each restart becomes its own segment ("r1.2"), so the app sees ordered pieces rather than lost words.
    private var segmentIndex = 0
    private var lastTexts: [String] = []
    private var contextual: [String] = []
    private var rotateTimer: Timer?
    private var running = false
    private var fileMode = false
    private var fileClock = 0.0
    private var sessionStart = Date()
    private var feeder: Thread?
    private var errorTimes: [Date] = []
    private let engine = AVAudioEngine()
    private var tapInstalled = false
    private var configObserver: NSObjectProtocol?
    private var restartTimes: [Date] = []
    private let requestLock = NSLock()
    private let debug = ProcessInfo.processInfo.environment["FILMARETO_DEBUG_AUDIO"] != nil

    func handle(_ msg: Inbound) -> Bool {
        switch msg {
        case let .speechStart(sessionId, deviceId, strings):
            session = sessionId
            startLive(deviceId: deviceId, contextual: strings)
            return true
        case .speechStop:
            stop()
            state("stopped")
            return true
        case let .speechFile(path, strings):
            startFile(path: path, contextual: strings)
            return true
        default:
            return false
        }
    }

    private func state(_ s: String, _ message: String? = nil) {
        var obj: [String: Any] = ["type": "speech.state", "state": s]
        if let message { obj["message"] = message }
        Outbox.send(obj)
    }

    private func log(_ text: String) {
        if debug { FileHandle.standardError.write("\(text)\n".data(using: .utf8)!) }
    }

    private func now() -> Double { fileMode ? fileClock : Date().timeIntervalSince(sessionStart) }

    private func r3(_ x: Double) -> Double { (x * 1000).rounded() / 1000 }

    /// The request is swapped on the main queue and appended to from the capture queue.
    private var currentRequest: SFSpeechAudioBufferRecognitionRequest? {
        get {
            requestLock.lock()
            defer { requestLock.unlock() }
            return request
        }
        set {
            requestLock.lock()
            request = newValue
            requestLock.unlock()
        }
    }

    private func makeRecognizer() -> Bool {
        guard let r = SFSpeechRecognizer(locale: locale), r.isAvailable, r.supportsOnDeviceRecognition else {
            state("unavailable", "Η ελληνική αναγνώριση ομιλίας εκτός σύνδεσης δεν είναι διαθέσιμη σε αυτό το Mac")
            return false
        }
        recognizer = r
        return true
    }

    private func authorizeSpeech(_ done: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async { done(status == .authorized) }
        }
    }

    private func authorizeMic(_ done: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: done(true)
        case .notDetermined: AVCaptureDevice.requestAccess(for: .audio) { ok in DispatchQueue.main.async { done(ok) } }
        default: done(false)
        }
    }

    // MARK: - Live microphone

    private func startLive(deviceId: String?, contextual: [String]) {
        stop()
        fileMode = false
        self.contextual = contextual
        authorizeSpeech { ok in
            guard ok else { self.state("denied", "Δεν υπάρχει άδεια αναγνώρισης ομιλίας"); return }
            self.authorizeMic { ok in
                guard ok else { self.state("denied", "Δεν υπάρχει άδεια μικροφώνου"); return }
                guard self.makeRecognizer() else { return }
                self.restartTimes = []
                do {
                    try self.startAudio()
                } catch {
                    self.stop()
                    self.state("unavailable", "Δεν ξεκίνησε το μικρόφωνο: \(error.localizedDescription)")
                    return
                }
                self.configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: self.engine, queue: .main) { [weak self] _ in
                    self?.audioConfigurationChanged()
                }
                self.sessionStart = Date()
                self.running = true
                self.beginRequest()
                self.scheduleRotation()
                self.state("listening")
            }
        }
    }

    /// Installs the tap with the input's current format and starts the engine.
    private func startAudio() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        log("audio format: \(format)")
        var buffers = 0
        var peak: Float = 0
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.currentRequest?.append(buffer)
            guard self.debug, let samples = buffer.floatChannelData?[0] else { return }
            for i in 0..<Int(buffer.frameLength) { peak = max(peak, abs(samples[i])) }
            buffers += 1
            if buffers % 20 == 0 {
                self.log("audio buffers \(buffers) peak \(String(format: "%.4f", peak))")
                peak = 0
            }
        }
        tapInstalled = true
        engine.prepare()
        try engine.start()
    }

    /// macOS posts a configuration change when the input device or its format changes. Restart the audio with
    /// the new format; only repeated failures count as a lost microphone.
    private func audioConfigurationChanged() {
        guard running, !fileMode else { return }
        let cutoff = Date().addingTimeInterval(-5)
        restartTimes = restartTimes.filter { $0 > cutoff } + [Date()]
        if restartTimes.count > 4 {
            stop()
            state("deviceLost", "Το μικρόφωνο αποσυνδέθηκε")
            return
        }
        if engine.isRunning { engine.stop() }
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        do {
            try startAudio()
        } catch {
            stop()
            state("deviceLost", "Το μικρόφωνο αποσυνδέθηκε")
        }
    }

    // MARK: - Audio file at real-time pace

    private func startFile(path: String, contextual: [String]) {
        stop()
        fileMode = true
        self.contextual = contextual
        authorizeSpeech { ok in
            guard ok else { self.state("denied", "Δεν υπάρχει άδεια αναγνώρισης ομιλίας"); return }
            guard self.makeRecognizer() else { return }
            let file: AVAudioFile
            do {
                file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
            } catch {
                Outbox.error("file_open", "Δεν άνοιξε το αρχείο ήχου: \(error.localizedDescription)")
                return
            }
            self.fileClock = 0
            self.running = true
            self.beginRequest()
            self.scheduleRotation()
            self.state("listening")
            let thread = Thread { [weak self] in self?.feed(file) }
            self.feeder = thread
            thread.start()
        }
    }

    /// Appends the file to the request no faster than real time, so arrival times look like a live microphone.
    private func feed(_ file: AVAudioFile) {
        let format = file.processingFormat
        let chunk: AVAudioFrameCount = 4096
        let began = Date()
        var fed = 0.0
        while !Thread.current.isCancelled {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk) else { break }
            do { try file.read(into: buffer, frameCount: chunk) } catch { break }
            if buffer.frameLength == 0 { break }
            fed += Double(buffer.frameLength) / format.sampleRate
            let seconds = fed
            DispatchQueue.main.sync {
                self.currentRequest?.append(buffer)
                self.fileClock = seconds
            }
            let ahead = fed - Date().timeIntervalSince(began)
            if ahead > 0 { Thread.sleep(forTimeInterval: ahead) }
        }
        if Thread.current.isCancelled { return }
        let duration = r3(fed)
        DispatchQueue.main.async {
            self.running = false
            self.rotateTimer?.invalidate()
            self.rotateTimer = nil
            self.currentRequest?.endAudio()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                Outbox.send(["type": "speech.fileDone", "duration": duration])
            }
        }
    }

    // MARK: - Recognition requests

    private func scheduleRotation() {
        rotateTimer?.invalidate()
        rotateTimer = Timer.scheduledTimer(withTimeInterval: 55, repeats: true) { [weak self] _ in
            guard let self, self.running else { return }
            self.currentRequest?.endAudio()
            self.beginRequest()
        }
    }

    private func beginRequest() {
        guard let recognizer else { return }
        requestCounter += 1
        requestId = "r\(requestCounter)"
        requestOffset = now()
        firstSeen = [:]
        segmentIndex = 0
        lastTexts = []
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.requiresOnDeviceRecognition = true
        req.shouldReportPartialResults = true
        req.taskHint = .dictation
        req.contextualStrings = contextual
        req.addsPunctuation = false
        currentRequest = req
        let rid = requestId
        let sessionId = session
        let offset = requestOffset
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let result {
                    self.emit(result, session: sessionId, requestId: rid, offset: offset)
                    if result.isFinal, rid == self.requestId, self.running { self.beginRequest() }
                } else if error != nil, rid == self.requestId, self.running {
                    self.recoverFromError()
                }
            }
        }
    }

    private func recoverFromError() {
        let cutoff = Date().addingTimeInterval(-10)
        errorTimes = errorTimes.filter { $0 > cutoff } + [Date()]
        if errorTimes.count > 5 {
            stop()
            state("unavailable", "Η αναγνώριση ομιλίας σταματάει συνέχεια· δοκίμασε ξανά")
            return
        }
        beginRequest()
    }

    private func emit(_ result: SFSpeechRecognitionResult, session sessionId: Int, requestId rid: String, offset: Double) {
        let current = rid == requestId
        let texts = result.bestTranscription.segments.map { $0.substring }
        if current {
            if let first = texts.first, let previousFirst = lastTexts.first, texts.count < lastTexts.count, first != previousFirst {
                segmentIndex += 1
                firstSeen = [:]
            }
            lastTexts = texts
        }
        let segmentId = current ? "\(rid).\(segmentIndex)" : "\(rid).final"
        var words: [[String: Any]] = []
        for (i, seg) in result.bestTranscription.segments.enumerated() {
            if current, firstSeen[i] == nil { firstSeen[i] = now() }
            let arrival = current ? (firstSeen[i] ?? now()) : offset
            let spoken = (seg.timestamp > 0 || seg.duration > 0) ? offset + seg.timestamp : arrival
            words.append(["text": seg.substring, "t": r3(spoken), "at": r3(arrival), "final": result.isFinal])
        }
        Outbox.send(["type": "speech.words", "sessionId": sessionId, "requestId": segmentId, "words": words])
    }

    private func stop() {
        rotateTimer?.invalidate()
        rotateTimer = nil
        running = false
        feeder?.cancel()
        feeder = nil
        if let o = configObserver {
            NotificationCenter.default.removeObserver(o)
            configObserver = nil
        }
        if engine.isRunning { engine.stop() }
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        currentRequest?.endAudio()
        currentRequest = nil
        task?.finish()
        task = nil
    }
}
