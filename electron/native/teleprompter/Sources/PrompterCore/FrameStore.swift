import CoreGraphics
import Foundation

public protocol KeyValueStore: AnyObject {
    func data(forKey key: String) -> Data?
    func set(_ data: Data?, forKey key: String)
}

private struct StoredRect: Codable {
    var x: Double, y: Double, w: Double, h: Double
}

/// Remembers the panel frame per position and per display.
public final class FrameStore {
    private let store: KeyValueStore

    public init(store: KeyValueStore) { self.store = store }

    private func key(_ position: PrompterPosition, _ display: String) -> String { "frame.\(position.rawValue).\(display)" }

    public func frame(for position: PrompterPosition, display: String) -> CGRect? {
        guard let data = store.data(forKey: key(position, display)), let r = try? JSONDecoder().decode(StoredRect.self, from: data) else { return nil }
        return CGRect(x: r.x, y: r.y, width: r.w, height: r.h)
    }

    public func save(_ frame: CGRect, for position: PrompterPosition, display: String) {
        let r = StoredRect(x: frame.minX, y: frame.minY, w: frame.width, h: frame.height)
        store.set(try? JSONEncoder().encode(r), forKey: key(position, display))
    }
}
