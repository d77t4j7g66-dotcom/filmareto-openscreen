import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// A video file at a constant frame rate from frames that come when they come (1.2.0): the camera
/// as HEVC Main 10 at 50 Mbps, 30 fps, in a `.mov`. Frames go on a `ConstantFrameRateGrid`: an
/// empty slot repeats the frame before it, a second frame for a written slot waits as the frame to
/// repeat. An optional AAC track takes the microphone the mixer emits (camera-only takes).
///
/// Not thread-safe: the caller drives it from one serial queue.
public final class ConstantFrameRateVideoWriter {
	public enum Codec {
		/// HEVC Main 10, the broadcast camera (10-bit 4:2:0).
		case hevcMain10(bitRate: Int)
		case h264High(bitRate: Int)
	}

	public let url: URL
	public private(set) var grid: ConstantFrameRateGrid
	public private(set) var framesWritten: Int64 = 0
	public private(set) var repeatsWritten: Int64 = 0
	public private(set) var lastError: String?

	private let writer: AVAssetWriter
	private let videoInput: AVAssetWriterInput
	private let adaptor: AVAssetWriterInputPixelBufferAdaptor
	public let audioInput: AVAssetWriterInput?
	private var latest: CVPixelBuffer?
	private var started = false

	public init(url: URL, width: Int, height: Int, fps: Int32 = 30, codec: Codec, withAudio: Bool = false) throws {
		self.url = url
		grid = ConstantFrameRateGrid(fps: fps)
		try? FileManager.default.removeItem(at: url)
		writer = try AVAssetWriter(outputURL: url, fileType: .mov)
		// A helper killed mid-take still leaves a readable file (reordering is off, so every
		// fragment is representable; see the screen writer in ScreenCaptureRecorder).
		writer.movieFragmentInterval = CMTime(seconds: 1, preferredTimescale: 600)

		var compression: [String: Any] = [
			AVVideoExpectedSourceFrameRateKey: Int(fps),
			AVVideoMaxKeyFrameIntervalKey: Int(fps),
			AVVideoMaxKeyFrameIntervalDurationKey: 1,
			AVVideoAllowFrameReorderingKey: false,
		]
		let codecType: AVVideoCodecType
		switch codec {
		case let .hevcMain10(bitRate):
			codecType = .hevc
			compression[AVVideoAverageBitRateKey] = bitRate
			compression[AVVideoProfileLevelKey] = kVTProfileLevel_HEVC_Main10_AutoLevel as String
		case let .h264High(bitRate):
			codecType = .h264
			compression[AVVideoAverageBitRateKey] = bitRate
			compression[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel
		}
		let settings: [String: Any] = [
			AVVideoCodecKey: codecType,
			AVVideoWidthKey: width,
			AVVideoHeightKey: height,
			AVVideoCompressionPropertiesKey: compression,
			AVVideoColorPropertiesKey: [
				AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
				AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
				AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
			],
		]
		videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
		videoInput.expectsMediaDataInRealTime = true
		adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: videoInput, sourcePixelBufferAttributes: nil)
		guard writer.canAdd(videoInput) else {
			throw NSError(domain: "ConstantFrameRateVideoWriter", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot add the video input"])
		}
		writer.add(videoInput)

		if withAudio {
			let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
				AVFormatIDKey: kAudioFormatMPEG4AAC,
				AVSampleRateKey: 48_000,
				AVNumberOfChannelsKey: 2,
				AVEncoderBitRateKey: 256_000,
			])
			audio.expectsMediaDataInRealTime = true
			guard writer.canAdd(audio) else {
				throw NSError(domain: "ConstantFrameRateVideoWriter", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot add the audio input"])
			}
			writer.add(audio)
			audioInput = audio
		} else {
			audioInput = nil
		}
	}

	/// Slot 0 of the file: the take's start.
	public func begin(at anchor: CMTime) {
		guard !started else { return }
		guard writer.startWriting() else {
			lastError = writer.error.map { "\($0)" } ?? "startWriting failed"
			return
		}
		writer.startSession(atSourceTime: anchor)
		grid.begin(at: anchor)
		started = true
	}

	public var isWriting: Bool { started && writer.status == .writing }
	public var isFailed: Bool { writer.status == .failed }

	/// A frame from the source at `time` (the take's clock): placed on the grid, empty slots before
	/// it repeating the previous frame. Kept as the frame to repeat whether or not it is written.
	public func append(_ pixelBuffer: CVPixelBuffer, at time: CMTime) {
		defer { latest = pixelBuffer }
		guard isWriting else { return }
		let placed = grid.place(frameAt: time)
		if let repeats = placed.repeats {
			// Before the first frame there is none to repeat: the first one fills the start.
			let fill = latest ?? pixelBuffer
			for slot in repeats where !write(fill, slot: slot, isRepeat: true) {
				return
			}
		}
		if let slot = placed.slot {
			_ = write(pixelBuffer, slot: slot, isRepeat: false)
		}
	}

	/// Called on a timer: repeats the last frame into slots the clock has passed with no new frame
	/// (a still screen, a camera that skipped), `latency` slots behind the clock so a frame still
	/// on its way (a camera delivers 30-100 ms after it captured, more under load) finds its own
	/// slot free. The tail is filled at the stop, so a long latency costs nothing.
	public func tick(now: CMTime, latency: Int64 = 12) {
		guard isWriting, let latest, let due = grid.dueRepeats(upTo: now, latency: latency) else { return }
		for slot in due where !write(latest, slot: slot, isRepeat: true) {
			return
		}
	}

	/// Writes the tail up to `end` (the last slot is the one that starts before `end`) and closes
	/// the file.
	public func finish(at end: CMTime, completion: @escaping (Bool) -> Void) {
		guard started else {
			writer.cancelWriting()
			completion(false)
			return
		}
		if let latest, let due = grid.dueRepeats(upTo: end, latency: 1) {
			for slot in due {
				// The input may be momentarily busy at the end: wait for it, briefly.
				var waited = 0
				while !videoInput.isReadyForMoreMediaData && waited < 200 {
					Thread.sleep(forTimeInterval: 0.005)
					waited += 1
				}
				if !write(latest, slot: slot, isRepeat: true) { break }
			}
		}
		videoInput.markAsFinished()
		audioInput?.markAsFinished()
		writer.endSession(atSourceTime: grid.time(ofSlot: grid.lastWrittenSlot + 1))
		writer.finishWriting { [writer] in
			completion(writer.status == .completed)
		}
	}

	@discardableResult
	private func write(_ pixelBuffer: CVPixelBuffer, slot: Int64, isRepeat: Bool) -> Bool {
		guard videoInput.isReadyForMoreMediaData else { return false }
		guard adaptor.append(pixelBuffer, withPresentationTime: grid.time(ofSlot: slot)) else {
			lastError = writer.error.map { "\($0)" } ?? "append failed"
			return false
		}
		grid.wrote(slot: slot)
		framesWritten += 1
		if isRepeat { repeatsWritten += 1 }
		return true
	}
}

