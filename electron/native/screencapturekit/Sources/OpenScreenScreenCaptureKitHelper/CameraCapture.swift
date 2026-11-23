import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import OpenScreenCaptureCore

/// The camera of a take, recorded by the helper itself (1.2.0): HEVC Main 10, 50 Mbps, a
/// constant 30 fps on the take's own clock, in a `.mov` beside the screen recording.
///
/// The browser's MediaRecorder gave H.264 Baseline at 16 Mbps with a variable frame rate. Here
/// the camera runs its best 30 fps format (up to the app's camera quality, 4K by default) with
/// its frame duration locked at 1/30 s, and every frame is laid on the `ConstantFrameRateGrid`
/// that starts at the take's first screen frame, so the camera file's t=0 is the screen's.
///
/// macOS shares a camera between processes, so the app's own preview (and the prompter's) keep
/// running while this records.
final class CameraCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
	static let frameRate: Int32 = 30
	static let bitRate = 50_000_000

	let outputURL: URL
	/// Where the take's samples are handled; the writer is touched on this queue only.
	private let sampleQueue: DispatchQueue
	/// Maps a camera time into the take's timeline (pause offset), nil to drop the frame (paused).
	private let retime: (CMTime) -> CMTime?
	private let session = AVCaptureSession()
	private let captureQueue = DispatchQueue(label: "app.openscreen.sck-helper.camera")
	private let hostClock = CMClockGetHostTimeClock()
	private var device: AVCaptureDevice?
	private(set) var deviceName: String?
	private(set) var formatDescription = ""

	// Sample queue only.
	private var writer: ConstantFrameRateVideoWriter?
	private var anchor: CMTime?
	private(set) var setupError: String?
	private(set) var framesReceived = 0
	private var announcedRecording = false
	private var reportedFailure = false

	/// Camera-only takes (talking head): the camera's own first frame starts the take, and the
	/// file carries an AAC track the recorder mixes the microphone into. Called on the sample
	/// queue with that frame's time and the audio input, right after the writer began.
	private let onFirstFrame: ((CMTime, AVAssetWriterInput?) -> Void)?
	private let withAudio: Bool

	init(
		outputURL: URL,
		sampleQueue: DispatchQueue,
		withAudio: Bool = false,
		onFirstFrame: ((CMTime, AVAssetWriterInput?) -> Void)? = nil,
		retime: @escaping (CMTime) -> CMTime?
	) {
		self.outputURL = outputURL
		self.sampleQueue = sampleQueue
		self.withAudio = withAudio
		self.onFirstFrame = onFirstFrame
		self.retime = retime
	}

	/// Opens the camera and starts it. Throws when there is no camera or no permission; the
	/// take then goes on without it.
	func start(deviceID: String?, deviceName requestedName: String?, maxWidth: Int, maxHeight: Int) throws {
		switch AVCaptureDevice.authorizationStatus(for: .video) {
		case .authorized:
			break
		case .notDetermined:
			let semaphore = DispatchSemaphore(value: 0)
			AVCaptureDevice.requestAccess(for: .video) { _ in semaphore.signal() }
			_ = semaphore.wait(timeout: .now() + 30)
			guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
				throw HelperError.permissionDenied("Camera permission is required to record the camera.")
			}
		default:
			throw HelperError.permissionDenied("Camera permission is required to record the camera.")
		}

		let discovery = AVCaptureDevice.DiscoverySession(
			deviceTypes: Self.cameraDeviceTypes,
			mediaType: .video,
			position: .unspecified
		)
		// A suspended camera (the FaceTime camera of a closed MacBook) is listed but sends nothing.
		let devices = discovery.devices.filter { !$0.isSuspended }
		guard let index = chooseCameraDevice(
			devices.map { (id: $0.uniqueID, name: $0.localizedName) },
			requestedID: deviceID,
			requestedName: requestedName
		) else {
			throw HelperError.sourceNotFound("No camera is connected.")
		}
		let device = devices[index]
		self.device = device
		deviceName = device.localizedName

		let input = try AVCaptureDeviceInput(device: device)
		let output = AVCaptureVideoDataOutput()
		output.alwaysDiscardsLateVideoFrames = true
		// 10-bit straight from the camera where it has it, else 8-bit 4:2:0; the encoder takes
		// either as is and writes Main 10.
		let tenBit = kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange
		let pixelFormat = output.availableVideoPixelFormatTypes.contains(tenBit)
			? tenBit : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
		output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: pixelFormat]
		output.setSampleBufferDelegate(self, queue: captureQueue)

		// The format is set with the device locked from before the session is configured until
		// it runs, so the session keeps it instead of applying a preset of its own over it (set
		// inside the configuration, the camera came up sending nothing until a restart).
		try device.lockForConfiguration()
		applyFormat(of: device, maxWidth: maxWidth, maxHeight: maxHeight)
		session.beginConfiguration()
		guard session.canAddInput(input), session.canAddOutput(output) else {
			session.commitConfiguration()
			device.unlockForConfiguration()
			throw HelperError.writerSetupFailed("The camera could not be added to a capture session.")
		}
		session.addInput(input)
		session.addOutput(output)
		session.commitConfiguration()
		diagnosticLog("camera \(device.localizedName) format \(formatDescription) pixel \(pixelFormat)")
		session.startRunning()
		device.unlockForConfiguration()
		diagnosticLog("camera running=\(session.isRunning) inUseElsewhere=\(device.isInUseByAnotherApplication)")
		NotificationCenter.default.addObserver(forName: .AVCaptureSessionRuntimeError, object: session, queue: nil) { note in
			let error = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
			emit(["event": "warning", "code": "webcam-runtime-error", "message": "\(error.map { "\($0)" } ?? "unknown")"])
		}
		NotificationCenter.default.addObserver(forName: .AVCaptureSessionWasInterrupted, object: session, queue: nil) { note in
			diagnosticLog("camera interrupted \(note.userInfo ?? [:])")
		}
		// A camera another client was still letting go of can come up delivering nothing. One
		// restart, if no frame came in 2.5 s, has the session take the device afresh.
		DispatchQueue.global().asyncAfter(deadline: .now() + 2.5) { [weak self] in
			guard let self, self.callbacks == 0, self.session.isRunning else { return }
			emit(["event": "warning", "code": "webcam-restarted", "message": "No camera frame in 2.5 s; restarting the camera."])
			self.session.stopRunning()
			try? self.lockFormat(of: device, maxWidth: maxWidth, maxHeight: maxHeight)
			self.session.startRunning()
			try? self.lockFormat(of: device, maxWidth: maxWidth, maxHeight: maxHeight)
			// Still nothing: let the camera go, so the app's own recorder can take it.
			DispatchQueue.global().asyncAfter(deadline: .now() + 3) { [weak self] in
				guard let self, self.callbacks == 0 else { return }
				self.session.stopRunning()
				emit(["event": "warning", "code": "webcam-unavailable", "message": "The camera sent no frame; it was let go."])
			}
		}
	}

	private static var cameraDeviceTypes: [AVCaptureDevice.DeviceType] {
		if #available(macOS 14.0, *) {
			return [.builtInWideAngleCamera, .external, .continuityCamera, .deskViewCamera]
		}
		return [.builtInWideAngleCamera, .externalUnknown]
	}

	private func lockFormat(of device: AVCaptureDevice, maxWidth: Int, maxHeight: Int) throws {
		try device.lockForConfiguration()
		defer { device.unlockForConfiguration() }
		applyFormat(of: device, maxWidth: maxWidth, maxHeight: maxHeight)
	}

	/// The broadcast format and a frame duration locked at 1/30 s. The device must be locked.
	private func applyFormat(of device: AVCaptureDevice, maxWidth: Int, maxHeight: Int) {
		let formats = device.formats
		let candidates = formats.map { format -> CameraFormatCandidate in
			let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
			let subtype = CMFormatDescriptionGetMediaSubType(format.formatDescription)
			return CameraFormatCandidate(
				width: Int(dimensions.width),
				height: Int(dimensions.height),
				frameRateRanges: format.videoSupportedFrameRateRanges.map { $0.minFrameRate...$0.maxFrameRate },
				isYCbCr420: subtype == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
					|| subtype == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
					|| subtype == kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange
			)
		}
		if let chosen = chooseCameraFormat(
			candidates,
			fps: Double(Self.frameRate),
			maxWidth: maxWidth > 0 ? maxWidth : 3840,
			maxHeight: maxHeight > 0 ? maxHeight : 2160
		) {
			if device.activeFormat != formats[chosen] {
				device.activeFormat = formats[chosen]
			}
			// Locked at 1/30 s, inside the range the format itself states: a camera may state
			// "30 fps" as 1000000/30000030 s, and a duration a hair outside the range raises an
			// Objective-C exception that takes the helper down (seen on the Lyra-CAM).
			let wanted = CMTime(value: 1, timescale: Self.frameRate)
			if let range = formats[chosen].videoSupportedFrameRateRanges.first(where: {
				$0.minFrameRate - 0.01 <= Double(Self.frameRate) && Double(Self.frameRate) <= $0.maxFrameRate + 0.01
			}) {
				let frame = CMTimeMaximum(range.minFrameDuration, CMTimeMinimum(wanted, range.maxFrameDuration))
				device.activeVideoMinFrameDuration = frame
				device.activeVideoMaxFrameDuration = frame
			}
		}
		let dimensions = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
		formatDescription = "\(dimensions.width)x\(dimensions.height)@\(Self.frameRate)"
	}

	/// The take's first screen frame: slot 0 of the camera file. Sample queue.
	func begin(at anchor: CMTime) {
		guard self.anchor == nil else { return }
		self.anchor = anchor
		if let writer {
			writer.begin(at: anchor)
		}
	}

	/// Sample queue: the timer that keeps a stalled camera's slots filled.
	func tick(now: CMTime) {
		writer?.tick(now: now)
	}

	func stopCapture() {
		session.stopRunning()
	}

	/// Sample queue. Fills the tail up to `end` and closes the file; true when a file was made.
	func finish(at end: CMTime, completion: @escaping (Bool) -> Void) {
		guard let writer else {
			completion(false)
			return
		}
		writer.finish(at: end, completion: completion)
	}

	var framesWritten: Int64 { writer?.framesWritten ?? 0 }
	var repeatsWritten: Int64 { writer?.repeatsWritten ?? 0 }
	var writerError: String? { setupError ?? writer?.lastError }

	private var callbacks = 0
	func captureOutput(_ output: AVCaptureOutput, didDrop sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
		callbacks += 1
		if callbacks <= 3 { diagnosticLog("camera dropped a late frame") }
	}

	func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
		callbacks += 1
		guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
		var time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
		// Into the host clock, the clock ScreenCaptureKit and the microphone stamp with.
		if let clock = session.synchronizationClock, CFEqual(clock, hostClock) == false {
			time = CMSyncConvertTime(time, from: clock, to: hostClock)
		}
		sampleQueue.async { [weak self] in
			self?.handle(pixelBuffer, capturedAt: time)
		}
	}

	/// Sample queue.
	private func handle(_ pixelBuffer: CVPixelBuffer, capturedAt captured: CMTime) {
		guard let time = retime(captured) else { return }
		framesReceived += 1
		if writer == nil {
			guard setupError == nil else { return }
			do {
				let writer = try ConstantFrameRateVideoWriter(
					url: outputURL,
					width: CVPixelBufferGetWidth(pixelBuffer),
					height: CVPixelBufferGetHeight(pixelBuffer),
					fps: Self.frameRate,
					codec: .hevcMain10(bitRate: Self.bitRate),
					withAudio: withAudio
				)
				self.writer = writer
				if onFirstFrame != nil {
					// A camera-only take starts at its first camera frame.
					anchor = time
				}
				if let anchor {
					writer.begin(at: anchor)
				}
				if let onFirstFrame, writer.isWriting {
					onFirstFrame(time, writer.audioInput)
				}
			} catch {
				setupError = "\(error)"
				emit([
					"event": "warning",
					"code": "webcam-writer-failed",
					"message": "The camera file could not be created: \(error)",
				])
				return
			}
			if let writer, !writer.isWriting, anchor != nil {
				emit([
					"event": "warning",
					"code": "webcam-writer-failed",
					"message": "The camera file could not start: \(writer.lastError ?? "unknown")",
				])
			}
			diagnosticLog("camera first frame \(CVPixelBufferGetWidth(pixelBuffer))x\(CVPixelBufferGetHeight(pixelBuffer)) fmt=\(CVPixelBufferGetPixelFormatType(pixelBuffer))")
		}
		writer?.append(pixelBuffer, at: time)
		if !announcedRecording, let writer, writer.framesWritten > 0 {
			announcedRecording = true
			emit(["event": "webcam-recording", "width": CVPixelBufferGetWidth(pixelBuffer), "height": CVPixelBufferGetHeight(pixelBuffer)])
		}
	}

	/// Sample queue, on the ticker: a camera file that stopped being written (the writer
	/// failed) is said once, so the take is not silently left without its camera.
	func reportFailureOnce() {
		guard !reportedFailure, let writer, writer.isFailed else { return }
		reportedFailure = true
		emit([
			"event": "warning",
			"code": "webcam-writer-failed",
			"message": "The camera stopped being recorded: \(writer.lastError ?? "writer failed")",
		])
	}
}
