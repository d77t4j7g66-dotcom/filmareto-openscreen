import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import OpenScreenCaptureCore
import ScreenCaptureKit

struct Rectangle: Decodable {
	let x: Double
	let y: Double
	let width: Double
	let height: Double
}

struct RecordingRequest: Decodable {
	struct Source: Decodable {
		let type: String
		let sourceId: String
		let displayId: UInt32?
		let windowId: UInt32?
		let bounds: Rectangle?
	}

	struct Video: Decodable {
		let fps: Int
		let width: Int
		let height: Int
		let bitrate: Int?
		let hideSystemCursor: Bool
	}

	struct Audio: Decodable {
		struct SystemAudio: Decodable {
			let enabled: Bool
		}

		struct Microphone: Decodable {
			let enabled: Bool
			let deviceId: String?
			let deviceName: String?
			let gain: Double
		}

		let system: SystemAudio
		let microphone: Microphone
	}

	struct Webcam: Decodable {
		let enabled: Bool
		let deviceId: String?
		let deviceName: String?
		let width: Int
		let height: Int
		let fps: Int
	}

	struct Cursor: Decodable {
		let mode: String
	}

	struct Outputs: Decodable {
		let screenPath: String
		let manifestPath: String?
		/// 1.2.0: the camera's own `.mov` (HEVC Main 10, constant 30 fps). Absent, or the
		/// webcam not enabled, records no camera here.
		let webcamPath: String?
		/// 1.2.0: the microphone as a 48 kHz 24-bit WAV at unity, beside the take's mix.
		let micWavPath: String?
	}

	let schemaVersion: Int?
	let recordingId: Int?
	let excludedWindowIds: [UInt32]?
	/// Display captures only. Absent in requests from apps that predate the option.
	let hideDesktopIcons: Bool?
	/// 1.2.0: started during the countdown and held there. Everything opens (the camera gets
	/// its seconds to wake up and settle its exposure) but nothing is written until `resume`,
	/// which starts the take. Absent or false: the take starts at its first frame, as before.
	let holdUntilResume: Bool?
	let source: Source
	let video: Video
	let audio: Audio
	let webcam: Webcam
	let cursor: Cursor
	let outputs: Outputs
}

enum HelperError: Error, CustomStringConvertible {
	case invalidArguments
	case unsupportedMacOS
	case unsupportedFeature(String)
	case sourceNotFound(String)
	case invalidSourceType(String)
	case permissionDenied(String)
	case writerSetupFailed(String)

	var description: String {
		switch self {
		case .invalidArguments:
			return "Expected one JSON recording request argument."
		case .unsupportedMacOS:
			return "ScreenCaptureKit recording requires macOS 13 or newer."
		case .unsupportedFeature(let message):
			return message
		case .sourceNotFound(let message):
			return message
		case .invalidSourceType(let sourceType):
			return "Unsupported source type: \(sourceType)."
		case .permissionDenied(let message):
			return message
		case .writerSetupFailed(let message):
			return message
		}
	}
}

/// A source chosen in Apple's system picker, kept by `PickerSession` for the takes after it.
struct PickedSource {
	let filter: SCContentFilter
	/// Global frame (points, top-left origin) of what was picked, for cursor mapping.
	let frame: CGRect
	let displayId: CGDirectDisplayID?
}

@available(macOS 13.0, *)
final class ScreenCaptureRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
	private struct CaptureTarget {
		let filter: SCContentFilter
		let width: Int
		let height: Int
		// Global frame (points, top-left origin) of the captured region. Used by the
		// renderer to normalize cursor positions into the captured window's space.
		let captureFrame: CGRect
	}

	private let request: RecordingRequest
	private let sampleQueue = DispatchQueue(label: "app.openscreen.sck-helper.samples")
	private let stateQueue = DispatchQueue(label: "app.openscreen.sck-helper.state")
	private var stream: SCStream?
	/// System audio for a window take, from a display-wide stream. See `recordsSystemAudioFromDisplay`.
	private var systemAudioStream: SCStream?
	private var writer: AVAssetWriter?
	private var videoInput: AVAssetWriterInput?
	// Track 0 is always the mix: the editor preview is an HTML5 <video>, which plays audio
	// track 0 and nothing else. See AudioTrackMixer.
	private var audioInputs: [AVAssetWriterInput] = []
	// Index 0 is the mix every reader plays. A take with both system audio and the microphone
	// also carries each source on its own track after it (1 system, 2 microphone), so the editor
	// can set the two levels apart. Readers that know nothing of the stems keep using track 0.
	private var audioMixers: [AudioTrackMixer] = []
	/// Drives the mixer's cursor while nothing is arriving to drive it. Owned by the sample
	/// queue: created when the writer session opens, cancelled on the same queue at teardown.
	private var audioTicker: DispatchSourceTimer?
	private var didStartWriting = false
	private var didEmitRecordingStarted = false
	private var didReportWriterFailure = false
	/// The one shutdown, however many callers ask for it. A writer failure starts it on
	/// its own task, and the `stop` Electron sends right after has to wait for that run:
	/// the command loop exits the process as soon as `stop()` returns, which would cut
	/// `finishWriter()` off before its terminal event.
	private var shutdownTask: Task<Void, Never>?
	/// Direct display captures only. See `startExclusionRefresh`.
	private var exclusionRefreshTask: Task<Void, Never>?
	private var isPaused = false
	private var pauseStartedAt: CMTime?
	/// State queue. A take held for its countdown (`holdUntilResume`) until the `resume` that
	/// starts it; a pause like any other, except that nothing has been written yet.
	private var holdingStart = false
	private var totalPausedDuration = CMTime.zero
	/// Sample queue only. See `VideoTimestampGate` for the failure it exists to prevent.
	private var videoTimestampGate = VideoTimestampGate()
	/// Sample queue only. Frames the writer input was not ready for, or refused, reported in
	/// `recording-stopped` so a macOS drop rate can be measured at all (#937).
	private var droppedVideoFrames = 0
	private var nativeMicrophoneEnabled = false
	private var microphoneDeviceID: String?
	private var microphoneCapture: MicrophoneCapture?
	private var outputWidth = 1920
	private var outputHeight = 1080
	private var captureFrame = CGRect.zero
	private let microphoneOutputTypeRawValue = 2
	private let hostClock = CMClockGetHostTimeClock()
	private let picked: PickedSource?
	/// A `SystemAudioTap` (macOS 14.2+), held untyped so this class keeps its macOS 13 floor.
	private var systemAudioTap: AnyObject?
	/// Sample queue only. Cleared before the writer is finalised: a tap stops on its own
	/// queue, and a buffer it had in flight must not reach a finished writer input.
	private var acceptsTappedAudio = true
	private let tapControlQueue = DispatchQueue(label: "app.openscreen.sck-helper.system-audio-control")
	/// 1.2.0: the screen at a constant 30 fps. ScreenCaptureKit writes a frame only when the
	/// screen changes; each frame takes the slot nearest it and a slot nothing came for repeats
	/// the frame before it. Sample queue only, like the writer.
	private static let screenFrameRate: Int32 = 30
	private var screenGrid = ConstantFrameRateGrid(fps: ScreenCaptureRecorder.screenFrameRate)
	private var screenAdaptor: AVAssetWriterInputPixelBufferAdaptor?
	private var latestScreenFrame: CVPixelBuffer?
	/// 1.2.0: the camera, recorded here instead of by the browser. See `CameraCapture`.
	private var cameraCapture: CameraCapture?
	/// 1.2.0: the microphone master. Fed by its own mixer (microphone only, unity, never
	/// limited), whatever the take's mix and stems do.
	private var micWav: PCMWavWriter?

	/// `picked` is a choice already made in Apple's system picker (`PickerSession`). The take
	/// then records exactly that filter: no source lookup, and no Screen Recording check,
	/// because the user's pick IS the consent -- asking for the grant here would put back
	/// the very prompt the picker path exists to remove.
	init(request: RecordingRequest, picked: PickedSource? = nil) {
		self.request = request
		self.picked = picked
		// Held from the start, before any capture opens or a command can arrive: the `resume`
		// that ends the countdown may be read before `start()` has run.
		if request.holdUntilResume == true {
			isPaused = true
			pauseStartedAt = CMClockGetTime(hostClock)
			holdingStart = true
		}
	}

	/// Whether this take's system audio comes from a Core Audio tap instead of ScreenCaptureKit.
	///
	/// Only for a source from Apple's picker: that capture holds no Screen Recording grant,
	/// and ScreenCaptureKit hands a grantless capture its system audio as silence. Every other
	/// source keeps ScreenCaptureKit's audio, which its grant already covers.
	private var tapsSystemAudio: Bool {
		guard picked != nil, request.audio.system.enabled else {
			return false
		}
		if #available(macOS 14.2, *) {
			return true
		}
		return false
	}

	/// Whether this take's system audio comes from a second, display-wide stream.
	///
	/// A window filter (`SCContentFilter(desktopIndependentWindow:)`) hands ScreenCaptureKit's
	/// audio over from the window's own application only, so a Finder window recorded while a
	/// video plays elsewhere came out silent (#1216). "System audio" means the whole mix, as
	/// on Windows and in a display take, so a window take takes its audio from a stream on a
	/// display with nothing excluded. The Screen Recording grant the window capture already
	/// holds covers it: no new permission and no new prompt.
	private var recordsSystemAudioFromDisplay: Bool {
		picked == nil && request.source.type == "window" && request.audio.system.enabled
	}

	/// A talking-head take: the camera and the microphone, no screen (1.2.0).
	private var isCameraOnly: Bool {
		picked == nil && request.source.type == "camera"
	}

	func start() async throws {
		// Stopped before it started: a countdown cancelled as the take was being opened.
		if isShuttingDown {
			return
		}
		if isCameraOnly {
			try startCameraOnly()
			return
		}
		try ensureRequestedPermissions(screen: picked == nil)

		let target: CaptureTarget
		var audioStream: SCStream?
		if let picked {
			target = makeCaptureTarget(picked: picked)
		} else {
			let content = try await SCShareableContent.excludingDesktopWindows(
				false,
				onScreenWindowsOnly: true
			)
			target = try makeCaptureTarget(from: content)
			if recordsSystemAudioFromDisplay, let display = content.displays.first {
				let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
				let candidate = SCStream(filter: filter, configuration: makeSystemAudioStreamConfiguration(), delegate: self)
				do {
					try candidate.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
					audioStream = candidate
				} catch {
					// Like a failed start below: the take goes on, without its system audio.
					emit([
						"event": "warning",
						"code": "system-audio-unavailable",
						"message": "System audio could not be captured: \(error)",
					])
				}
			}
		}
		outputWidth = target.width
		outputHeight = target.height
		captureFrame = target.captureFrame
		let configuration = makeStreamConfiguration()
		let stream = SCStream(filter: target.filter, configuration: configuration, delegate: self)

		try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
		if request.audio.system.enabled && !tapsSystemAudio && !recordsSystemAudioFromDisplay {
			try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
		}
		try setupWriter()
		startSystemAudioTapIfNeeded()
		try startMicrophoneCaptureIfNeeded()
		startCameraIfNeeded()

		self.stream = stream
		systemAudioStream = audioStream
		emit([
			"event": "ready",
			"schemaVersion": 1,
		])
		try await stream.startCapture()
		// The stop ran while this was opening, before the take wrote anything: in a picker session
		// nothing else would ever close what this opened (the single-take helper exits). A take
		// that did write is the stop's to finish, as always.
		if isShuttingDown, !sampleQueue.sync(execute: { didStartWriting }) {
			abandonStart(stream)
			return
		}
		if let audioStream {
			do {
				try await audioStream.startCapture()
			} catch {
				systemAudioStream = nil
				emit([
					"event": "warning",
					"code": "system-audio-unavailable",
					"message": "System audio could not be captured: \(error)",
				])
			}
		}
		if picked == nil, request.source.type == "display", let displayID = request.source.displayId {
			startExclusionRefresh(displayID: displayID)
		}
	}

	/// What `start()` opened after a stop that came too early to see it, files included: the
	/// take produced none (nothing is written while it is held, and the stop answered for it).
	private func abandonStart(_ stream: SCStream) {
		microphoneCapture?.stop()
		microphoneCapture = nil
		cameraCapture?.stopCapture()
		stopSystemAudioTap()
		sampleQueue.sync { micWav?.finish() }
		let outputs = [request.outputs.screenPath, request.outputs.webcamPath, request.outputs.micWavPath]
		for path in outputs.compactMap({ $0 }) where !path.isEmpty {
			try? FileManager.default.removeItem(atPath: path)
		}
		Task {
			try? await stream.stopCapture()
		}
	}

	func stop() async {
		let task = stateQueue.sync { () -> Task<Void, Never> in
			if let shutdownTask {
				return shutdownTask
			}
			let task = Task {
				await self.performStop()
			}
			shutdownTask = task
			return task
		}
		await task.value
	}

	private func performStop() async {
		if isCameraOnly {
			microphoneCapture?.stop()
			microphoneCapture = nil
			cameraCapture?.stopCapture()
			await finishCameraOnly()
			return
		}
		exclusionRefreshTask?.cancel()
		do {
			try await stream?.stopCapture()
		} catch {
			emit([
				"event": "warning",
				"code": "stop-capture-failed",
				"message": "\(error)",
			])
		}
		microphoneCapture?.stop()
		microphoneCapture = nil
		cameraCapture?.stopCapture()
		// Stopped before the writer finishes, like the tap: no audio after the last frame.
		try? await systemAudioStream?.stopCapture()
		systemAudioStream = nil
		stopSystemAudioTap()

		await finishWriter()
	}

	/// Camera-only: `outputs.screenPath` is the camera's `.mov`, the take's video, with the
	/// microphone mixed into its own AAC track for the editor's preview, and the microphone's
	/// WAV beside it. The take's clock starts at the camera's first frame.
	private func startCameraOnly() throws {
		try ensureRequestedPermissions(screen: false)
		_ = makeStreamConfiguration() // resolves the microphone
		let forwarding = ForwardingAudioSink()
		if nativeMicrophoneEnabled {
			let clock: TimelineClock = { [weak self] in self?.timelineNow() ?? .invalid }
			audioMixers = [
				AudioTrackMixer(
					input: forwarding,
					includesSystemAudio: false,
					includesMicrophone: true,
					microphoneGain: request.audio.microphone.gain,
					limitsPeaks: false,
					clock: clock
				)
			]
			if let path = request.outputs.micWavPath, !path.isEmpty {
				do {
					let wav = try PCMWavWriter(url: URL(fileURLWithPath: path), channels: AVAudioChannelCount(AudioTrackMixer.chunkChannelCount), inputChannels: AudioTrackMixer.chunkChannelCount)
					micWav = wav
					audioMixers.append(
						AudioTrackMixer(
							input: DiscardingAudioSink(),
							includesSystemAudio: false,
							includesMicrophone: true,
							microphoneGain: 1,
							limitsPeaks: false,
							onChunk: { chunk in wav.write(interleaved: chunk) },
							clock: clock
						)
					)
				} catch {
					emit([
						"event": "warning",
						"code": "mic-wav-unavailable",
						"message": "The microphone WAV could not be created: \(error)",
					])
				}
			}
		}
		let outputURL = URL(fileURLWithPath: request.outputs.screenPath)
		try FileManager.default.createDirectory(
			at: outputURL.deletingLastPathComponent(),
			withIntermediateDirectories: true
		)
		let capture = CameraCapture(
			outputURL: outputURL,
			sampleQueue: sampleQueue,
			withAudio: nativeMicrophoneEnabled,
			onFirstFrame: { [weak self] time, audioInput in
				guard let self else { return }
				forwarding.target = audioInput
				self.didStartWriting = true
				self.audioMixers.forEach { $0.beginTimeline(at: time) }
				self.startAudioTicker()
				self.didEmitRecordingStarted = true
				emit([
					"event": "recording-started",
					"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
					"width": 0,
					"height": 0,
					"captureBounds": ["x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0],
				])
			},
			retime: { [weak self] time in
				guard let self else { return nil }
				let pauseState = self.currentPauseState()
				if pauseState.paused { return nil }
				return pauseState.offset.isValid && pauseState.offset != .zero
					? CMTimeSubtract(time, pauseState.offset) : time
			}
		)
		try startMicrophoneCaptureIfNeeded()
		emit([
			"event": "ready",
			"schemaVersion": 1,
		])
		// Before the camera starts: its first frame starts the ticker, which reads this.
		sampleQueue.sync { cameraCapture = capture }
		do {
			try capture.start(
				deviceID: request.webcam.deviceId,
				deviceName: request.webcam.deviceName,
				maxWidth: request.webcam.width,
				maxHeight: request.webcam.height
			)
		} catch {
			sampleQueue.sync { cameraCapture = nil }
			microphoneCapture?.stop()
			microphoneCapture = nil
			throw error
		}
		emit([
			"event": "webcam-started",
			"deviceName": capture.deviceName ?? "",
			"format": capture.formatDescription,
		])
	}

	private func finishCameraOnly() async {
		var end = CMTime.invalid
		sampleQueue.sync {
			audioTicker?.cancel()
			audioTicker = nil
			if didStartWriting {
				end = timelineNow()
				audioMixers.forEach { $0.finish(atSourceTime: end) }
			}
			micWav?.finish()
		}
		guard let result = await finishCamera(at: end) else {
			try? FileManager.default.removeItem(atPath: request.outputs.screenPath)
			if let path = request.outputs.micWavPath {
				try? FileManager.default.removeItem(atPath: path)
			}
			emitError(code: "writer-failed", message: "The camera recorded nothing.")
			return
		}
		var stopped: [String: Any] = [
			"event": "recording-stopped",
			"screenPath": result.path,
			"droppedVideoFrames": 0,
			"webcamFrames": result.frames,
			"webcamRepeatedFrames": result.repeats,
		]
		if let micWav, micWav.framesWritten > 0, micWav.lastError == nil {
			stopped["micWavPath"] = micWav.url.path
		}
		emit(stopped)
	}

	/// The camera beside the screen. A camera that cannot start costs the take its camera, not
	/// the take: the app keeps its own recording of it as a fallback.
	private func startCameraIfNeeded() {
		guard request.webcam.enabled, let path = request.outputs.webcamPath, !path.isEmpty else {
			return
		}
		let capture = CameraCapture(
			outputURL: URL(fileURLWithPath: path),
			sampleQueue: sampleQueue,
			retime: { [weak self] time in
				guard let self else { return nil }
				let pauseState = self.currentPauseState()
				if pauseState.paused { return nil }
				return pauseState.offset.isValid && pauseState.offset != .zero
					? CMTimeSubtract(time, pauseState.offset) : time
			}
		)
		sampleQueue.sync { cameraCapture = capture }
		do {
			try capture.start(
				deviceID: request.webcam.deviceId,
				deviceName: request.webcam.deviceName,
				maxWidth: request.webcam.width,
				maxHeight: request.webcam.height
			)
			emit([
				"event": "webcam-started",
				"deviceName": capture.deviceName ?? "",
				"format": capture.formatDescription,
			])
		} catch {
			sampleQueue.sync { cameraCapture = nil }
			emit([
				"event": "warning",
				"code": "webcam-unavailable",
				"message": "The camera could not be recorded: \(error)",
			])
		}
	}

	private func startSystemAudioTapIfNeeded() {
		guard tapsSystemAudio, #available(macOS 14.2, *) else {
			return
		}
		let tap = SystemAudioTap { [weak self] sampleBuffer in
			guard let self else {
				return
			}
			self.sampleQueue.async {
				self.ingestTappedSystemAudio(sampleBuffer)
			}
		}
		systemAudioTap = tap
		// Off the start path: the first time, starting a tap blocks until the user answers
		// macOS' prompt, and the app gives a take only seconds to report it has started.
		// Audio that arrives late lands where it belongs, with silence in front of it.
		tapControlQueue.async {
			do {
				try tap.start()
			} catch {
				emit([
					"event": "warning",
					"code": "system-audio-unavailable",
					"message": "System audio could not be captured: \(error)",
				])
			}
		}
	}

	/// Queued behind the start rather than run beside it: a tap stopped while its start is
	/// still inside AudioDeviceStart is torn down under its own feet. Not awaited, so a
	/// prompt left unanswered cannot hold the recording's stop hostage; what the tap still
	/// delivers is dropped by `acceptsTappedAudio`.
	private func stopSystemAudioTap() {
		sampleQueue.sync {
			acceptsTappedAudio = false
		}
		guard let tap = systemAudioTap else {
			return
		}
		systemAudioTap = nil
		tapControlQueue.async {
			if #available(macOS 14.2, *), let tap = tap as? SystemAudioTap {
				tap.stop()
			}
		}
	}

	/// Sample queue. The tap's audio takes the same pause and retime path ScreenCaptureKit's
	/// system audio took in `stream(_:didOutputSampleBuffer:of:)`.
	private func ingestTappedSystemAudio(_ sampleBuffer: CMSampleBuffer) {
		guard acceptsTappedAudio else {
			return
		}
		let pauseState = currentPauseState()
		if pauseState.paused {
			return
		}
		guard let sampleBuffer = retimedSampleBuffer(sampleBuffer, subtracting: pauseState.offset) else {
			return
		}
		audioMixers.forEach { $0.ingest(sampleBuffer, from: .system) }
	}

	private func startMicrophoneCaptureIfNeeded() throws {
		guard nativeMicrophoneEnabled else {
			return
		}
		let capture = try MicrophoneCapture(deviceID: microphoneDeviceID) { [weak self] sampleBuffer in
			guard let self else {
				return
			}
			self.sampleQueue.async {
				self.ingestMicrophone(sampleBuffer)
			}
		}
		microphoneCapture = capture
		// The WAV takes the microphone's own channel count; the mixer feeds it stereo.
		// On the sample queue, the writer's only queue.
		sampleQueue.sync {
			guard let wav = micWav else { return }
			wav.reconfigure(channels: AVAudioChannelCount(capture.inputChannelCount))
			if wav.lastError != nil {
				emit([
					"event": "warning",
					"code": "mic-wav-unavailable",
					"message": "The microphone WAV could not be created: \(String(describing: wav.lastError))",
				])
			}
		}
		try capture.start()
	}

	/// Sample queue. The same pause and retime path as the system audio.
	private func ingestMicrophone(_ sampleBuffer: CMSampleBuffer) {
		let pauseState = currentPauseState()
		if pauseState.paused {
			return
		}
		guard let sampleBuffer = retimedSampleBuffer(sampleBuffer, subtracting: pauseState.offset) else {
			return
		}
		audioMixers.forEach { $0.ingest(sampleBuffer, from: .microphone) }
	}

	func pause() {
		let didPause = stateQueue.sync {
			if shutdownTask != nil || isPaused {
				return false
			}

			isPaused = true
			pauseStartedAt = CMClockGetTime(hostClock)
			return true
		}

		if didPause {
			emit([
				"event": "recording-paused",
				"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
			])
		}
	}

	func resume() {
		let (didResume, releasedHold, now) = stateQueue.sync { () -> (Bool, Bool, CMTime) in
			let now = CMClockGetTime(hostClock)
			if shutdownTask != nil || !isPaused {
				return (false, false, now)
			}

			if let pauseStartedAt {
				totalPausedDuration = CMTimeAdd(
					totalPausedDuration,
					CMTimeSubtract(now, pauseStartedAt)
				)
			}
			isPaused = false
			pauseStartedAt = nil
			let releasedHold = holdingStart
			holdingStart = false
			return (true, releasedHold, now)
		}

		if releasedHold {
			// The countdown reached zero: the take starts now. Not a resume for the app.
			if !isCameraOnly {
				startHeldScreenTake(releasedAt: now)
			}
		} else if didResume {
			emit([
				"event": "recording-resumed",
				"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
			])
		}
	}

	/// A held screen take starts at its release, from the screen as it was last seen during the
	/// hold. ScreenCaptureKit sends a complete frame only when something on the screen changes,
	/// so waiting for one would leave a still screen unstarted (and the app gives up on a start
	/// after 10 s), and a start that came later than the release would put the take's t=0, its
	/// first audio and its `recording-started` stamp after the moment the user was told to go.
	/// The countdown is kept out of the capture, so that frame is the screen itself.
	private func startHeldScreenTake(releasedAt release: CMTime) {
		sampleQueue.async { [weak self] in
			guard let self, !self.didStartWriting, let latest = self.latestScreenFrame else {
				return
			}
			let pauseState = self.currentPauseState()
			guard !pauseState.paused, !self.isShuttingDown else {
				return
			}
			self.writeScreenFrame(
				latest,
				at: CMTimeSubtract(release, pauseState.offset),
				pauseOffset: pauseState.offset
			)
		}
	}

	private var isShuttingDown: Bool {
		stateQueue.sync { shutdownTask != nil }
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		// Losing the audio-only stream costs the take its system audio, not the take.
		if stream === systemAudioStream {
			systemAudioStream = nil
			emit([
				"event": "warning",
				"code": "system-audio-unavailable",
				"message": "System audio stopped: \(error)",
			])
			return
		}
		emitError(code: "capture-stopped-with-error", message: "\(error)")
		Task {
			await stop()
		}
	}

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
		guard CMSampleBufferDataIsReady(sampleBuffer) else {
			return
		}
		let pauseState = currentPauseState()
		if pauseState.paused {
			// Not written, but what the screen shows now: after the resume, a still screen
			// repeats this, not the image from before the pause.
			if type == .screen, isCompleteFrame(sampleBuffer), let image = CMSampleBufferGetImageBuffer(sampleBuffer) {
				latestScreenFrame = image
			}
			return
		}
		guard let sampleBuffer = retimedSampleBuffer(sampleBuffer, subtracting: pauseState.offset) else {
			return
		}

		if type == .audio {
			audioMixers.forEach { $0.ingest(sampleBuffer, from: .system) }
			return
		}

		if type.rawValue == microphoneOutputTypeRawValue {
			audioMixers.forEach { $0.ingest(sampleBuffer, from: .microphone) }
			return
		}

		guard type == .screen else {
			return
		}
		guard isCompleteFrame(sampleBuffer) else {
			return
		}
		guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
			return
		}
		writeScreenFrame(
			pixelBuffer,
			at: CMSampleBufferGetPresentationTimeStamp(sampleBuffer),
			pauseOffset: pauseState.offset
		)
	}

	/// Sample queue. One screen frame onto the take, at its time on the take's clock (pauses
	/// already taken out); the first one starts the take.
	private func writeScreenFrame(_ pixelBuffer: CVPixelBuffer, at presentationTime: CMTime, pauseOffset: CMTime) {
		guard videoInput != nil, let writer else {
			return
		}
		// A frame that does not move the timeline forward fails the whole writer one append
		// later (-16364), so it is dropped here instead. After a resume that is one frame the
		// user never sees; without the check it was the end of the recording.
		switch videoTimestampGate.check(presentationTime) {
		case .admit:
			break
		case .invalid:
			reportRefusedVideoFrame(presentationTime, previous: nil, pauseOffset: pauseOffset)
			return
		case .notAfterPrevious(let previous):
			reportRefusedVideoFrame(presentationTime, previous: previous, pauseOffset: pauseOffset)
			return
		}
		if !didStartWriting {
			writer.startWriting()
			writer.startSession(atSourceTime: presentationTime)
			didStartWriting = true
			screenGrid.begin(at: presentationTime)
			audioMixers.forEach { $0.beginTimeline(at: presentationTime) }
			cameraCapture?.begin(at: presentationTime)
			startAudioTicker()
		}
		// Checked before the readiness gate, not only at a false append: a failed
		// writer is not guaranteed to call itself ready, and an append that is never
		// attempted can never report the failure (issue #621).
		if writer.status == .failed {
			reportWriterFailure("writer status")
			return
		}

		videoTimestampGate.record(presentationTime)
		// On the constant 30 fps grid: the empty slots before this frame repeat the last one,
		// then this frame takes its own slot. A slot that could not be written stops the run,
		// so slots are only ever written in order; the next frame or tick fills from there.
		let placed = screenGrid.place(frameAt: presentationTime)
		var inOrder = true
		if let repeats = placed.repeats {
			let fill = latestScreenFrame ?? pixelBuffer
			for slot in repeats where !appendScreenFrame(fill, slot: slot) {
				inOrder = false
				break
			}
		}
		if inOrder, let slot = placed.slot {
			appendScreenFrame(pixelBuffer, slot: slot)
		}
		latestScreenFrame = pixelBuffer
	}

	/// Sample queue. One slot of the screen's constant-rate track.
	@discardableResult
	private func appendScreenFrame(_ pixelBuffer: CVPixelBuffer, slot: Int64) -> Bool {
		guard let videoInput, let screenAdaptor else {
			return false
		}
		guard videoInput.isReadyForMoreMediaData else {
			droppedVideoFrames += 1
			return false
		}
		guard screenAdaptor.append(pixelBuffer, withPresentationTime: screenGrid.time(ofSlot: slot)) else {
			droppedVideoFrames += 1
			reportWriterFailure("video append")
			return false
		}
		screenGrid.wrote(slot: slot)
		if !didEmitRecordingStarted {
			didEmitRecordingStarted = true
			emit([
				"event": "recording-started",
				"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
				"width": outputWidth,
				"height": outputHeight,
				"captureBounds": captureBoundsPayload(),
			])
		}
		return true
	}

	/// Sample queue, on the ticker: a still screen delivers no frames, so the slots the clock
	/// has passed repeat the last one, six slots (200 ms) behind it so a frame still on its
	/// way finds its own slot free.
	private func tickScreen(now: CMTime) {
		guard didStartWriting, let latest = latestScreenFrame,
			let due = screenGrid.dueRepeats(upTo: now, latency: 6)
		else {
			return
		}
		for slot in due where !appendScreenFrame(latest, slot: slot) {
			break
		}
	}

	/// A failed AVAssetWriter keeps accepting appends and keeps answering false, so
	/// a recorder that discards that Bool records nothing while the HUD counts on.
	/// That is how a two-minute take was already lost by its fourth second and only
	/// said so at finishWriting(). The Windows helper checks every WriteSample
	/// HRESULT and escalates; this is the macOS half of the same contract -- report
	/// once, at the append that actually failed, carrying the live writer.error.
	///
	/// Deliberately not the code finishWriter() emits, and the difference is load
	/// bearing. That one is the terminal result of stopping, and the Electron side
	/// settles its stop on exactly one of `recording-stopped` or `writer-failed`.
	/// Give both sites the same code behind this one-shot guard and a writer that
	/// died mid-capture emits nothing at all at stop, so the stop promise never
	/// settles and every failure becomes the "Saving..." hang instead of an error.
	/// This event answers "when did the writer die"; that one answers "did stopping
	/// work". Two questions, two codes.
	///
	/// It also ends the capture, the way `didStopWithError` does. A failed writer
	/// never recovers, so every frame after it is dropped; issue #621 is a take
	/// whose writer died at 75 s while capture ran on for 22 more minutes. The
	/// process stays up and still answers `stop`, so the Electron stop path works
	/// unchanged and reads this event back as the reason.
	private func reportWriterFailure(_ stage: String) {
		guard !didReportWriterFailure, let writer else {
			return
		}
		didReportWriterFailure = true
		emitError(
			code: "writer-failed-during-capture",
			message: "Recording stopped: the video file could not be written (\(stage): "
				+ (writer.error.map { "\($0)" }
					?? "AVAssetWriter status \(writer.status.rawValue)")
				+ ").",
		)
		Task {
			await stop()
		}
	}

	/// Once per take, with the numbers that tell the cause apart. A refusal with a non-zero pause
	/// offset, a few milliseconds behind the previous frame, is the pause shift measured in
	/// `VideoTimestampGate`. One with no pause offset at all is a source handing over time that
	/// goes backwards, which nothing here has observed yet and is worth a report.
	private func reportRefusedVideoFrame(_ presentationTime: CMTime, previous: CMTime?, pauseOffset: CMTime) {
		guard videoTimestampGate.rejectedCount == 1 else {
			return
		}
		emit([
			"event": "warning",
			"code": "video-frame-timestamp-refused",
			"message": "Dropped a video frame whose timestamp did not advance.",
			"presentationTimeSeconds": presentationTime.isNumeric ? CMTimeGetSeconds(presentationTime) : -1,
			"previousSeconds": previous.map { CMTimeGetSeconds($0) } ?? -1,
			"pauseOffsetSeconds": pauseOffset.isNumeric ? CMTimeGetSeconds(pauseOffset) : 0,
		])
	}

	private func ensureRequestedPermissions(screen: Bool) throws {
		if screen && !CGPreflightScreenCaptureAccess() {
			let granted = CGRequestScreenCaptureAccess()
			if !granted {
				throw HelperError.permissionDenied("Screen recording permission is required for ScreenCaptureKit capture.")
			}
		}

		if request.audio.microphone.enabled {
			switch AVCaptureDevice.authorizationStatus(for: .audio) {
			case .authorized:
				break
			case .notDetermined:
				let semaphore = DispatchSemaphore(value: 0)
				AVCaptureDevice.requestAccess(for: .audio) { _ in
					semaphore.signal()
				}
				let waitResult = semaphore.wait(timeout: .now() + 30)
				if waitResult == .timedOut || AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
					throw HelperError.permissionDenied("Microphone permission is required for native microphone capture.")
				}
			default:
				throw HelperError.permissionDenied("Microphone permission is required for native microphone capture.")
			}
		}
	}

	private func captureBoundsPayload() -> [String: Double] {
		return [
			"x": captureFrame.origin.x,
			"y": captureFrame.origin.y,
			"width": captureFrame.size.width,
			"height": captureFrame.size.height,
		]
	}

	private func makeCaptureTarget(picked: PickedSource) -> CaptureTarget {
		let size = captureSize(
			for: picked.filter,
			fallbackPointSize: picked.frame.size,
			fallbackDisplayId: picked.displayId ?? CGMainDisplayID()
		)
		return CaptureTarget(
			filter: picked.filter,
			width: size.width,
			height: size.height,
			captureFrame: picked.frame
		)
	}

	/// The app's own windows (HUD, notes) plus the system ones a demo never wants.
	private func excludedWindowIDs(in content: SCShareableContent) -> [UInt32] {
		let candidates = content.windows.map {
			CaptureWindowCandidate(
				windowID: $0.windowID,
				bundleID: $0.owningApplication?.bundleIdentifier,
				layer: $0.windowLayer
			)
		}
		return resolveCaptureExcludedWindowIDs(
			requestedWindowIDs: (request.excludedWindowIds ?? [])
				+ systemCaptureExcludedWindowIDs(
					candidates,
					hideDesktopIcons: request.hideDesktopIcons ?? false
				),
			availableWindowIDs: content.windows.map(\.windowID)
		)
	}

	private func displayFilter(
		_ display: SCDisplay,
		in content: SCShareableContent,
		excluding windowIDs: [UInt32]
	) -> SCContentFilter {
		let excluded = Set(windowIDs)
		return SCContentFilter(
			display: display,
			excludingWindows: content.windows.filter { excluded.contains($0.windowID) }
		)
	}

	/// A filter excludes windows, not apps, and a notification banner is a window that did
	/// not exist when the take started. So the exclusion is re-read while recording and the
	/// filter swapped whenever it changes. ponytail: a 250 ms poll, so a banner can show for
	/// up to a quarter second as it slides in; the picker path excludes Notification Center
	/// by bundle id and has no such gap.
	private func startExclusionRefresh(displayID: CGDirectDisplayID) {
		exclusionRefreshTask = Task { [weak self] in
			var current: [UInt32] = []
			while !Task.isCancelled {
				try? await Task.sleep(nanoseconds: 250_000_000)
				guard let self, let stream = self.stream,
					let content = try? await SCShareableContent.excludingDesktopWindows(
						false,
						onScreenWindowsOnly: true
					),
					let display = content.displays.first(where: { $0.displayID == displayID })
				else {
					continue
				}
				let next = self.excludedWindowIDs(in: content)
				guard Set(next) != Set(current) else {
					continue
				}
				current = next
				try? await stream.updateContentFilter(
					self.displayFilter(display, in: content, excluding: next)
				)
			}
		}
	}

	private func makeCaptureTarget(from content: SCShareableContent) throws -> CaptureTarget {
		switch request.source.type {
		case "display":
			guard let displayId = request.source.displayId else {
				throw HelperError.sourceNotFound("Display capture requires source.displayId.")
			}
			guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
				throw HelperError.sourceNotFound("No ScreenCaptureKit display found for id \(displayId).")
			}
			let requestedWindowIDs = request.excludedWindowIds ?? []
			let resolvedWindowIDs = excludedWindowIDs(in: content)
			let filter = displayFilter(display, in: content, excluding: resolvedWindowIDs)
			emit([
				"event": "capture-window-exclusion",
				"requestedWindowIds": requestedWindowIDs,
				"resolvedWindowIds": resolvedWindowIDs,
				"excludedWindowCount": resolvedWindowIDs.count,
			])
			let size = captureSize(
				for: filter,
				fallbackPointSize: display.frame.size,
				fallbackDisplayId: display.displayID
			)
			return CaptureTarget(
				filter: filter,
				width: size.width,
				height: size.height,
				captureFrame: display.frame
			)
		case "window":
			guard let windowId = request.source.windowId else {
				throw HelperError.sourceNotFound("Window capture requires source.windowId.")
			}
			guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
				throw HelperError.sourceNotFound("No ScreenCaptureKit window found for id \(windowId).")
			}
			let candidateDisplay = content.displays.first {
				$0.frame.intersects(window.frame) || $0.frame.contains(CGPoint(x: window.frame.midX, y: window.frame.midY))
			}
			let filter = SCContentFilter(desktopIndependentWindow: window)
			let size = captureSize(
				for: filter,
				fallbackPointSize: window.frame.size,
				// Unrelated to `initializeCoreGraphicsWindowServerConnection()`: that call
				// exists purely for its side effect at process startup, this one wants the
				// actual display ID as a fallback when no display intersects the window.
				fallbackDisplayId: candidateDisplay?.displayID ?? CGMainDisplayID()
			)
			return CaptureTarget(
				filter: filter,
				width: size.width,
				height: size.height,
				captureFrame: window.frame
			)
		default:
			throw HelperError.invalidSourceType(request.source.type)
		}
	}

	/// The audio-only stream of a window take: the smallest frame ScreenCaptureKit allows, at
	/// one a second, since only its audio is read (it has no `.screen` output).
	private func makeSystemAudioStreamConfiguration() -> SCStreamConfiguration {
		let configuration = SCStreamConfiguration()
		configuration.width = 2
		configuration.height = 2
		configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
		configuration.queueDepth = 3
		configuration.capturesAudio = true
		configuration.sampleRate = 48_000
		configuration.channelCount = 2
		configuration.excludesCurrentProcessAudio = true
		return configuration
	}

	private func makeStreamConfiguration() -> SCStreamConfiguration {
		let configuration = SCStreamConfiguration()
		configuration.width = outputWidth
		configuration.height = outputHeight
		// Belt and braces for the defect `captureOutputSize` exists to prevent. Left at its
		// default of `false`, ScreenCaptureKit "only scales down" (SDK header), so any frame
		// smaller than the buffer is drawn at native size in a corner and the rest stays
		// background black — a whole recording letterboxed inside its own frame (issue #418).
		// With the buffer now derived from the filter the two agree and this changes nothing;
		// it is here so that a future source whose size we mispredict comes out scaled rather
		// than cornered.
		configuration.scalesToFit = true
		// At most the grid's rate: a 60 fps source puts every other frame exactly between two
		// slots of the 30 fps grid.
		configuration.minimumFrameInterval = CMTime(value: 1, timescale: Self.screenFrameRate)
		// One more than before: the last frame is held to repeat on the constant-rate grid.
		configuration.queueDepth = 8
		configuration.showsCursor = !request.video.hideSystemCursor
		// Studio-range BT.709 YCbCr from ScreenCaptureKit itself, which the encoder takes as is
		// and the compositor decodes (#943). BGRA left the matrix to VideoToolbox. Nothing here
		// reads the pixels: a frame goes through `retimedSampleBuffer` (timing only) to
		// `append`, and `isCompleteFrame` reads attachments. 1.5 bytes a pixel instead of 4,
		// times `queueDepth`.
		configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
		configuration.colorMatrix = captureYCbCrMatrix
		// Unset, the buffers carry the display's colour space: P3 on most Macs.
		configuration.colorSpaceName = CGColorSpace.sRGB
		configuration.sampleRate = 48_000
		configuration.channelCount = 2
		configuration.excludesCurrentProcessAudio = true
		configuration.capturesAudio =
			request.audio.system.enabled && !tapsSystemAudio && !recordsSystemAudioFromDisplay

		nativeMicrophoneEnabled = false
		guard request.audio.microphone.enabled else {
			return configuration
		}
		let microphone = resolveMicrophoneCapture(
			supported: true,
			deviceID: request.audio.microphone.deviceId,
			deviceName: request.audio.microphone.deviceName,
			devices: AVCaptureDevice.devices(for: .audio).map {
				(id: $0.uniqueID, name: $0.localizedName)
			}
		)
		switch microphone {
		case .unsupported:
			emit([
				"event": "warning",
				"code": "microphone-unavailable",
				"message": "Native microphone capture requires ScreenCaptureKit microphone support on this macOS version.",
			])
		case .noInput:
			emit([
				"event": "warning",
				"code": "microphone-not-found",
				"message": "No audio input is connected; recording without the microphone.",
			])
		case .device(let deviceId):
			nativeMicrophoneEnabled = true
			microphoneDeviceID = deviceId
			if deviceId == nil, requestedASpecificMicrophone {
				emit([
					"event": "warning",
					"code": "microphone-defaulted",
					"message": "The requested microphone could not be resolved; capturing the default input.",
				])
			}
		}

		return configuration
	}

	private func setupWriter() throws {
		let outputUrl = URL(fileURLWithPath: request.outputs.screenPath)
		try? FileManager.default.removeItem(at: outputUrl)
		try FileManager.default.createDirectory(
			at: outputUrl.deletingLastPathComponent(),
			withIntermediateDirectories: true
		)

		let writer = try AVAssetWriter(outputURL: outputUrl, fileType: .mp4)
		// Costs nothing on a clean stop -- finishWriting() still writes a normal
		// moov -- and is the difference between a readable file and a total loss
		// when the helper dies before reaching it. The Windows helper gets the
		// same property from MFCreateFMPEG4MediaSink; see issues #252/#292/#327.
		writer.movieFragmentInterval = CMTime(seconds: 1, preferredTimescale: 600)
		let settings: [String: Any] = [
			AVVideoCodecKey: AVVideoCodecType.h264,
			AVVideoWidthKey: outputWidth,
			AVVideoHeightKey: outputHeight,
			// BT.709 tags, the colour the stream is captured in (#943).
			AVVideoColorPropertiesKey: videoColorProperties,
			AVVideoCompressionPropertiesKey: [
				// From the size this stream really got. The renderer sends none (#924).
				AVVideoAverageBitRateKey: request.video.bitrate
					?? defaultVideoBitrate(width: outputWidth, height: outputHeight, fps: request.video.fps),
				AVVideoExpectedSourceFrameRateKey: Int(Self.screenFrameRate),
				// Without this the encoder defaults to B-frames, and a reordered
				// stream needs a composition offset per sample. AVAssetWriter emits
				// those in a version 0 `trun`, where ISO/IEC 14496-12 8.8.8.2 defines
				// the field as UNSIGNED -- so a negative offset goes out as
				// 0xFFFFFFF6 and the fragment writer refuses the fragment it is
				// about to emit. That refusal is -11800 / -16341, raised from the
				// single site in MediaToolbox that writes moof/traf/trun, which is
				// why it appears if and only if movieFragmentInterval is set and
				// lands exactly on a fragment boundary.
				//
				// Turning reordering off makes every offset zero and PTS == DTS, so
				// the fragment stays representable. A screen recorder gives up
				// nothing for it: B-frames buy compression on lookahead-friendly
				// content and cost encode latency, which is the wrong trade for
				// real-time capture.
				//
				// Measured on macOS 26.5 / M1, 1080p with system audio. How reliably
				// the bug bites scales with append rate, so quote the rate with the
				// result: at ~57 fps, the rate the app actually drives, reordering
				// on dies at 13.0s while reordering off stops clean at 31.6s; at
				// 30 fps it is intermittent, dying at 1.0s and 2.0s but once
				// surviving 22.2s. That intermittency is why the byte-level evidence
				// leads here and the run counts only corroborate: the offsets are
				// out of spec in every fragmented file whether or not that
				// particular run happened to die. Reordering off is 3/3 clean across
				// both rates, and a SIGKILL at 25s still leaves 27 readable `moof`.
				AVVideoAllowFrameReorderingKey: false,
				// A keyframe every second, by frame count and by time: a still screen
				// delivers fewer frames than the fps, and the count alone would then
				// stretch the GOP, which is the editor's scrub cost (#937).
				AVVideoMaxKeyFrameIntervalKey: videoKeyFrameInterval(fps: Int(Self.screenFrameRate)),
				AVVideoMaxKeyFrameIntervalDurationKey: 1,
			],
		]
		let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
		input.expectsMediaDataInRealTime = true

		guard writer.canAdd(input) else {
			throw HelperError.writerSetupFailed("Unable to add H.264 video input to AVAssetWriter.")
		}

		writer.add(input)
		self.writer = writer
		self.videoInput = input
		screenAdaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)

		// Track 0: one mixed AAC track at the bitrate Windows encodes its own mixed track with
		// (24 000 B/s), so the two platforms produce comparable files.
		if request.audio.system.enabled || nativeMicrophoneEnabled {
			let clock: TimelineClock = { [weak self] in self?.timelineNow() ?? .invalid }
			let mixInput = try addAudioInput(to: writer, bitRate: 192_000)
			audioInputs = [mixInput]
			audioMixers = [
				AudioTrackMixer(
					input: mixInput,
					includesSystemAudio: request.audio.system.enabled,
					includesMicrophone: nativeMicrophoneEnabled,
					microphoneGain: request.audio.microphone.gain,
					clock: clock
				)
			]
			// Tracks 1 and 2: each source alone, only when there are two to tell apart.
			if request.audio.system.enabled && nativeMicrophoneEnabled {
				for (system, microphone) in [(true, false), (false, true)] {
					let stemInput = try addAudioInput(to: writer, bitRate: 128_000)
					audioInputs.append(stemInput)
					audioMixers.append(
						AudioTrackMixer(
							input: stemInput,
							includesSystemAudio: system,
							includesMicrophone: microphone,
							microphoneGain: request.audio.microphone.gain,
							clock: clock
						)
					)
				}
			}
		}

		if nativeMicrophoneEnabled, let path = request.outputs.micWavPath, !path.isEmpty {
			do {
				let wav = try PCMWavWriter(url: URL(fileURLWithPath: path), channels: AVAudioChannelCount(AudioTrackMixer.chunkChannelCount), inputChannels: AudioTrackMixer.chunkChannelCount)
				micWav = wav
				audioMixers.append(
					AudioTrackMixer(
						input: DiscardingAudioSink(),
						includesSystemAudio: false,
						includesMicrophone: true,
						microphoneGain: 1,
						limitsPeaks: false,
						onChunk: { chunk in wav.write(interleaved: chunk) },
						clock: { [weak self] in self?.timelineNow() ?? .invalid }
					)
				)
			} catch {
				emit([
					"event": "warning",
					"code": "mic-wav-unavailable",
					"message": "The microphone WAV could not be created: \(error)",
				])
			}
		}
	}

	/// The instant the writer's timeline has reached: the host clock, less the time spent
	/// paused — the same transform `retimedSampleBuffer` applies to every sample, so this and
	/// the presentation timestamps are answers in one domain.
	///
	/// Frozen while paused, because `pauseStartedAt` stops moving and `totalPausedDuration`
	/// does not yet include the pause in progress. On resume the offset grows by exactly the
	/// pause, so the position continues from where it froze: the pause interrupts the audio
	/// clock without shifting anything recorded after it. That is the same property the
	/// Windows mixer gets by re-deriving its anchor on resume, derived here instead of tracked.
	private func timelineNow() -> CMTime {
		let (paused, offset, pausedAt) = stateQueue.sync {
			(isPaused, totalPausedDuration, pauseStartedAt)
		}
		let now = paused ? (pausedAt ?? CMClockGetTime(hostClock)) : CMClockGetTime(hostClock)
		return CMTimeSubtract(now, offset)
	}

	/// A take that nothing is playing into is exactly the take whose audio timeline has to keep
	/// moving, so the mixer cannot be driven by buffer arrival alone. 10 ms is the chunk size it
	/// emits at; the leeway lets the system coalesce the wakeups, since being a few milliseconds
	/// late only means the next tick emits two chunks instead of one.
	private func startAudioTicker() {
		// Always now (1.2.0): the screen and the camera keep their constant frame rate off it.
		guard audioTicker == nil else {
			return
		}

		let timer = DispatchSource.makeTimerSource(queue: sampleQueue)
		timer.schedule(
			deadline: .now() + .milliseconds(10),
			repeating: .milliseconds(10),
			leeway: .milliseconds(5)
		)
		timer.setEventHandler { [weak self] in
			guard let self else {
				return
			}
			// A still screen delivers no complete frames, so the frame path alone
			// could sit on a dead writer for as long as nothing on screen moves.
			if self.writer?.status == .failed {
				self.reportWriterFailure("writer status")
				return
			}
			self.audioMixers.forEach { $0.tick() }
			let now = self.timelineNow()
			self.tickScreen(now: now)
			self.cameraCapture?.tick(now: now)
			self.cameraCapture?.reportFailureOnce()
		}
		audioTicker = timer
		timer.resume()
	}

	private func finishWriter() async {
		guard let writer else {
			return
		}
		var cameraEnd = CMTime.invalid

		// A take that ended before its first frame -- a start that failed after the writer
		// was set up, or a stop right away -- never called `startWriting`. Finishing (or
		// even marking inputs finished on) a writer in that state raises an Objective-C
		// exception, which kills the process: here, in a picker session, that would take
		// every later take and the user's pick down with it. There is nothing to finalise:
		// drop whatever file the writer may have created and say the take produced none.
		if writer.status == .unknown {
			sampleQueue.sync {
				audioTicker?.cancel()
				audioTicker = nil
			}
			try? FileManager.default.removeItem(atPath: request.outputs.screenPath)
			micWav?.finish()
			for path in [request.outputs.webcamPath, request.outputs.micWavPath].compactMap({ $0 }) {
				try? FileManager.default.removeItem(atPath: path)
			}
			emitError(
				code: "writer-failed",
				message: "The recording stopped before its first frame was written."
			)
			return
		}

		// Capture has stopped, so nothing is in flight on the sample queue any more; hopping
		// onto it once is what makes the mixer's final flush safe without a lock, and it is
		// also where the ticker has to die, since that is the queue it fires on.
		//
		// `endSession` is the trailing half of the same bug the clock-driven cursor fixes at
		// the front. Without it the file ended at the last sample anything happened to deliver,
		// so a ten-second take that went quiet at six yielded a six-second recording; the
		// helper had never called it at all. `end` comes from the same clock the mixer runs on
		// and is read after `stopCapture()` returned, so it is at or past every sample already
		// appended — which is what makes it safe to hand to `endSession`, since a source time
		// before an appended sample would trim that sample back out.
		sampleQueue.sync {
			audioTicker?.cancel()
			audioTicker = nil

			let end = timelineNow()
			fillScreenTail(upTo: end)
			audioMixers.forEach { $0.finish(atSourceTime: end) }
			micWav?.finish()
			if didStartWriting, writer.status == .writing {
				writer.endSession(atSourceTime: end)
			}
			cameraEnd = end
		}

		// The camera's file closes on its own; its tail is filled to the same instant.
		let cameraResult = await finishCamera(at: cameraEnd)

		let (refusedVideoFrames, droppedFrames) = sampleQueue.sync {
			(videoTimestampGate.rejectedCount, droppedVideoFrames)
		}
		if refusedVideoFrames > 1 {
			emit([
				"event": "warning",
				"code": "video-frame-timestamps-refused",
				"message": "Dropped \(refusedVideoFrames) video frames whose timestamps did not advance.",
				"count": refusedVideoFrames,
			])
		}

		videoInput?.markAsFinished()
		audioInputs.forEach { $0.markAsFinished() }

		await withCheckedContinuation { continuation in
			writer.finishWriting {
				continuation.resume()
			}
		}

		if writer.status == .completed {
			var stopped: [String: Any] = [
				"event": "recording-stopped",
				"screenPath": request.outputs.screenPath,
				"droppedVideoFrames": droppedFrames,
				"screenFrameRate": Int(Self.screenFrameRate),
			]
			if let cameraResult {
				stopped["webcamPath"] = cameraResult.path
				stopped["webcamFrames"] = cameraResult.frames
				stopped["webcamRepeatedFrames"] = cameraResult.repeats
			}
			if let micWav, micWav.framesWritten > 0, micWav.lastError == nil {
				stopped["micWavPath"] = micWav.url.path
			}
			emit(stopped)
		} else {
			emitError(
				code: "writer-failed",
				message: writer.error.map { "\($0)" } ?? "AVAssetWriter failed with status \(writer.status.rawValue)."
			)
		}
	}

	/// Sample queue, at the stop: the slots up to `end` repeat the last frame, waiting briefly
	/// for an encoder still busy with the frames before them.
	private func fillScreenTail(upTo end: CMTime) {
		guard didStartWriting, writer?.status == .writing, let latest = latestScreenFrame, let videoInput,
			let due = screenGrid.dueRepeats(upTo: end, latency: 1)
		else {
			return
		}
		for slot in due {
			var waited = 0
			while !videoInput.isReadyForMoreMediaData && waited < 200 {
				Thread.sleep(forTimeInterval: 0.005)
				waited += 1
			}
			if !appendScreenFrame(latest, slot: slot) {
				break
			}
		}
	}

	/// The camera's file, closed at `end`: its path and frame counts, or nil when the take has
	/// no camera (none asked for, none started, or no frame ever arrived).
	private func finishCamera(at end: CMTime) async -> (path: String, frames: Int64, repeats: Int64)? {
		guard let camera = cameraCapture else {
			return nil
		}
		cameraCapture = nil
		guard end.isValid else {
			return nil
		}
		let completed: Bool = await withCheckedContinuation { continuation in
			sampleQueue.async {
				camera.finish(at: end) { ok in
					continuation.resume(returning: ok)
				}
			}
		}
		guard completed else {
			// A file the writer did not close cleanly is still fragmented and readable: kept
			// when it holds anything, for the app to salvage, never deleted here.
			let size = (try? FileManager.default.attributesOfItem(atPath: camera.outputURL.path)[.size] as? Int) ?? 0
			emit([
				"event": "warning",
				"code": "webcam-not-recorded",
				"message": "The camera file could not be written: "
					+ (camera.writerError ?? "no frame arrived (\(camera.framesReceived) received)"),
			])
			if size > 0, camera.framesWritten > 0 {
				return (camera.outputURL.path, camera.framesWritten, camera.repeatsWritten)
			}
			try? FileManager.default.removeItem(at: camera.outputURL)
			return nil
		}
		return (camera.outputURL.path, camera.framesWritten, camera.repeatsWritten)
	}

	private func addAudioInput(to writer: AVAssetWriter, bitRate: Int) throws -> AVAssetWriterInput {
		let settings: [String: Any] = [
			AVFormatIDKey: kAudioFormatMPEG4AAC,
			AVSampleRateKey: 48_000,
			AVNumberOfChannelsKey: 2,
			AVEncoderBitRateKey: bitRate,
		]
		let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
		input.expectsMediaDataInRealTime = true

		guard writer.canAdd(input) else {
			throw HelperError.writerSetupFailed("Unable to add AAC audio input to AVAssetWriter.")
		}

		writer.add(input)
		return input
	}

	private func currentPauseState() -> (paused: Bool, offset: CMTime) {
		stateQueue.sync {
			(isPaused, totalPausedDuration)
		}
	}

	private func retimedSampleBuffer(_ sampleBuffer: CMSampleBuffer, subtracting offset: CMTime) -> CMSampleBuffer? {
		if !offset.isValid || offset == .zero {
			return sampleBuffer
		}

		let sampleCount = CMSampleBufferGetNumSamples(sampleBuffer)
		if sampleCount <= 0 {
			return sampleBuffer
		}

		var timing = Array(repeating: CMSampleTimingInfo(), count: sampleCount)
		let timingStatus = CMSampleBufferGetSampleTimingInfoArray(
			sampleBuffer,
			entryCount: sampleCount,
			arrayToFill: &timing,
			entriesNeededOut: nil
		)
		// Both failures drop the sample rather than pass it on unshifted. An unshifted frame sits
		// a whole pause ahead of the timeline, and every correctly shifted frame after it would
		// then fall behind it — refused by the timestamp gate for as long as the pause lasted.
		if timingStatus != noErr {
			emit([
				"event": "warning",
				"code": "sample-retime-failed",
				"message": "Unable to read sample timing info: \(timingStatus).",
			])
			return nil
		}

		for index in timing.indices {
			if timing[index].presentationTimeStamp.isValid {
				timing[index].presentationTimeStamp = CMTimeSubtract(
					timing[index].presentationTimeStamp,
					offset
				)
			}
			if timing[index].decodeTimeStamp.isValid {
				timing[index].decodeTimeStamp = CMTimeSubtract(timing[index].decodeTimeStamp, offset)
			}
		}

		var retimedBuffer: CMSampleBuffer?
		let copyStatus = CMSampleBufferCreateCopyWithNewTiming(
			allocator: kCFAllocatorDefault,
			sampleBuffer: sampleBuffer,
			sampleTimingEntryCount: sampleCount,
			sampleTimingArray: &timing,
			sampleBufferOut: &retimedBuffer
		)
		if copyStatus != noErr {
			emit([
				"event": "warning",
				"code": "sample-retime-failed",
				"message": "Unable to copy sample timing info: \(copyStatus).",
			])
			return nil
		}

		return retimedBuffer
	}

	private func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
		guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
			sampleBuffer,
			createIfNecessary: false
		) as? [[SCStreamFrameInfo: Any]],
			let attachment = attachments.first,
			let statusRawValue = attachment[SCStreamFrameInfo.status] as? Int,
			let status = SCFrameStatus(rawValue: statusRawValue)
		else {
			return true
		}

		return status == .complete
	}

	/// Output-buffer size for a filter, capped by the resolution the app asked for.
	///
	/// The filter is asked first, because `contentRect × pointPixelScale` is by definition the
	/// pixel size ScreenCaptureKit is about to rasterise — see `captureOutputSize`, which also
	/// explains what a buffer sized any other way does to the frame (issue #418).
	///
	/// Those two properties are macOS 14. On 13 the fallback is the region's own point size
	/// times the display's scale factor, which is the same product one step further from the
	/// source. It is NOT `CGDisplayPixelsWide`/`High`: those follow the display *mode* rather
	/// than the filter, and the mismatch between them is the bug.
	private func captureSize(
		for filter: SCContentFilter,
		fallbackPointSize: CGSize,
		fallbackDisplayId: CGDirectDisplayID
	) -> (width: Int, height: Int) {
		let contentSize: CGSize
		let pointPixelScale: CGFloat
		if #available(macOS 14.0, *) {
			contentSize = filter.contentRect.size
			pointPixelScale = CGFloat(filter.pointPixelScale)
		} else {
			contentSize = fallbackPointSize
			pointPixelScale = CGFloat(Self.scaleFactor(for: fallbackDisplayId))
		}
		return captureOutputSize(
			contentSize: contentSize,
			pointPixelScale: pointPixelScale,
			maxWidth: request.video.width,
			maxHeight: request.video.height
		)
	}

	private static func scaleFactor(for displayId: CGDirectDisplayID) -> Int {
		guard let mode = CGDisplayCopyDisplayMode(displayId) else {
			return 1
		}

		return max(1, mode.pixelWidth / max(1, mode.width))
	}

	private func supportsNativeMicrophoneCapture(streamConfig: SCStreamConfiguration) -> Bool {
		streamConfig.responds(to: Selector(("setCaptureMicrophone:"))) &&
			streamConfig.responds(to: Selector(("setMicrophoneCaptureDeviceID:"))) &&
			SCStreamOutputType(rawValue: microphoneOutputTypeRawValue) != nil
	}

	/// Did the user actually ask for a particular microphone?
	///
	/// The same test the Windows helper makes before emitting this warning
	/// (`wantedAParticularMicrophone` in wgc-capture/src/wasapi_loopback_capture.cpp),
	/// and it has to be made here too because `resolveMicrophoneDeviceID()`
	/// returns nil for two very different situations. One is a chosen microphone that
	/// nothing here could find, which is worth saying out loud. The other is no choice
	/// at all, which is the common case and has to stay silent: the HUD leaves both
	/// fields unset until its picker moves off "default", and persists the literal id
	/// "default" when the user picks Chromium's own Default entry — so both shapes
	/// arrive here meaning "the system default is fine", not "your microphone is gone".
	private var requestedASpecificMicrophone: Bool {
		let deviceId =
			request.audio.microphone.deviceId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		let deviceName =
			request.audio.microphone.deviceName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		// "default" has to veto the name, not sit beside it. Chromium's picker
		// persists BOTH fields from whichever entry was clicked, and its Default
		// entry is labelled "Default - Microphone (…)" — a string no AVCaptureDevice
		// localizedName ever matches. Reading the name here meant that picking
		// "Default" warned about a microphone the user never chose.
		if deviceId == "default" { return false }
		return !deviceId.isEmpty || !deviceName.isEmpty
	}
}

@main
struct OpenScreenScreenCaptureKitHelper {
	// This helper is a plain command-line executable, so nothing has connected it to the
	// window server yet. `SCContentFilter(desktopIndependentWindow:)` reaches into SkyLight
	// (`SLSGetDisplaysWithRect`) to find the display a window sits on, and SkyLight aborts
	// with `CGS_REQUIRE_INIT` when CoreGraphics was never initialised in the process — so
	// every window capture crashed before it produced a frame, while display capture (which
	// never resolves a rect) worked fine. Touching any CoreGraphics display API first
	// performs that initialisation.
	private static func initializeCoreGraphicsWindowServerConnection() {
		_ = CGMainDisplayID()
	}

	/// The flag that turns this helper into a one-shot answer to "may we record the
	/// screen", printed as the usual single JSON line and nothing else.
	private static let screenAccessStatusFlag = "--screen-access-status"

	/// The flag that turns this helper into a long-lived session around Apple's system
	/// picker. See `PickerSession`.
	private static let pickerSessionFlag = "--picker-session"

	/// The flag that raises macOS' "record system audio" prompt and exits once it is
	/// answered. See `SystemAudioTap.requestAccess`.
	private static let requestSystemAudioFlag = "--request-system-audio"

	static func main() async {
		do {
			initializeCoreGraphicsWindowServerConnection()

			// Answered from a process that exists for one read and then dies, because a FRESH
			// PROCESS is the only place the answer can be trusted.
			// `CGPreflightScreenCaptureAccess()` caches its result for the life of the calling
			// process: once it has answered false it answers false forever, whatever the user
			// does in System Settings afterwards. The app is long-lived, and Chromium's
			// `getMediaAccessStatus("screen")` goes through that same function, so from the
			// first miss until the next relaunch the app cannot observe its own permission
			// being granted. That staleness -- not the missing prompt alone -- is what left
			// the permission unreachable without a restart.
			//
			// Deliberately BEFORE the macOS 13 guard and the request decode below: the question
			// is asked on every macOS the app supports, and answering it needs neither
			// ScreenCaptureKit nor a recording request.
			if CommandLine.arguments.count == 2, CommandLine.arguments[1] == screenAccessStatusFlag {
				emit([
					"event": "screen-access",
					"granted": CGPreflightScreenCaptureAccess(),
				])
				exit(0)
			}

			if CommandLine.arguments.count == 2, CommandLine.arguments[1] == requestSystemAudioFlag {
				guard #available(macOS 14.2, *) else {
					emitError(
						code: "system-audio-unsupported",
						message: "Core Audio process taps need macOS 14.2 or later."
					)
					exit(2)
				}
				do {
					try SystemAudioTap.requestAccess()
					emit(["event": "system-audio-access-requested"])
					exit(0)
				} catch {
					emitError(code: "system-audio-request-failed", message: "\(error)")
					exit(1)
				}
			}

			if CommandLine.arguments.count == 2, CommandLine.arguments[1] == pickerSessionFlag {
				guard #available(macOS 15.2, *) else {
					emitError(
						code: "picker-session-unsupported",
						message: "The system picker session needs macOS 15.2 or later."
					)
					exit(2)
				}
				PickerSession().run()
			}

			guard CommandLine.arguments.count == 2 else {
				throw HelperError.invalidArguments
			}

			guard #available(macOS 13.0, *) else {
				throw HelperError.unsupportedMacOS
			}

			let requestData = Data(CommandLine.arguments[1].utf8)
			let decoder = JSONDecoder()
			let request = try decoder.decode(RecordingRequest.self, from: requestData)
			let recorder = ScreenCaptureRecorder(request: request)
			let stopTask = Task.detached {
				while let line = readLine() {
					let command = line.trimmingCharacters(in: .whitespacesAndNewlines)
					switch command {
					case "pause":
						recorder.pause()
					case "resume":
						recorder.resume()
					case "stop":
						await recorder.stop()
						exit(0)
					default:
						break
					}
				}
			}

			// The take starts on a task of its own, and the MAIN thread runs its CFRunLoop from
			// here on (1.2.0): CoreMediaIO delivers a camera's frames, and the audio engine its
			// buffers, through the main run loop, and a command-line tool whose main thread only
			// awaited never ran one -- the camera came up with no frame and the microphone with
			// no buffer. Nothing before this line awaits, so this is still the main thread (a
			// run loop after an `await` would be a pool thread's). The stop command arrives on
			// `stopTask` and exits the process from there.
			Task.detached {
				do {
					try await recorder.start()
				} catch let error as HelperError {
					emitError(code: "helper-error", message: error.description)
					exit(1)
				} catch {
					emitError(code: "helper-error", message: "\(error)")
					exit(1)
				}
			}
			_ = stopTask
			diagnosticLog("main run loop on the main thread: \(Thread.isMainThread)")
			while true {
				CFRunLoopRunInMode(.defaultMode, 3600, false)
			}
		} catch let error as HelperError {
			emitError(code: "helper-error", message: error.description)
			exit(1)
		} catch {
			emitError(code: "helper-error", message: "\(error)")
			exit(1)
		}
	}
}
