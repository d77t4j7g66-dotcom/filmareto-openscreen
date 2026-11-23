import AVFoundation
import CoreMedia
import CoreVideo
import XCTest

import OpenScreenCaptureCore

/// The broadcast camera file: HEVC Main 10 in a .mov, one frame every 1/30 s from start to stop,
/// whatever the frames the source handed in did (gaps, jitter, doubles).
final class ConstantFrameRateVideoWriterTests: XCTestCase {
	private func temporaryURL() -> URL {
		FileManager.default.temporaryDirectory.appendingPathComponent("cfr-\(UUID().uuidString).mov")
	}

	private func makeFrame(width: Int, height: Int, luma: UInt8) -> CVPixelBuffer {
		var buffer: CVPixelBuffer?
		let attributes: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
		CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attributes as CFDictionary, &buffer)
		let frame = buffer!
		CVPixelBufferLockBaseAddress(frame, [])
		let y = CVPixelBufferGetBaseAddressOfPlane(frame, 0)!
		memset(y, Int32(luma), CVPixelBufferGetBytesPerRowOfPlane(frame, 0) * height)
		let uv = CVPixelBufferGetBaseAddressOfPlane(frame, 1)!
		memset(uv, 128, CVPixelBufferGetBytesPerRowOfPlane(frame, 1) * height / 2)
		CVPixelBufferUnlockBaseAddress(frame, [])
		return frame
	}

	private func finish(_ writer: ConstantFrameRateVideoWriter, at end: CMTime) -> Bool {
		let done = expectation(description: "finished")
		var ok = false
		writer.finish(at: end) { completed in
			ok = completed
			done.fulfill()
		}
		wait(for: [done], timeout: 20)
		return ok
	}

	/// Presentation times of every sample in the file's video track, in order.
	private func sampleTimes(of url: URL) throws -> [CMTime] {
		let asset = AVURLAsset(url: url)
		let track = asset.tracks(withMediaType: .video).first!
		let reader = try AVAssetReader(asset: asset)
		let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
		reader.add(output)
		XCTAssertTrue(reader.startReading())
		var times: [CMTime] = []
		while let sample = output.copyNextSampleBuffer() {
			if CMSampleBufferGetNumSamples(sample) > 0 {
				times.append(CMSampleBufferGetPresentationTimeStamp(sample))
			}
		}
		return times.sorted { CMTimeCompare($0, $1) < 0 }
	}

	func testAnIrregularSourceBecomesAConstantThirtyFramesASecondHEVCMainTen() throws {
		let url = temporaryURL()
		defer { try? FileManager.default.removeItem(at: url) }
		let writer = try ConstantFrameRateVideoWriter(
			url: url, width: 1280, height: 720, fps: 30, codec: .hevcMain10(bitRate: 50_000_000)
		)
		let anchor = CMTime(seconds: 500, preferredTimescale: 600_000)
		func at(_ seconds: Double) -> CMTime {
			CMTimeAdd(anchor, CMTime(seconds: seconds, preferredTimescale: 600_000))
		}
		writer.begin(at: anchor)
		XCTAssertTrue(writer.isWriting, writer.lastError ?? "")

		// On time for half a second, a frame 7 ms late, two frames for one slot, a 0.4 s gap
		// (a camera that stalled), then on time again; the timer ticks through the gap.
		var arrivals: [Double] = (0..<15).map { Double($0) / 30 }
		arrivals += [15.0 / 30 + 0.007, 16.0 / 30, 16.0 / 30 + 0.012]
		arrivals += (29..<45).map { Double($0) / 30 }
		for (index, arrival) in arrivals.enumerated() {
			if index > 0, arrivals[index - 1] < 17.0 / 30, arrival > 28.0 / 30 {
				writer.tick(now: at(22.0 / 30))
				writer.tick(now: at(27.0 / 30))
			}
			writer.append(makeFrame(width: 1280, height: 720, luma: UInt8(16 + index * 4)), at: at(arrival))
			Thread.sleep(forTimeInterval: 0.004)
		}
		XCTAssertTrue(finish(writer, at: at(2.0)), writer.lastError ?? "")

		let times = try sampleTimes(of: url)
		XCTAssertEqual(times.count, 60, "2 s at 30 fps")
		// The file's own clock starts at 0 at the anchor.
		for (index, time) in times.enumerated() {
			XCTAssertEqual(CMTimeGetSeconds(time), Double(index) / 30, accuracy: 1e-6, "slot \(index)")
		}

		let asset = AVURLAsset(url: url)
		let track = asset.tracks(withMediaType: .video).first!
		XCTAssertEqual(track.nominalFrameRate, 30, accuracy: 0.01)
		let format = track.formatDescriptions.first as! CMFormatDescription
		XCTAssertEqual(CMFormatDescriptionGetMediaSubType(format), kCMVideoCodecType_HEVC)
		let bits = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_BitsPerComponent) as? Int
		XCTAssertEqual(bits, 10, "Main 10")
		let dimensions = CMVideoFormatDescriptionGetDimensions(format)
		XCTAssertEqual(dimensions.width, 1280)
		XCTAssertEqual(dimensions.height, 720)
	}

	/// No frame ever arrived (camera denied): the file is not made, and finishing says so.
	func testNoFramesFinishesWithoutAFile() throws {
		let url = temporaryURL()
		defer { try? FileManager.default.removeItem(at: url) }
		let writer = try ConstantFrameRateVideoWriter(url: url, width: 640, height: 360, codec: .h264High(bitRate: 8_000_000))
		XCTAssertFalse(finish(writer, at: CMTime(seconds: 1, preferredTimescale: 600)))
	}
}
