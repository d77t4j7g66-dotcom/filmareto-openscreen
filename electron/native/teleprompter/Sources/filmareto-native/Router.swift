import PrompterCore

protocol MessageHandler: AnyObject {
    /// Returns true when the message was handled.
    func handle(_ msg: Inbound) -> Bool
}

final class Router {
    private let handlers: [MessageHandler]

    init(handlers: [MessageHandler]) { self.handlers = handlers }

    func handle(_ line: String) {
        let msg: Inbound
        do {
            msg = try decodeInbound(line)
        } catch ProtocolError.unknownType(let type) {
            Outbox.error("unknown_type", "Άγνωστο μήνυμα «\(type)»")
            return
        } catch {
            Outbox.error("bad_message", "Μη έγκυρο μήνυμα")
            return
        }
        for handler in handlers where handler.handle(msg) { return }
        Outbox.error("unhandled", "Κανείς δεν χειρίστηκε το μήνυμα")
    }
}
