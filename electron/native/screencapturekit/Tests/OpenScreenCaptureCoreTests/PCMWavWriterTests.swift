import AVFoundation
import CoreMedia
import XCTest

@testable import OpenScreenCaptureCore

/// The microphone master: 48 kHz 24-bit PCM, level for level, and the mixer's own taps feeding it.
final class PCMWavWriterTests: XCTestCase {
	private func temporaryURL() -> URL {
		FileManager.default.temporaryDirectory.appendingPathComponent("wav-\(UUID().uuidString).wav")
	}

	func testTheFileIsFortyEightKilohertzTwentyFourBitAndKeepsTheLevel() throws {
		let url = temporaryURL()
		defer { try? FileManager.default.removeItem(at: url) }
		let writer = try PCMWavWriter(url: url)
		var samples = [Float]()
		for frame in 0..<4_800 {
			let value = Float(0.9 * sin(2 * Double.pi * 1_000 * Double(frame) / 48_000))
			samples.append(value)
			samples.append(-value)
		}
		writer.write(interleaved: samples)
		XCTAssertNil(writer.lastError)
		writer.finish()

		let file = try AVAudioFile(forReading: url)
		let description = file.fileFormat.streamDescription.pointee
		XCTAssertEqual(file.fileFormat.sampleRate, 48_000)
		XCTAssertEqual(description.mBitsPerChannel, 24)
		XCTAssertEqual(description.mFormatFlags & kAudioFormatFlagIsFloat, 0, "integer PCM")
		XCTAssertEqual(file.length, 4_800)

		let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4_800)!
		try file.read(into: buffer)
		let left = buffer.floatChannelData![0]
		let right = buffer.floatChannelData![1]
		var worst: Float = 0
		for frame in 0..<4_800 {
			worst = max(worst, abs(left[frame] - samples[frame * 2]), abs(right[frame] - samples[frame * 2 + 1]))
		}
		XCTAssertLessThan(worst, 1.0 / 4_000_000, "24-bit keeps the level to within a step")
	}

	private func dataChunkSize(of url: URL) throws -> Int {
		let bytes = [UInt8](try Data(contentsOf: url))
		var offset = 12
		while offset + 8 <= bytes.count {
			let size = Int(bytes[offset + 4]) | Int(bytes[offset + 5]) << 8 | Int(bytes[offset + 6]) << 16
				| Int(bytes[offset + 7]) << 24
			if String(decoding: bytes[offset..<offset + 4], as: UTF8.self) == "data" { return size }
			offset += 8 + size + (size & 1)
		}
		return -1
	}

	func testAMonoMicrophoneWritesAOneChannelFileOfThreeBytesPerSample() throws {
		let url = temporaryURL()
		defer { try? FileManager.default.removeItem(at: url) }
		let writer = try PCMWavWriter(url: url, channels: 1)
		let samples = (0..<4_800).map { Float(0.5 * sin(2 * Double.pi * 440 * Double($0) / 48_000)) }
		writer.write(interleaved: samples)
		XCTAssertNil(writer.lastError)
		writer.finish()

		let file = try AVAudioFile(forReading: url)
		XCTAssertEqual(file.fileFormat.channelCount, 1)
		XCTAssertEqual(file.fileFormat.sampleRate, 48_000)
		XCTAssertEqual(file.fileFormat.streamDescription.pointee.mBitsPerChannel, 24)
		XCTAssertEqual(file.length, 4_800)
		XCTAssertEqual(try dataChunkSize(of: url), 4_800 * 3)
		let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4_800)!
		try file.read(into: buffer)
		var worst: Float = 0
		for frame in 0..<4_800 { worst = max(worst, abs(buffer.floatChannelData![0][frame] - samples[frame])) }
		XCTAssertLessThan(worst, 1.0 / 4_000_000, "unity: the level is kept")
	}

	func testAStereoMicrophoneStaysStereo() throws {
		let url = temporaryURL()
		defer { try? FileManager.default.removeItem(at: url) }
		let writer = try PCMWavWriter(url: url, channels: 2)
		writer.write(interleaved: [Float](repeating: 0.25, count: 960 * 2))
		writer.finish()
		let file = try AVAudioFile(forReading: url)
		XCTAssertEqual(file.fileFormat.channelCount, 2)
		XCTAssertEqual(try dataChunkSize(of: url), 960 * 2 * 3)
	}

	/// The recorder opens the file stereo (the mixer's chunks are), then narrows it to the
	/// microphone's channel count before the first chunk: the mixer's left side lands in the file.
	func testAMonoFileFedFromTheMixersStereoChunksTakesTheLeftChannel() throws {
		let url = temporaryURL()
		defer { try? FileManager.default.removeItem(at: url) }
		let writer = try PCMWavWriter(url: url, channels: 2, inputChannels: 2)
		writer.reconfigure(channels: 1)
		XCTAssertEqual(writer.channels, 1)
		var chunk = [Float]()
		for frame in 0..<480 {
			let left = Float(frame) / 1_000
			chunk.append(left)
			chunk.append(-left)
		}
		writer.write(interleaved: chunk)
		XCTAssertEqual(writer.framesWritten, 480)
		writer.finish()
		let file = try AVAudioFile(forReading: url)
		XCTAssertEqual(file.fileFormat.channelCount, 1)
		XCTAssertEqual(try dataChunkSize(of: url), 480 * 3)
		let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 480)!
		try file.read(into: buffer)
		for frame in 0..<480 {
			XCTAssertEqual(buffer.floatChannelData![0][frame], Float(frame) / 1_000, accuracy: 1.0 / 4_000_000)
		}
		// Once audio is written the file keeps its format.
		let again = try PCMWavWriter(url: url, channels: 2, inputChannels: 2)
		again.write(interleaved: chunk)
		again.reconfigure(channels: 1)
		XCTAssertEqual(again.channels, 2)
		again.finish()
	}

	/// A reopen with the new channel count that fails leaves the take with a WAV of the old one:
	/// the error is kept (the recorder reports `mic-wav-unavailable` from it) but the audio is not lost.
	func testAFailedReconfigureReopensWithThePreviousChannelCount() throws {
		struct Refused: Error {}
		let url = temporaryURL()
		defer { try? FileManager.default.removeItem(at: url) }
		let writer = try PCMWavWriter(
			url: url,
			channels: 2,
			inputChannels: 2,
			opener: { url, channels in
				if channels == 1 { throw Refused() }
				return try PCMWavWriter.openFile(url: url, channels: channels)
			}
		)
		writer.reconfigure(channels: 1)
		XCTAssertEqual(writer.channels, 2, "the file stays stereo")
		XCTAssertNotNil(writer.lastError, "the failure is still reported")
		var chunk = [Float]()
		for frame in 0..<480 {
			chunk.append(Float(frame) / 1_000)
			chunk.append(-Float(frame) / 1_000)
		}
		writer.write(interleaved: chunk)
		XCTAssertEqual(writer.framesWritten, 480, "audio is still written")
		writer.finish()
		XCTAssertEqual(try AVAudioFile(forReading: url).fileFormat.channelCount, 2)
		XCTAssertEqual(try dataChunkSize(of: url), 480 * 2 * 3)
	}

	/// A single source is never limited: a peak at 0.95 comes out at 0.95, not eased off. Only a
	/// mix of system audio and the microphone is limited, because two sources can sum past 1.
	func testASingleSourceTrackIsNotLimitedButAMixIs() {
		func peak(limits: Bool?, system: Bool, microphone: Bool) -> Int16 {
			let sink = PeakSink()
			var clock = CMTime.zero
			let mixer = AudioTrackMixer(
				input: sink,
				includesSystemAudio: system,
				includesMicrophone: microphone,
				microphoneGain: 1,
				limitsPeaks: limits,
				clock: { clock }
			)
			mixer.beginTimeline(at: .zero)
			let frames = 4_800
			var data = [Float](repeating: 0.95, count: frames * 2)
			data[0] = 0.95
			mixer.ingest(makeStereo(data, at: .zero), from: microphone ? .microphone : .system)
			clock = CMTime(value: Int64(frames), timescale: 48_000)
			mixer.finish(atSourceTime: clock)
			return sink.peak
		}
		XCTAssertEqual(peak(limits: nil, system: false, microphone: true), Int16((0.95 * 32_767).rounded()))
		XCTAssertLessThan(peak(limits: true, system: false, microphone: true), Int16((0.95 * 32_767).rounded()))
	}

	func testTheMixerHandsEveryChunkToItsTapBeforeQuantizing() {
		let sink = PeakSink()
		var clock = CMTime.zero
		var tapped = 0
		var maxTapped: Float = 0
		let mixer = AudioTrackMixer(
			input: sink,
			includesSystemAudio: false,
			includesMicrophone: true,
			microphoneGain: 1,
			onChunk: { chunk in
				tapped += chunk.count / 2
				maxTapped = max(maxTapped, chunk.map(abs).max() ?? 0)
			},
			clock: { clock }
		)
		mixer.beginTimeline(at: .zero)
		mixer.ingest(makeStereo([Float](repeating: 1.2, count: 960 * 2), at: .zero), from: .microphone)
		clock = CMTime(value: 960, timescale: 48_000)
		mixer.finish(atSourceTime: clock)
		XCTAssertEqual(tapped, 960)
		XCTAssertEqual(maxTapped, 1.2, accuracy: 1e-6, "the tap sees the Float before any clipping")
	}

	private func makeStereo(_ interleaved: [Float], at time: CMTime) -> CMSampleBuffer {
		let frames = interleaved.count / 2
		var asbd = AudioStreamBasicDescription(
			mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
			mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
			mBytesPerPacket: 8, mFramesPerPacket: 1, mBytesPerFrame: 8, mChannelsPerFrame: 2,
			mBitsPerChannel: 32, mReserved: 0
		)
		var format: CMAudioFormatDescription?
		CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
		var block: CMBlockBuffer?
		let bytes = frames * 8
		CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil, customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
		interleaved.withUnsafeBytes { raw in
			_ = CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: bytes)
		}
		var sample: CMSampleBuffer?
		CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!, formatDescription: format!, sampleCount: frames, presentationTimeStamp: time, packetDescriptions: nil, sampleBufferOut: &sample)
		return sample!
	}
}

private final class PeakSink: MixedAudioSink {
	var peak: Int16 = 0
	var isReadyForMoreMediaData: Bool { true }
	@discardableResult
	func append(_ sampleBuffer: CMSampleBuffer) -> Bool {
		guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return true }
		let length = CMBlockBufferGetDataLength(block)
		var data = [Int16](repeating: 0, count: length / 2)
		data.withUnsafeMutableBytes { raw in
			_ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
		}
		peak = max(peak, data.map { $0 == Int16.min ? Int16.max : abs($0) }.max() ?? 0)
		return true
	}
}
