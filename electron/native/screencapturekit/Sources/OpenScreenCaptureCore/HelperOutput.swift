import Foundation

/// The helper's whole protocol with the app: one JSON object per line on stdout.
///
/// Lives in the core library rather than beside the recorder because `AudioTrackMixer`
/// reports through it too, and the mixer is what `swift test` builds against.
public func emit(_ fields: [String: Any]) {
	if let data = try? JSONSerialization.data(withJSONObject: fields, options: []),
		let line = String(data: data, encoding: .utf8)
	{
		print(line)
		fflush(stdout)
		diagnosticLog(line)
	}
}

/// Dev diagnostics: with OPENSCREEN_HELPER_LOG set to a file path, every line also goes there,
/// so a take that fails before the app logs its output can still be read back.
private let diagnosticLogPath = ProcessInfo.processInfo.environment["OPENSCREEN_HELPER_LOG"]

public func diagnosticLog(_ line: String) {
	guard let diagnosticLogPath, let data = "\(Date().timeIntervalSince1970) \(line)\n".data(using: .utf8) else {
		return
	}
	if let handle = FileHandle(forWritingAtPath: diagnosticLogPath) {
		handle.seekToEndOfFile()
		handle.write(data)
		try? handle.close()
	} else {
		FileManager.default.createFile(atPath: diagnosticLogPath, contents: data)
	}
}

public func emitError(code: String, message: String) {
	emit([
		"event": "error",
		"code": code,
		"message": message,
	])
}
