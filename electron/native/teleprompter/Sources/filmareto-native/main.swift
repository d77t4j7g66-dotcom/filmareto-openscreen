import AppKit
import PrompterCore

// A question and an answer, with no window and nothing kept running.
if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--eyes" {
    printEyes(imagePath: CommandLine.arguments[2])
    exit(0)
}

if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--eyes-batch" {
    printEyesBatch(directory: CommandLine.arguments[2])
    exit(0)
}

Disclaim.respawnIfNeeded()

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let router = Router(handlers: [AudioDevicesHandler(), SpeechEngine(), PrompterWindowController(), CameraPreviewController(), Hotkeys()])
StdinReader.start { line in router.handle(line) }
Outbox.send(["type": "ready", "version": "0.1.0"])
app.run()
