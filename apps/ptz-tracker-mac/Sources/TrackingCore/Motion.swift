import Foundation

/// Estimates image velocity and steps the box forward by the video-to-camera delay.
public struct LatencyPredictor: Sendable {
    public private(set) var vx: Double = 0
    public private(set) var vy: Double = 0
    public private(set) var vh: Double = 0
    private var lastBox: NormBox?
    private var lastTime: Double?
    private let blend = 0.45

    public init() {}

    public mutating func reset() {
        vx = 0
        vy = 0
        vh = 0
        lastBox = nil
        lastTime = nil
    }

    public mutating func push(_ box: NormBox, time: Double) {
        if let prev = lastBox, let previousTime = lastTime {
            let dt = time - previousTime
            if dt > 0.001 && dt < 0.5 {
                vx = vx * (1 - blend) + ((box.centerX - prev.centerX) / dt) * blend
                vy = vy * (1 - blend) + ((box.centerY - prev.centerY) / dt) * blend
                vh = vh * (1 - blend) + ((box.h - prev.h) / dt) * blend
            }
        }
        lastBox = box
        lastTime = time
    }

    public func predict(from box: NormBox, latency: Double) -> NormBox {
        let t = max(0, latency)
        let h = max(0.02, box.h + vh * t)
        let cx = box.centerX + vx * t
        let cy = box.centerY + vy * t
        let w = max(0.02, box.w)
        return NormBox(x: cx - w * 0.5, y: cy - h * 0.5, w: w, h: h).clampedToFrame()
    }
}

/// First-order lag plus an acceleration cap, so a speed cannot jump to its new target in one frame.
public struct Easer: Sendable {
    public private(set) var value: Double = 0

    public init() {}

    public mutating func reset() { value = 0 }

    /// `maxDecel` limits a move toward zero or a reversal. `maxAccel` limits a move that speeds up.
    /// Pass a negative decel to use the same cap for both, which is what older settings do.
    public mutating func step(toward target: Double, dt rawDt: Double, smoothing: Double, maxAccel: Double, maxDecel: Double = -1) -> Double {
        let dt = min(0.25, max(0.001, rawDt))
        let tau = 0.045 + min(1, max(0, smoothing)) * 0.70
        let alpha = 1 - PtMath.exp(-dt / tau)
        var next = value + (target - value) * alpha
        let braking = abs(target) < abs(value) || (value != 0 && target != 0 && (target > 0) != (value > 0))
        let rate = braking && maxDecel >= 0 ? maxDecel : maxAccel
        let cap = max(0, rate) * dt
        if next > value + cap { next = value + cap }
        if next < value - cap { next = value - cap }
        value = next
        return value
    }
}

public struct MotionOutput: Equatable, Sendable {
    public var continuous: AxisTriple
    public var quantized: AxisTriple

    public init(continuous: AxisTriple, quantized: AxisTriple) {
        self.continuous = continuous
        self.quantized = quantized
    }
}

/// Turns the subject's box into pan, tilt and zoom speeds.
///
/// Positive pan is camera-right (the subject is right of the aim point).
/// Positive tilt is camera-up. A subject sitting too low in the frame produces a negative tilt.
/// Positive zoom is tele. Zoom stays at 0 unless `settings.zoomEnabled` is set.
///
/// Entering the dead zone eases to a stop. Operator override and a lost subject do not: the session
/// resets this controller and sends a hard stop so the camera does not coast against a person.
public final class MotionController: @unchecked Sendable {
    private var pan = Easer()
    private var tilt = Easer()
    private var zoom = Easer()
    private var predictor = LatencyPredictor()
    private var lastTime: Double?
    /// Once an axis has settled, it stays still until the error is clearly outside the dead zone again.
    /// Without this, a one-count creep sits on the edge of the zone and never quite stops.
    private var panHold = false
    private var tiltHold = false
    private var zoomHold = false
    private var panFilter = ErrorFilter()
    private var tiltFilter = ErrorFilter()
    private var zoomFilter = ErrorFilter()
    public private(set) var aim = Aim(centerX: 0.5, top: 0.12, height: 0.55)
    public private(set) var predicted: NormBox?

    public init() {}

    public func reset() {
        pan.reset()
        tilt.reset()
        zoom.reset()
        predictor.reset()
        lastTime = nil
        predicted = nil
        panHold = false
        tiltHold = false
        zoomHold = false
        panFilter.reset()
        tiltFilter.reset()
        zoomFilter.reset()
    }

    public var velocityX: Double { predictor.vx }

    public func update(box: NormBox, time: Double, settings: TrackingSettings) -> MotionOutput {
        let dt = delta(to: time)
        predictor.push(box, time: time)
        let ahead = predictor.predict(from: box, latency: settings.latencyMs / 1000)
        predicted = ahead
        let framing = settings.resolvedFraming
        aim = FramingMath.aim(box: ahead, velocityX: predictor.vx, framing: framing)
        let rawX = ahead.centerX - aim.centerX
        let rawY = ahead.top - aim.top
        let rawZ = framing.subjectHeight - ahead.h
        let errorX = panFilter.push(rawX, jitter: settings.resolvedJitter)
        let errorY = tiltFilter.push(rawY, jitter: settings.resolvedJitter)
        let errorZ = zoomFilter.push(rawZ, jitter: settings.resolvedJitter)
        let targetPan = command(error: errorX, imageSpeed: predictor.vx, dead: settings.deadZone.x, gentleSpeed: settings.resolvedGentleSpeed.pan, maxSpeed: settings.maxSpeed.pan, gain: settings.resolvedGain.pan, hold: &panHold, settings: settings)
        let targetTilt = -command(error: errorY, imageSpeed: predictor.vy, dead: settings.deadZone.y, gentleSpeed: settings.resolvedGentleSpeed.tilt, maxSpeed: settings.maxSpeed.tilt, gain: settings.resolvedGain.tilt, hold: &tiltHold, settings: settings)
        let targetZoom = settings.zoomEnabled
            ? command(error: errorZ, imageSpeed: predictor.vh, dead: settings.deadZone.size, gentleSpeed: settings.resolvedGentleSpeed.zoom, maxSpeed: settings.maxSpeed.zoom, gain: settings.resolvedGain.zoom, hold: &zoomHold, settings: settings)
            : 0
        if !settings.zoomEnabled { zoom.reset() }
        return step(pan: targetPan, tilt: targetTilt, zoom: targetZoom, dt: dt, settings: settings)
    }

    /// Target speed is zero. The current speed eases down instead of snapping, which is the stop at the end of a move.
    public func easeToStop(time: Double, settings: TrackingSettings) -> MotionOutput {
        let dt = delta(to: time)
        if !settings.zoomEnabled { zoom.reset() }
        return step(pan: 0, tilt: 0, zoom: 0, dt: dt, settings: settings)
    }

    /// Dead zone, gentle band, fast zone, and drift suppression for one axis.
    private func command(error: Double, imageSpeed: Double, dead: Double, gentleSpeed: Double, maxSpeed: Double, gain: Double, hold: inout Bool, settings: TrackingSettings) -> Double {
        if ResponseMath.suppressDrift(error: error, imageSpeed: imageSpeed, dead: dead, hysteresis: settings.resolvedHysteresis, drift: settings.resolvedDrift) {
            hold = true
            return 0
        }
        let tune = AxisTune(
            dead: dead,
            gentle: settings.resolvedGentle,
            fast: settings.resolvedFast,
            gentleSpeed: gentleSpeed,
            maxSpeed: maxSpeed,
            gain: gain,
            hysteresis: settings.resolvedHysteresis
        )
        let result = ResponseMath.target(error: error, tune: tune, holding: hold)
        hold = result.holding
        return result.speed
    }

    private func delta(to time: Double) -> Double {
        let dt = lastTime.map { time - $0 } ?? (1.0 / 15.0)
        lastTime = time
        return dt
    }

    private func step(pan targetPan: Double, tilt targetTilt: Double, zoom targetZoom: Double, dt: Double, settings: TrackingSettings) -> MotionOutput {
        let smooth = settings.resolvedAxisSmoothing
        let decel = settings.resolvedDecel
        let p = pan.step(toward: targetPan, dt: dt, smoothing: smooth.pan, maxAccel: settings.maxAccel.pan, maxDecel: decel.pan)
        let t = tilt.step(toward: targetTilt, dt: dt, smoothing: smooth.tilt, maxAccel: settings.maxAccel.tilt, maxDecel: decel.tilt)
        let z = zoom.step(toward: targetZoom, dt: dt, smoothing: smooth.zoom, maxAccel: settings.maxAccel.zoom, maxDecel: decel.zoom)
        let continuous = AxisTriple(pan: p, tilt: t, zoom: z)
        return MotionOutput(continuous: continuous, quantized: continuous.quantized())
    }
}
