import Foundation
import PrompterCore

enum Outbox {
    private static let lock = NSLock()

    static func send(_ object: [String: Any]) {
        guard let line = encodeOutbound(object), let data = line.data(using: .utf8) else { return }
        lock.lock()
        FileHandle.standardOutput.write(data)
        lock.unlock()
    }

    static func error(_ code: String, _ message: String) {
        send(["type": "error", "code": code, "message": message])
    }
}

enum StdinReader {
    /// Reads JSON lines on a background thread and hands each to `handler` on the main queue.
    /// When stdin closes (the app went away) the helper exits.
    static func start(_ handler: @escaping (String) -> Void) {
        Thread.detachNewThread {
            while let line = readLine(strippingNewline: true) {
                if line.isEmpty { continue }
                DispatchQueue.main.async { handler(line) }
            }
            DispatchQueue.main.async { exit(0) }
        }
    }
}
