import Foundation

/// One of a camera's formats, as far as choosing it goes.
public struct CameraFormatCandidate: Equatable {
	public let width: Int
	public let height: Int
	/// The frame-rate ranges the format supports, in frames a second.
	public let frameRateRanges: [ClosedRange<Double>]
	/// Delivered as 4:2:0 YCbCr, which the encoder takes as is (an MJPEG-only format would be
	/// decoded by the system first; it still works, it is only second choice).
	public let isYCbCr420: Bool

	public init(width: Int, height: Int, frameRateRanges: [ClosedRange<Double>], isYCbCr420: Bool) {
		self.width = width
		self.height = height
		self.frameRateRanges = frameRateRanges
		self.isYCbCr420 = isYCbCr420
	}

	func supports(fps: Double) -> Bool {
		frameRateRanges.contains { $0.lowerBound - 0.01 <= fps && fps <= $0.upperBound + 0.01 }
	}
}

/// The broadcast camera format (1.2.0): the largest one that runs at exactly `fps` and fits in
/// `maxWidth` x `maxHeight` (the app's camera quality, 4K by default), 4:2:0 before anything else
/// of the same size. Nil when no format runs at `fps` at all, and the camera then keeps its own.
public func chooseCameraFormat(
	_ candidates: [CameraFormatCandidate],
	fps: Double,
	maxWidth: Int,
	maxHeight: Int
) -> Int? {
	let fitting = candidates.indices.filter { index in
		let candidate = candidates[index]
		return candidate.supports(fps: fps) && candidate.width <= max(1, maxWidth)
			&& candidate.height <= max(1, maxHeight)
	}
	let pool = fitting.isEmpty
		// Nothing fits under the ceiling (a camera whose smallest 30 fps format is larger):
		// the smallest that runs at the rate.
		? candidates.indices.filter { candidates[$0].supports(fps: fps) }
			.sorted { candidates[$0].width * candidates[$0].height < candidates[$1].width * candidates[$1].height }
			.prefix(1).map { $0 }
		: fitting
	return pool.max { lhs, rhs in
		let a = candidates[lhs]
		let b = candidates[rhs]
		if a.width * a.height != b.width * b.height {
			return a.width * a.height < b.width * b.height
		}
		if a.isYCbCr420 != b.isYCbCr420 {
			return !a.isYCbCr420
		}
		// Same size and kind: keep the first the camera lists.
		return lhs > rhs
	}
}

/// The camera the app asked for: by name first (Chromium's device ids are its own hashes, not
/// AVFoundation's), then by id, then the first camera.
public func chooseCameraDevice(
	_ devices: [(id: String, name: String)],
	requestedID: String?,
	requestedName: String?
) -> Int? {
	guard !devices.isEmpty else { return nil }
	let name = requestedName?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
	if !name.isEmpty {
		if let exact = devices.firstIndex(where: { $0.name.lowercased() == name }) {
			return exact
		}
		// Chromium may add the USB ids, "Elgato Facecam (0fd9:0078)".
		if let partial = devices.firstIndex(where: {
			name.hasPrefix($0.name.lowercased()) || $0.name.lowercased().hasPrefix(name)
		}) {
			return partial
		}
	}
	if let id = requestedID, let byID = devices.firstIndex(where: { $0.id == id }) {
		return byID
	}
	return 0
}
