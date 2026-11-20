import Darwin
import Foundation

/// Pid of the disclaimed child, read by the signal handlers of the parent.
var disclaimedChildPid: pid_t = 0

/// Re-launches this executable with macOS "responsibility" disclaimed, so microphone and speech
/// permissions are asked for this binary (with its embedded Info.plist) instead of the parent
/// process. The parent only forwards signals and exits with the child's status.
enum Disclaim {
    static func respawnIfNeeded() {
        if getenv("FILMARETO_NATIVE_CHILD") != nil { return }
        typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else { return }
        let setDisclaim = unsafeBitCast(symbol, to: SetDisclaim.self)
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        _ = setDisclaim(&attr, 1)
        setenv("FILMARETO_NATIVE_CHILD", "1", 1)
        let path = Bundle.main.executablePath ?? CommandLine.arguments[0]
        var pid: pid_t = 0
        let rc = posix_spawn(&pid, path, nil, &attr, CommandLine.unsafeArgv, environ)
        posix_spawnattr_destroy(&attr)
        guard rc == 0 else {
            unsetenv("FILMARETO_NATIVE_CHILD")
            return
        }
        disclaimedChildPid = pid
        let forward: @convention(c) (Int32) -> Void = { sig in
            if disclaimedChildPid > 0 { kill(disclaimedChildPid, sig) }
            _exit(0)
        }
        signal(SIGTERM, forward)
        signal(SIGINT, forward)
        signal(SIGHUP, forward)
        var status: Int32 = 0
        while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
        exit((status >> 8) & 0xff)
    }
}
