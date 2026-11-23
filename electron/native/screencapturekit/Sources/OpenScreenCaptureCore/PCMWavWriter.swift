import AVFoundation
import Foundation

/// The microphone as a broadcast master (1.2.0): a WAV of 48 kHz, 24-bit integer PCM, written
/// from the mixer's Float chunks at unity gain, with nothing limited or processed. Values past full
/// scale clip at full scale, as in any recorder.
///
/// The file has the microphone's own channel count (1.2.1): a mono input writes a mono WAV, not a
/// stereo one with the voice twice. The mixer's chunks are always stereo (a mono input is sent to
/// both sides), so the writer takes `channels` of each `inputChannels`-wide frame, the first ones.
///
/// Not thread-safe: the recorder calls it from its one serial sample queue.
public final class PCMWavWriter {
	public static let sampleRate = 48_000.0
	public let url: URL
	public private(set) var channels: AVAudioChannelCount
	/// Samples per frame in what `write(interleaved:)` is given.
	private let inputChannels: Int
	/// Released by `finish()`: AVAudioFile writes the WAV header's sizes as it closes.
	private var file: AVAudioFile?
	private var processingFormat: AVAudioFormat
	public private(set) var framesWritten: Int64 = 0
	public private(set) var lastError: Error?

	/// `channels` is the file's; `inputChannels` the width of the frames `write` is given
	/// (the file's own when omitted).
	public convenience init(url: URL, channels: AVAudioChannelCount = 2, inputChannels: Int? = nil) throws {
		try self.init(url: url, channels: channels, inputChannels: inputChannels, opener: PCMWavWriter.openFile)
	}

	/// `opener` makes the file for a channel count: the real one, or a test's that fails on demand.
	init(
		url: URL,
		channels: AVAudioChannelCount,
		inputChannels: Int?,
		opener: @escaping (URL, AVAudioChannelCount) throws -> AVAudioFile
	) throws {
		self.url = url
		self.channels = channels
		self.opener = opener
		self.inputChannels = max(Int(channels), inputChannels ?? Int(channels))
		let file = try opener(url, channels)
		self.file = file
		processingFormat = file.processingFormat
	}

	private let opener: (URL, AVAudioChannelCount) throws -> AVAudioFile

	static func openFile(url: URL, channels: AVAudioChannelCount) throws -> AVAudioFile {
		let settings: [String: Any] = [
			AVFormatIDKey: kAudioFormatLinearPCM,
			AVSampleRateKey: sampleRate,
			AVNumberOfChannelsKey: channels,
			AVLinearPCMBitDepthKey: 24,
			AVLinearPCMIsFloatKey: false,
			AVLinearPCMIsBigEndianKey: false,
			AVLinearPCMIsNonInterleaved: false,
		]
		try? FileManager.default.removeItem(at: url)
		return try AVAudioFile(
			forWriting: url,
			settings: settings,
			commonFormat: .pcmFormatFloat32,
			interleaved: false
		)
	}

	/// Starts the file again with another channel count, once the microphone has said how many it
	/// has. Only before anything is written; after that the file keeps the format it has.
	public func reconfigure(channels newChannels: AVAudioChannelCount) {
		let wanted = min(max(newChannels, 1), AVAudioChannelCount(inputChannels))
		guard framesWritten == 0, wanted != channels, file != nil else { return }
		file = nil
		do {
			let reopened = try opener(url, wanted)
			file = reopened
			processingFormat = reopened.processingFormat
			channels = wanted
		} catch {
			lastError = error
			// The take keeps a WAV with the channel count it had; only if that fails too is there none.
			if let previous = try? opener(url, channels) {
				file = previous
				processingFormat = previous.processingFormat
			}
		}
	}

	/// Appends interleaved Float frames (`inputChannels` samples per frame); the first `channels`
	/// of each are written.
	public func write(interleaved samples: [Float]) {
		let channelCount = Int(channels)
		let frames = samples.count / inputChannels
		guard frames > 0, let file,
			let buffer = AVAudioPCMBuffer(pcmFormat: processingFormat, frameCapacity: AVAudioFrameCount(frames)),
			let planes = buffer.floatChannelData
		else {
			return
		}
		for frame in 0..<frames {
			for channel in 0..<channelCount {
				let value = samples[frame * inputChannels + channel]
				planes[channel][frame] = value.isFinite ? min(1, max(-1, value)) : 0
			}
		}
		buffer.frameLength = AVAudioFrameCount(frames)
		do {
			try file.write(from: buffer)
			framesWritten += Int64(frames)
		} catch {
			lastError = error
		}
	}

	/// Closes the file, which writes its final sizes. Nothing is written after.
	public func finish() {
		file = nil
	}
}
