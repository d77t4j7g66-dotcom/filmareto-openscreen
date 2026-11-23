import AVFoundation
import CoreAudio
import CoreMedia
import Foundation
import OpenScreenCaptureCore

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
	/// Channels of the input node as `AVAudioEngine` reports it (1 for a mono microphone).
	private(set) var inputChannelCount = 2
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

		// Always bound to the device itself, the default one included. Left to the engine, the
		// default input ran through the engine's I/O unit at the OUTPUT device's rate: the Lyra-CAM
		// at 48 kHz came in at the MacBook speakers' 44.1 kHz and was converted back up to 48 --
		// two resamplings on the voice, which is how the microphone sounded "sampled wrong".
		let device: AudioDeviceID? = deviceID.flatMap { Self.audioDevice(forUID: $0) } ?? Self.defaultInputDevice()
		if let device {
			try engine.inputNode.auAudioUnit.setDeviceID(device)
		}
		// 1.2.0: the microphone runs at 48 kHz, "never less" (Kostas), rather than at whatever
		// rate the device was left at (the Lyra-CAM sat at 44.1 kHz and was then moved to 48 by
		// another client mid-take, which stopped the engine: a take with no voice at all).
		if let device {
			let changed = Self.setNominalSampleRate(device, 48_000)
			diagnosticLog("mic device \(device) at 48 kHz: \(changed)")
		}
		try installTap()
	}

	/// The tap takes the hardware's own format (its rate is the device's; a tap at any other
	/// rate raises an exception), and the converter turns it into 48 kHz interleaved stereo.
	private func installTap() throws {
		let inputFormat = engine.inputNode.inputFormat(forBus: 0)
		guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
			throw HelperError.unsupportedFeature("The microphone reports no usable audio format.")
		}
		inputChannelCount = Int(inputFormat.channelCount)
		converter = AVAudioConverter(from: inputFormat, to: outputFormat)
		engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) {
			[weak self] buffer, time in
			self?.handle(buffer, at: time)
		}
	}

	private static func defaultInputDevice() -> AudioDeviceID? {
		var deviceID = AudioDeviceID(0)
		var size = UInt32(MemoryLayout<AudioDeviceID>.size)
		var address = AudioObjectPropertyAddress(
			mSelector: kAudioHardwarePropertyDefaultInputDevice,
			mScope: kAudioObjectPropertyScopeGlobal,
			mElement: kAudioObjectPropertyElementMain
		)
		let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID)
		return status == noErr && deviceID != 0 ? deviceID : nil
	}

	/// Sets the device's nominal rate when it offers it. False when it does not (or already is).
	private static func setNominalSampleRate(_ device: AudioDeviceID, _ rate: Float64) -> Bool {
		var address = AudioObjectPropertyAddress(
			mSelector: kAudioDevicePropertyAvailableNominalSampleRates,
			mScope: kAudioObjectPropertyScopeGlobal,
			mElement: kAudioObjectPropertyElementMain
		)
		var size: UInt32 = 0
		guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr, size > 0 else {
			return false
		}
		var ranges = [AudioValueRange](repeating: AudioValueRange(), count: Int(size) / MemoryLayout<AudioValueRange>.size)
		guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &ranges) == noErr,
			ranges.contains(where: { $0.mMinimum <= rate && rate <= $0.mMaximum })
		else {
			return false
		}
		address.mSelector = kAudioDevicePropertyNominalSampleRate
		var current: Float64 = 0
		var currentSize = UInt32(MemoryLayout<Float64>.size)
		if AudioObjectGetPropertyData(device, &address, 0, nil, &currentSize, &current) == noErr, current == rate {
			return false
		}
		var wanted = rate
		return AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<Float64>.size), &wanted) == noErr
	}

	func start() throws {
		try engine.start()
		diagnosticLog("mic engine running=\(engine.isRunning) input=\(engine.inputNode.inputFormat(forBus: 0))")
		// A USB device that is also the camera (the Lyra-CAM) resets when the camera changes
		// format, and the engine stops on its configuration change. It is started again.
		configurationObserver = NotificationCenter.default.addObserver(
			forName: .AVAudioEngineConfigurationChange,
			object: engine,
			queue: nil
		) { [weak self] _ in
			self?.restartAfterConfigurationChange()
		}
	}

	private var configurationObserver: NSObjectProtocol?
	private var callbacks = 0
	private var stopped = false

	/// A restart does not re-apply the channel count to the WAV: once frames are written its file
	/// format is fixed, and the mixer's stereo feed keeps the first channels either way.
	private func restartAfterConfigurationChange() {
		guard !stopped else { return }
		emit(["event": "warning", "code": "microphone-restarted", "message": "The microphone's configuration changed; restarting it."])
		engine.inputNode.removeTap(onBus: 0)
		do {
			try installTap()
			try engine.start()
			diagnosticLog("mic restarted at \(engine.inputNode.inputFormat(forBus: 0))")
		} catch {
			emit(["event": "warning", "code": "microphone-unavailable", "message": "The microphone could not restart: \(error)"])
		}
	}

	func stop() {
		stopped = true
		if let configurationObserver {
			NotificationCenter.default.removeObserver(configurationObserver)
		}
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
		callbacks += 1
		if callbacks == 1 || callbacks == 200 {
			diagnosticLog("mic buffer #\(callbacks) frames=\(buffer.frameLength) fmt=\(buffer.format) hostValid=\(time.isHostTimeValid)")
		}
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
