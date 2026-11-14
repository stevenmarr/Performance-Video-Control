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

    public func submit(_ command: PtzCommand, key: String? = nil) {
        let job = Job(command: command, key: key ?? command.axisKey)
        if let index = waiting.firstIndex(where: { $0.key == job.key }) {
            waiting[index] = job
            return
        }
        waiting.append(job)
    }

    public func take(now: Double) -> Job? {
        if busy || waiting.isEmpty || now < nextAt { return nil }
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
