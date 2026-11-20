import Carbon
import Foundation
import PrompterCore

/// System-wide hotkeys through Carbon (no Accessibility permission needed).
final class Hotkeys: MessageHandler {
    private var refs: [EventHotKeyRef] = []
    private var actions: [UInt32: String] = [:]
    private var handlerInstalled = false

    func handle(_ msg: Inbound) -> Bool {
        guard case let .hotkeysSet(bindings) = msg else { return false }
        register(bindings)
        return true
    }

    fileprivate func fire(id: UInt32) {
        if let action = actions[id] { Outbox.send(["type": "hotkey", "action": action]) }
    }

    private func installHandler() {
        guard !handlerInstalled else { return }
        handlerInstalled = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let event, let userData else { return noErr }
            var hotKey = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKey)
            Unmanaged<Hotkeys>.fromOpaque(userData).takeUnretainedValue().fire(id: hotKey.id)
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
    }

    private func register(_ bindings: [HotkeyBinding]) {
        installHandler()
        for ref in refs { UnregisterEventHotKey(ref) }
        refs = []
        actions = [:]
        var failed: [String] = []
        for (i, binding) in bindings.enumerated() {
            guard let code = KeyCodes.code(for: binding.key) else {
                failed.append(binding.action)
                continue
            }
            let id = UInt32(i + 1)
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(code, KeyCodes.modifiers(binding.modifiers), EventHotKeyID(signature: OSType(0x4649_4C4D), id: id), GetApplicationEventTarget(), 0, &ref)
            if status == noErr, let ref {
                refs.append(ref)
                actions[id] = binding.action
            } else {
                failed.append(binding.action)
            }
        }
        Outbox.send(["type": "hotkeys.result", "failed": failed])
    }
}
