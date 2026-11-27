import Foundation

/// A tiny closed loop for tests: the person has a world position, the camera aim integrates the speeds
/// the session commands, and `box()` is what the detector would have seen.
///
/// World y grows downward, same as the frame. Positive pan looks right and increases `camX`.
/// Positive tilt looks up and decreases `camY`. Positive zoom (tele) grows `zoom`.
public struct StagePlant: Sendable {
    public var personX: Double
    public var personY: Double
    public var personH: Double
    public var camX: Double
    public var camY: Double
    public var zoom: Double
    public var maxRate: Double

    public init(personX: Double = 0, personY: Double = 0, personH: Double = 0.55, camX: Double = 0, camY: Double = 0.105, zoom: Double = 1, maxRate: Double = 0.50) {
        self.personX = personX
        self.personY = personY
        self.personH = personH
        self.camX = camX
        self.camY = camY
        self.zoom = zoom
        self.maxRate = maxRate
    }

    public func box() -> NormBox {
        let cx = 0.5 + (personX - camX) * zoom
        let cy = 0.5 + (personY - camY) * zoom
        let h = max(0.02, personH * zoom)
        let w = h * 0.42
        return NormBox(x: cx - w * 0.5, y: cy - h * 0.5, w: w, h: h)
    }

    public func detection(confidence: Double = 0.95, kind: DetectMode = .body) -> Detection {
        Detection(box: box(), confidence: confidence, kind: kind)
    }

    public mutating func integrate(quantized: AxisTriple, dt: Double) {
        camX += (quantized.pan / 49.0) * maxRate * dt
        camY -= (quantized.tilt / 49.0) * maxRate * dt
        if quantized.zoom != 0 {
            let factor = PtMath.exp((quantized.zoom / 49.0) * 0.55 * dt)
            zoom = min(3.5, max(0.35, zoom * factor))
        }
    }
}

/// Drops frames that arrive faster than the analysis rate. The caller keeps the newest and discards the rest.
public struct FrameClock: Sendable {
    public var interval: Double
    private var last: Double?

    public init(fps: Double = 15) {
        interval = 1 / max(1, fps)
    }

    public mutating func shouldTake(now: Double) -> Bool {
        if let last, now - last < interval { return false }
        last = now
        return true
    }
}

/// Full detection every N analysed frames, and whenever the tracker asks for a fresh pass.
public struct DetectCadence: Sendable {
    public var every: Int
    public private(set) var frame = 0
    public var force = false

    public init(every: Int = 8) { self.every = max(1, every) }

    public mutating func wantsFullPass() -> Bool {
        frame += 1
        if force || every <= 1 || (frame - 1) % every == 0 {
            force = false
            return true
        }
        return false
    }

    public mutating func invalidate() { force = true }
}

/// One sample of a person in the world, the way a detector would report them.
/// `t` is seconds. `x` and `y` are world position (y grows down). `h` is height at zoom 1.
/// `present` false is a frame where the person is covered or has walked out.
public struct SubjectFrame: Codable, Equatable, Sendable {
    public var t: Double
    public var x: Double
    public var y: Double
    public var h: Double
    public var present: Bool

    public init(t: Double, x: Double, y: Double, h: Double = 0.55, present: Bool = true) {
        self.t = t
        self.x = x
        self.y = y
        self.h = h
        self.present = present
    }
}

public struct SimEvent: Equatable, Sendable {
    public var time: Double
    public var phase: TrackingPhase
    public var pan: Int
    public var tilt: Int
    public var zoom: Int
    public var codes: [String]
    public var present: Bool
    /// Picture fraction. Positive means the person is to the right of the aim (the head is behind a walk to the right).
    public var errorX: Double
    public var errorY: Double
    public var personX: Double
    public var camX: Double

    public init(time: Double, phase: TrackingPhase, pan: Int, tilt: Int, zoom: Int, codes: [String], present: Bool, errorX: Double, errorY: Double, personX: Double, camX: Double) {
        self.time = time
        self.phase = phase
        self.pan = pan
        self.tilt = tilt
        self.zoom = zoom
        self.codes = codes
        self.present = present
        self.errorX = errorX
        self.errorY = errorY
        self.personX = personX
        self.camX = camX
    }
}

public struct TimedCommand: Equatable, Sendable {
    public var time: Double
    public var code: String

    public init(time: Double, code: String) {
        self.time = time
        self.code = code
    }
}

/// Numbers a rehearsal can be judged by. Distances are fractions of the picture (0.01 is one percent).
public struct TrackingScore: Equatable, Sendable {
    /// Milliseconds from the person leaving the dead zone until the first non-zero pan command.
    public var responseMs: Double?
    /// Average, while they are walking, of how far they sit from the aim. Positive means the head is behind.
    public var meanLag: Double
    /// Furthest the head coasts past the aim after they stop.
    public var overshoot: Double
    /// Pan reversals per second during the walk. A calm follow is near zero.
    public var walkReversalsPerSec: Double
    /// Pan reversals after they have stopped. Zero is a head that settles and stays.
    public var settleReversals: Int
    /// Milliseconds from the person coming back until the phase is locked again.
    public var recoveryMs: Double?
    /// A loss sent PTS5050. The camera holds its last speed until it hears a stop.
    public var stoppedOnLoss: Bool
    public var finalPhase: TrackingPhase
    public var commands: [TimedCommand]

    public init(responseMs: Double?, meanLag: Double, overshoot: Double, walkReversalsPerSec: Double, settleReversals: Int, recoveryMs: Double?, stoppedOnLoss: Bool, finalPhase: TrackingPhase, commands: [TimedCommand]) {
        self.responseMs = responseMs
        self.meanLag = meanLag
        self.overshoot = overshoot
        self.walkReversalsPerSec = walkReversalsPerSec
        self.settleReversals = settleReversals
        self.recoveryMs = recoveryMs
        self.stoppedOnLoss = stoppedOnLoss
        self.finalPhase = finalPhase
        self.commands = commands
    }
}

public struct TrackingRun: Equatable, Sendable {
    public var events: [SimEvent]
    public var score: TrackingScore

    public init(events: [SimEvent], score: TrackingScore) {
        self.events = events
        self.score = score
    }
}

/// Closed-loop rehearsal. The person moves on a script (or a recording of boxes-in-the-world).
/// The camera aim integrates the speeds the session actually commands, and the next box is what the detector would see.
public enum TrackingHarness {
    public static func run(settings: TrackingSettings, frames: [SubjectFrame], plant start: StagePlant = StagePlant()) -> TrackingRun {
        let clean = settings.clamped()
        let session = TrackingSession(cameraId: "ptz:sim", settings: clean)
        var plant = start
        var events: [SimEvent] = []
        var commands: [TimedCommand] = []
        _ = session.start(now: frames.first?.t ?? 0)
        var previous: Double?
        for frame in frames {
            let dt = previous.map { max(0, frame.t - $0) } ?? 0
            previous = frame.t
            plant.personX = frame.x
            plant.personY = frame.y
            plant.personH = frame.h
            let result: TickResult
            if frame.present {
                result = session.tick(detections: [plant.detection()], now: frame.t)
            } else {
                result = session.tick(detections: [], now: frame.t)
            }
            let box = plant.box()
            let errorX = frame.present ? box.centerX - result.aim.centerX : 0
            let errorY = frame.present ? box.top - result.aim.top : 0
            let codes = result.commands.map(\.code)
            for code in codes { commands.append(TimedCommand(time: frame.t, code: code)) }
            events.append(SimEvent(
                time: frame.t,
                phase: result.phase,
                pan: Int(result.quantized.pan),
                tilt: Int(result.quantized.tilt),
                zoom: Int(result.quantized.zoom),
                codes: codes,
                present: frame.present,
                errorX: errorX,
                errorY: errorY,
                personX: frame.x,
                camX: plant.camX
            ))
            if dt > 0 { plant.integrate(quantized: result.quantized, dt: dt) }
        }
        let score = scoreRun(events, commands: commands, dead: clean.deadZone.x)
        return TrackingRun(events: events, score: score)
    }

    /// A walk across the stage, a stop, a short cover, then the same person back.
    /// World speed is about 12% of the picture per second, a purposeful cross rather than a sprint.
    public static func walkScript(fps: Double = 15, walkSpeed: Double = 0.12, cover: Double = 0.8) -> [SubjectFrame] {
        let dt = 1 / max(1, fps)
        var frames: [SubjectFrame] = []
        var t = 0.0
        func push(_ x: Double, present: Bool) {
            frames.append(SubjectFrame(t: t, x: x, y: 0, h: 0.55, present: present))
            t += dt
        }
        let settle = 0.4
        while t < settle { push(0, present: true) }
        let walkFor = 3.0
        let walkEnd = t + walkFor
        while t < walkEnd {
            let x = (t - settle) * walkSpeed
            push(x, present: true)
        }
        let stood = (walkEnd - settle) * walkSpeed
        let holdEnd = t + 2.0
        while t < holdEnd { push(stood, present: true) }
        let gapEnd = t + cover
        while t < gapEnd { push(stood, present: false) }
        let backEnd = t + 1.2
        while t < backEnd { push(stood, present: true) }
        return frames
    }

    /// A person who only shifts their weight. The dead zone should keep the head still.
    public static func swayScript(fps: Double = 15, amount: Double = 0.01, seconds: Double = 3) -> [SubjectFrame] {
        let dt = 1 / max(1, fps)
        var frames: [SubjectFrame] = []
        var t = 0.0
        while t < seconds {
            let phase = (t * 2).truncatingRemainder(dividingBy: 2)
            let triangle = phase < 1 ? phase : 2 - phase
            frames.append(SubjectFrame(t: t, x: (triangle - 0.5) * 2 * amount, y: 0, h: 0.55, present: true))
            t += dt
        }
        return frames
    }

    public static func frames(from data: Data) throws -> [SubjectFrame] {
        try JSONDecoder().decode([SubjectFrame].self, from: data)
    }

    /// Plain-language one-liner for a log. Distances are printed as percent of the picture.
    public static func report(_ run: TrackingRun, name: String) -> String {
        let score = run.score
        let response = score.responseMs.map { String(format: "%.0f ms", $0) } ?? "no move"
        let recovery = score.recoveryMs.map { String(format: "%.0f ms", $0) } ?? "n/a"
        let codes = score.commands.map(\.code)
        let sample = codes.prefix(8).joined(separator: " ")
        let peak = run.events.map { abs($0.pan) }.max() ?? 0
        let gap = run.events.first { !$0.present }?.time
        let heldFrames = run.events.filter { event in
            guard let gap, event.present else { return false }
            return event.time > gap - 0.5 && event.time < gap
        }
        let held = heldFrames.isEmpty ? 0 : heldFrames.reduce(0.0) { $0 + $1.errorX } / Double(heldFrames.count)
        return String(
            format: "%@: response %@, lag %.1f%%, overshoot %.1f%%, held %.1f%%, peak pan %d, walk reversals %.2f/s, settle reversals %d, recovery %@, stop on loss %@, commands %d [%@]",
            name,
            response,
            score.meanLag * 100,
            score.overshoot * 100,
            held * 100,
            peak,
            score.walkReversalsPerSec,
            score.settleReversals,
            recovery,
            score.stoppedOnLoss ? "yes" : "no",
            codes.count,
            sample
        )
    }

    /// CPU cost of the motion math alone, in microseconds per update. This is not the Vision pass.
    public static func motionMicroseconds(iterations: Int = 3000) -> Double {
        let motion = MotionController()
        let settings = FeelLibrary.apply(.medium, to: TrackingSettings())
        let box = NormBox(x: 0.62, y: 0.18, w: 0.2, h: 0.5)
        let n = max(1, iterations)
        var time = 0.0
        let start = Date()
        for _ in 0..<n {
            time += 1.0 / 15.0
            _ = motion.update(box: box, time: time, settings: settings)
        }
        return Date().timeIntervalSince(start) / Double(n) * 1_000_000
    }

    private static func scoreRun(_ events: [SimEvent], commands: [TimedCommand], dead: Double) -> TrackingScore {
        var responseMs: Double?
        if let left = events.firstIndex(where: { $0.present && abs($0.errorX) > dead + 0.005 }) {
            let t0 = events[left].time
            if let moved = events[left...].first(where: { $0.pan != 0 }) {
                responseMs = (moved.time - t0) * 1000
            }
        }
        var velocities: [Double] = []
        for index in events.indices {
            let earlier = index > 0 ? events[index - 1] : events[index]
            let dt = max(1e-3, events[index].time - earlier.time)
            velocities.append((events[index].personX - earlier.personX) / dt)
        }
        let moving = events.indices.filter { events[$0].present && abs(velocities[$0]) > 0.02 && events[$0].phase == .locked }
        let lagSamples = moving.dropFirst(min(6, moving.count))
        let meanLag = lagSamples.isEmpty ? 0 : lagSamples.reduce(0.0) { $0 + events[$1].errorX } / Double(lagSamples.count)
        let direction = velocities.reduce(0.0, +) >= 0 ? 1.0 : -1.0
        let lastMovingTime = moving.last.map { events[$0].time } ?? 0
        let settled = events.filter { $0.present && $0.time > lastMovingTime + 0.25 }
        var overshoot = 0.0
        for event in settled {
            let past = direction > 0 ? max(0, -event.errorX) : max(0, event.errorX)
            if past > overshoot { overshoot = past }
        }
        let walkEvents = events.enumerated().filter { moving.contains($0.offset) }.map(\.element)
        let walkRate = reversalRate(walkEvents)
        let settleReversals = reversalCount(settled)
        var recoveryMs: Double?
        var stoppedOnLoss = false
        if let gap = events.firstIndex(where: { !$0.present }) {
            let back = events[gap...].firstIndex(where: { $0.present })
            if let back {
                let t0 = events[back].time
                if let locked = events[back...].first(where: { $0.phase == .locked }) {
                    recoveryMs = max(0, (locked.time - t0) * 1000)
                }
            }
            let window = events[gap...].prefix { !$0.present || $0.time < (back.map { events[$0].time } ?? 9e9) + 0.3 }
            stoppedOnLoss = window.contains { $0.codes.contains("PTS5050") } || commands.contains { $0.code == "PTS5050" && $0.time >= events[gap].time - 0.05 && $0.time <= (back.map { events[$0].time } ?? 9e9) + 0.3 }
        }
        return TrackingScore(
            responseMs: responseMs,
            meanLag: meanLag,
            overshoot: overshoot,
            walkReversalsPerSec: walkRate,
            settleReversals: settleReversals,
            recoveryMs: recoveryMs,
            stoppedOnLoss: stoppedOnLoss,
            finalPhase: events.last?.phase ?? .off,
            commands: commands
        )
    }

    private static func reversalRate(_ events: [SimEvent]) -> Double {
        let count = reversalCount(events)
        guard let first = events.first?.time, let last = events.last?.time, last > first else { return 0 }
        return Double(count) / (last - first)
    }

    /// A reversal is a non-zero pan that points the other way from the previous non-zero pan.
    private static func reversalCount(_ events: [SimEvent]) -> Int {
        var last = 0
        var count = 0
        for event in events where event.pan != 0 {
            if last != 0 && (event.pan > 0) != (last > 0) { count += 1 }
            last = event.pan
        }
        return count
    }
}
