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
