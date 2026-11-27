import Foundation

/// Panasonic AW HTTP CGI, in the form Control Center already sends.
///
/// `lib/drivers/ptz.js`: `speedCode` is `50 + clamp(round(speed), -49, 49)` as two digits,
/// pan/tilt is `PTS<pan><tilt>`, zoom is `Z<speed>`, stop is `PTS5050` and `Z50`.
/// The path is `GET /cgi-bin/aw_ptz?cmd=%23<CMD>&res=1` (`_url` in that file).
/// The 40 ms gap between pan/tilt commands is the Interface Specifications minimum; `CommandGate` keeps it.
/// Error bodies match `_checkReply`: `eR1` / `ER1` unsupported, `ER2` busy, `ER3` out of range, and bare `E1`...`E3`.
public struct PtzCommand: Equatable, Sendable {
    public var code: String
    public var path: String

    public init(code: String, path: String) {
        self.code = code
        self.path = path
    }

    /// Queue key. A newer command with the same key replaces one that has not been sent yet.
    public var axisKey: String {
        if code.hasPrefix("Z") { return "z" }
        if code.hasPrefix("F") { return "f" }
        return "pt"
    }

    public var isStop: Bool { code == "PTS5050" || code == "Z50" || code == "F50" }
}

public enum Panasonic {
    public static func speedCode(_ speed: Double) -> String {
        let rounded = speed.isNaN ? 0 : Int(speed.rounded())
        let clamped = min(49, max(-49, rounded))
        let code = 50 + clamped
        return code < 10 ? "0\(code)" : "\(code)"
    }

    public static func panTilt(pan: Double, tilt: Double) -> PtzCommand {
        command("PTS\(speedCode(pan))\(speedCode(tilt))")
    }

    public static func zoom(_ speed: Double) -> PtzCommand {
        command("Z\(speedCode(speed))")
    }

    public static func stopPanTilt() -> PtzCommand { panTilt(pan: 0, tilt: 0) }
    public static func stopZoom() -> PtzCommand { zoom(0) }

    public static func command(_ code: String) -> PtzCommand {
        PtzCommand(code: code, path: "/cgi-bin/aw_ptz?cmd=%23\(percentEncode(code))&res=1")
    }

    /// `encodeURIComponent` for the bytes that show up in these commands. Alphanumeric is left as-is.
    static func percentEncode(_ text: String) -> String {
        var out = ""
        for byte in text.utf8 {
            let plain = (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)
                || byte == 45 || byte == 95 || byte == 46 || byte == 126
            if plain {
                out.append(Character(UnicodeScalar(byte)))
            } else {
                out += String(format: "%%%02X", byte)
            }
        }
        return out
    }

    /// Nil when the body is a normal acknowledgement. The matched text when the camera refused the command.
    public static func errorReply(_ body: String) -> String? {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let pattern = #"^(?:[eE]R[123](?::.*)?|E[123])$"#
        if text.range(of: pattern, options: .regularExpression) != nil { return text }
        return nil
    }
}

/// Sends a speed only when its code changes, and not twice inside the camera's 40 ms pan/tilt gap.
/// A stop skips the gap: the operator, a loss, or quit must not wait behind a move.
public struct CommandGate: Sendable {
    private var lastCode: [String: String] = [:]
    private var lastAt: [String: Double] = [:]
    private var sent: Set<String> = []
    public var gap: Double

    public init(gap: Double = 0.040) { self.gap = gap }

    public mutating func reset() {
        lastCode = [:]
        lastAt = [:]
        sent = []
    }

    public func hasSent(_ key: String) -> Bool { sent.contains(key) }

    public mutating func emit(_ command: PtzCommand, now: Double) -> PtzCommand? {
        let key = command.axisKey
        if lastCode[key] == command.code { return nil }
        if !command.isStop, let at = lastAt[key], now - at < gap { return nil }
        lastCode[key] = command.code
        lastAt[key] = now
        sent.insert(key)
        return command
    }
}

/// One request in flight per camera. A newer speed for the same axis replaces one still waiting.
/// This is the same coalesce `PTZDriver._send` does with its queue key.
public final class PtzCommandQueue: @unchecked Sendable {
    public struct Job: Equatable, Sendable {
        public var command: PtzCommand
        public var key: String

        public init(command: PtzCommand, key: String) {
            self.command = command
            self.key = key
        }
    }

    private var waiting: [Job] = []
    private var busy = false
    private var nextAt: Double = 0
    public let gap: Double

    public init(gap: Double = 0.040) { self.gap = gap }

    /// `front` puts a stop ahead of a speed that has not been sent yet. A newer command with the
    /// same key still replaces the one waiting, which is how a later speed wins.
    public func submit(_ command: PtzCommand, key: String? = nil, front: Bool = false) {
        let job = Job(command: command, key: key ?? command.axisKey)
        if let index = waiting.firstIndex(where: { $0.key == job.key }) {
            if front && index != 0 {
                waiting.remove(at: index)
                waiting.insert(job, at: 0)
            } else {
                waiting[index] = job
            }
            return
        }
        if front {
            waiting.insert(job, at: 0)
        } else {
            waiting.append(job)
        }
    }

    public func take(now: Double) -> Job? {
        if busy || waiting.isEmpty { return nil }
        if now < nextAt {
            // A stop does not wait out the 40 ms gap. The head holds its last speed until it hears one.
            guard let index = waiting.firstIndex(where: { $0.command.isStop }) else { return nil }
            busy = true
            return waiting.remove(at: index)
        }
        busy = true
        return waiting.removeFirst()
    }

    public func finish(now: Double) {
        busy = false
        nextAt = now + gap
    }

    public var depth: Int { waiting.count }
    public var inFlight: Bool { busy }

    /// Test aid: the command still waiting for this key, if any.
    public func pending(_ key: String) -> PtzCommand? {
        waiting.first { $0.key == key }?.command
    }
}

/// One Panasonic CGI conversation: one request at a time, the 40 ms gap, a stop that skips it,
/// an immediate retry when a stop is lost, and a wait-and-try-again when the camera stops answering.
///
/// The menu-bar app drives this. Tests drive it against a fake clock and a mock camera.
public struct CameraLink: Sendable {
    public var timeout: Double
    /// Extra tries after a stop fails, before the link waits and tries again.
    public var stopRetries: Int
    public var backoffs: [Double]

    private var queue: PtzCommandQueue
    private var inFlight = false
    private var current: PtzCommand?
    private var started: Double = 0
    private var stopTries = 0
    private var failures = 0
    private var retryAt: Double = 0
    private var backingOff = false
    /// Set when a move was not confirmed. Speeds are ignored until a command succeeds,
    /// so a later pan cannot replace the stop that is supposed to catch the head.
    private var recovering = false

    public init(gap: Double = 0.040, timeout: Double = 2, stopRetries: Int = 3, backoffs: [Double] = [0.5, 1, 2, 4, 8]) {
        queue = PtzCommandQueue(gap: gap)
        self.timeout = timeout
        self.stopRetries = max(0, stopRetries)
        self.backoffs = backoffs.isEmpty ? [0.5] : backoffs
    }

    public var isInFlight: Bool { inFlight }
    public var depth: Int { queue.depth }
    public var isBackingOff: Bool { backingOff }
    public var isRecovering: Bool { recovering }
    /// Nothing in flight, nothing waiting, and not sitting out a reconnect wait.
    public var isSettled: Bool { !inFlight && queue.depth == 0 && !backingOff }

    public func timedOut(now: Double) -> Bool {
        inFlight && now - started >= timeout
    }

    public mutating func submit(_ command: PtzCommand) {
        if recovering && !command.isStop { return }
        queue.submit(command, front: command.isStop)
    }

    /// The command to GET now. Nil means wait: a request is already out, the gap has not elapsed,
    /// or the link is sitting out a reconnect.
    public mutating func poll(now: Double) -> PtzCommand? {
        if inFlight { return nil }
        if backingOff {
            if now + 1e-9 < retryAt { return nil }
            backingOff = false
        }
        guard let job = queue.take(now: now) else { return nil }
        inFlight = true
        current = job.command
        started = now
        return job.command
    }

    public mutating func succeed(now: Double) {
        guard inFlight else { return }
        inFlight = false
        current = nil
        stopTries = 0
        failures = 0
        recovering = false
        queue.finish(now: now)
    }

    /// Drop the request that is out, without a retry. Used when the app is quitting and will not wait.
    public mutating func cancelInFlight(now: Double) {
        guard inFlight else { return }
        inFlight = false
        current = nil
        queue.finish(now: now)
    }

    /// The request failed, timed out, or the connection dropped.
    /// 0 means send the next command now. A positive number is how long to wait. Nil means nothing is waiting.
    public mutating func fail(now: Double) -> Double? {
        guard inFlight, let command = current else { return nil }
        inFlight = false
        current = nil
        queue.finish(now: now)
        if command.isStop && stopTries < stopRetries {
            stopTries += 1
            queue.submit(command, front: true)
            return 0
        }
        if command.isStop {
            stopTries = 0
            let delay = backoffs[min(failures, backoffs.count - 1)]
            failures += 1
            backingOff = true
            retryAt = now + delay
            recovering = true
            queue.submit(Panasonic.stopPanTilt(), front: true)
            return delay
        }
        // The camera may still be holding the last speed on this axis. Stop that axis before any new move.
        stopTries = 0
        failures += 1
        recovering = true
        switch command.axisKey {
        case "z": queue.submit(Panasonic.stopZoom(), front: true)
        case "f": queue.submit(Panasonic.command("F50"), front: true)
        default: queue.submit(Panasonic.stopPanTilt(), front: true)
        }
        return 0
    }
}
