import Foundation
import PrompterCore

final class UserDefaultsStore: KeyValueStore {
    private let defaults = UserDefaults.standard
    func data(forKey key: String) -> Data? { defaults.data(forKey: key) }
    func set(_ data: Data?, forKey key: String) { defaults.set(data, forKey: key) }
}
