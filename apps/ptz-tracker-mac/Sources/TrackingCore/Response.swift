import Foundation

/// One axis of the reaction curve. Speeds are Panasonic counts: 0 is stop, 49 is full.
/// Distances (`dead`, `gentle`, `fast`) are fractions of the frame.
public struct AxisTune: Equatable, Sendable {
    public var dead: Double
    public var gentle: Double
    public var fast: Double
    /// Panasonic speed cap while the error is still inside the gentle band.
    public var gentleSpeed: Double
    /// Panasonic speed cap once the error is out in the fast zone. Never above 49.
    public var maxSpeed: Double
    /// How quickly the curve climbs toward the cap. Higher reaches the cap sooner.
    public var gain: Double
    /// After the axis has settled, the error must grow to `dead * hysteresis` before it moves again.
    public var hysteresis: Double

    public init(dead: Double, gentle: Double, fast: Double, gentleSpeed: Double, maxSpeed: Double, gain: Double, hysteresis: Double) {
        self.dead = dead
        self.gentle = gentle
        self.fast = fast
        self.gentleSpeed = gentleSpeed
        self.maxSpeed = maxSpeed
        self.gain = gain
        self.hysteresis = hysteresis
    }
}

public enum ResponseMath {
    /// Signed Panasonic speed, and whether the axis is now latched inside the dead zone.
    /// A zero `gentle` and `fast` is the original single curve: tanh from the dead zone up to `maxSpeed`.
    public static func target(error: Double, tune: AxisTune, holding: Bool) -> (speed: Double, holding: Bool) {
        if error.isNaN || tune.maxSpeed <= 0 { return (0, true) }
        let mag = abs(error)
        let dead = max(0, tune.dead)
        let release = dead * min(3, max(1.05, tune.hysteresis))
        if holding && mag < release { return (0, true) }
        if mag <= dead { return (0, true) }
        let excess = mag - dead
        let cap = zoneCap(excess: excess, tune: tune)
        let gain = min(20, max(0.5, tune.gain))
        let shaped = PtMath.tanh(gain * excess)
        let speed = (error < 0 ? -1 : 1) * min(49, cap) * shaped
        return (speed, false)
    }

    /// Panasonic cap for this much error past the dead zone.
    /// Gentle band uses `gentleSpeed`. Past `gentle + fast` the cap is `maxSpeed`. Between them it ramps.
    public static func zoneCap(excess: Double, tune: AxisTune) -> Double {
        let maxSpeed = min(49, max(1, tune.maxSpeed))
        let gentleSpeed = min(maxSpeed, max(1, tune.gentleSpeed))
        let gentle = max(0, tune.gentle)
        let fast = max(0, tune.fast)
        if gentle <= 0 && fast <= 0 { return maxSpeed }
        if excess <= gentle { return gentleSpeed }
        if fast <= 0 || excess >= gentle + fast { return maxSpeed }
        let t = (excess - gentle) / fast
        return gentleSpeed + (maxSpeed - gentleSpeed) * t
    }

    /// True when a slow creep inside the release band should be ignored.
    /// `drift` is a fraction of the frame per second. 0 turns the check off.
    public static func suppressDrift(error: Double, imageSpeed: Double, dead: Double, hysteresis: Double, drift: Double) -> Bool {
        if drift <= 0 || imageSpeed.isNaN { return false }
        let release = max(0, dead) * min(3, max(1.05, hysteresis))
        return abs(imageSpeed) < drift && abs(error) < release
    }
}

/// One-pole filter on the measured error. `jitter` 0 passes the sample through.
/// `jitter` near 1 keeps almost all of the previous value, so a one-frame spike barely moves the output.
public struct ErrorFilter: Sendable {
    public private(set) var state: Double = 0
    private var primed = false

    public init() {}

    public mutating func reset() {
        state = 0
        primed = false
    }

    public mutating func push(_ sample: Double, jitter: Double) -> Double {
        if sample.isNaN { return state }
        let keep = min(0.95, max(0, jitter))
        if !primed || keep == 0 {
            primed = true
            state = sample
            return state
        }
        state = state * keep + sample * (1 - keep)
        return state
    }
}
