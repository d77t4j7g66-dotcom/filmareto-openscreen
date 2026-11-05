import AVFoundation
import CoreAudio
import CoreMedia
import Foundation

/// The microphone, read straight from the audio device with an audio engine.
///
/// Neither of the other ways to get a microphone worked on every interface: ScreenCaptureKit's
/// microphone output stalls while nothing plays and the screen is still, and an
/// AVCaptureSession on a USB mixer's channel (the Roland GCS-8) delivers only zeros. The engine
/// reads the same device the way every audio app does, and delivers for as long as it runs.
///
/// Buffers leave as 48 kHz interleaved stereo Float32 stamped on the host clock, the format and
/// the domain the rest of a take is in, so they go through the recorder's pause/retime path
/// unchanged.
final class MicrophoneCapture {
	private let engine = AVAudioEngine()
	private let onSample: (CMSampleBuffer) -> Void
	private var converter: AVAudioConverter?
	/// Loudest input sample seen so far, for diagnostics.
	private(set) var inputPeak: Float = 0
	private let outputFormat = AVAudioFormat(
		commonFormat: .pcmFormatFloat32,
		sampleRate: 48_000,
		channels: 2,
		interleaved: true
	)!

	/// `deviceID` is an `AVCaptureDevice.uniqueID` (the same string as the CoreAudio device UID);
	/// nil takes the system default input.
	init(deviceID: String?, onSample: @escaping (CMSampleBuffer) -> Void) throws {
		self.onSample = onSample

		if let deviceID, let audioDevice = Self.audioDevice(forUID: deviceID) {
			try engine.inputNode.auAudioUnit.setDeviceID(audioDevice)
		}
		let inputFormat = engine.inputNode.outputFormat(forBus: 0)
		guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
			throw HelperError.unsupportedFeature("The microphone reports no usable audio format.")
		}
		converter = AVAudioConverter(from: inputFormat, to: outputFormat)
		engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) {
			[weak self] buffer, time in
			self?.handle(buffer, at: time)
		}
	}

	func start() throws {
		try engine.start()
	}

	func stop() {
		engine.inputNode.removeTap(onBus: 0)
		engine.stop()
	}

	private static func audioDevice(forUID uid: String) -> AudioDeviceID? {
		var deviceID = AudioDeviceID(0)
		var cfUID = uid as CFString
		var address = AudioObjectPropertyAddress(
			mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
			mScope: kAudioObjectPropertyScopeGlobal,
			mElement: kAudioObjectPropertyElementMain
		)
		var size = UInt32(MemoryLayout<AudioDeviceID>.size)
		let status = AudioObjectGetPropertyData(
			AudioObjectID(kAudioObjectSystemObject),
			&address,
			UInt32(MemoryLayout<CFString>.size),
			&cfUID,
			&size,
			&deviceID
		)
		return status == noErr && deviceID != 0 ? deviceID : nil
	}

	/// 48 kHz interleaved stereo Float32. A device already running at 48 kHz is only re-laid-out
	/// (mono sent to both sides, extra channels dropped); another rate goes through a converter.
	private func convertedToOutputFormat(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
		let frames = Int(buffer.frameLength)
		if buffer.format.sampleRate == outputFormat.sampleRate,
			buffer.format.commonFormat == .pcmFormatFloat32,
			let planes = buffer.floatChannelData,
			let result = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: buffer.frameLength),
			let out = result.floatChannelData?[0]
		{
			let channels = Int(buffer.format.channelCount)
			let interleaved = buffer.format.isInterleaved
			for frame in 0..<frames {
				let left = interleaved ? planes[0][frame * channels] : planes[0][frame]
				let right: Float
				if channels < 2 {
					right = left
				} else {
					right = interleaved ? planes[0][frame * channels + 1] : planes[1][frame]
				}
				out[frame * 2] = left
				out[frame * 2 + 1] = right
			}
			result.frameLength = buffer.frameLength
			return result
		}
		guard let converter else {
			return nil
		}
		let capacity = AVAudioFrameCount(
			Double(buffer.frameLength) * outputFormat.sampleRate / buffer.format.sampleRate
		) + 16
		guard let converted = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
			return nil
		}
		var consumed = false
		var error: NSError?
		converter.convert(to: converted, error: &error) { _, status in
			if consumed {
				status.pointee = .noDataNow
				return nil
			}
			consumed = true
			status.pointee = .haveData
			return buffer
		}
		return error == nil && converted.frameLength > 0 ? converted : nil
	}

	private func handle(_ buffer: AVAudioPCMBuffer, at time: AVAudioTime) {
		guard buffer.frameLength > 0 else {
			return
		}
		if let planes = buffer.floatChannelData {
			for channel in 0..<Int(buffer.format.channelCount) {
				for index in 0..<Int(buffer.frameLength) {
					inputPeak = max(inputPeak, abs(planes[channel][index]))
				}
			}
		}
		guard let converted = convertedToOutputFormat(buffer), let channelData = converted.floatChannelData
		else {
			return
		}

		// The first frame of this buffer, on the host clock. `hostTime` is in mach ticks; a
		// buffer without one is placed where it just ended.
		let start: CMTime
		if time.isHostTimeValid {
			start = CMTime(
				seconds: AVAudioTime.seconds(forHostTime: time.hostTime),
				preferredTimescale: 48_000
			)
		} else {
			start = CMTimeSubtract(
				CMClockGetTime(CMClockGetHostTimeClock()),
				CMTime(value: CMTimeValue(converted.frameLength), timescale: 48_000)
			)
		}

		let frames = Int(converted.frameLength)
		let byteCount = frames * 2 * MemoryLayout<Float>.size
		var blockBuffer: CMBlockBuffer?
		guard CMBlockBufferCreateWithMemoryBlock(
			allocator: kCFAllocatorDefault,
			memoryBlock: nil,
			blockLength: byteCount,
			blockAllocator: kCFAllocatorDefault,
			customBlockSource: nil,
			offsetToData: 0,
			dataLength: byteCount,
			flags: kCMBlockBufferAssureMemoryNowFlag,
			blockBufferOut: &blockBuffer
		) == noErr, let blockBuffer,
			CMBlockBufferReplaceDataBytes(
				with: channelData[0],
				blockBuffer: blockBuffer,
				offsetIntoDestination: 0,
				dataLength: byteCount
			) == noErr
		else {
			return
		}

		var description = outputFormat.streamDescription.pointee
		var formatDescription: CMAudioFormatDescription?
		guard CMAudioFormatDescriptionCreate(
			allocator: kCFAllocatorDefault,
			asbd: &description,
			layoutSize: 0,
			layout: nil,
			magicCookieSize: 0,
			magicCookie: nil,
			extensions: nil,
			formatDescriptionOut: &formatDescription
		) == noErr, let formatDescription else {
			return
		}

		var sampleBuffer: CMSampleBuffer?
		guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(
			allocator: kCFAllocatorDefault,
			dataBuffer: blockBuffer,
			formatDescription: formatDescription,
			sampleCount: frames,
			presentationTimeStamp: start,
			packetDescriptions: nil,
			sampleBufferOut: &sampleBuffer
		) == noErr, let sampleBuffer else {
			return
		}
		onSample(sampleBuffer)
	}
}
