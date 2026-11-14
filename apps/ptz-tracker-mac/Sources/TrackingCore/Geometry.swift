import Foundation

/// A rectangle in a video frame. Origin is the top-left, x grows right, y grows down, each axis is 0...1.
public struct NormBox: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double

    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }

    public var centerX: Double { x + w * 0.5 }
    public var centerY: Double { y + h * 0.5 }
    public var top: Double { y }
    public var area: Double { max(0, w) * max(0, h) }

    public func iou(_ other: NormBox) -> Double {
        let ix = max(0, min(x + w, other.x + other.w) - max(x, other.x))
        let iy = max(0, min(y + h, other.y + other.h) - max(y, other.y))
        let inter = ix * iy
        let union = area + other.area - inter
        if union <= 1e-9 { return 0 }
        return inter / union
    }

    public func offset(dx: Double, dy: Double) -> NormBox {
        NormBox(x: x + dx, y: y + dy, w: w, h: h)
    }

    /// Keep the box inside the frame so a prediction cannot run away off-screen.
    public func clampedToFrame() -> NormBox {
        let ww = min(1, max(0.01, w))
        let hh = min(1, max(0.01, h))
        let xx = min(1 - ww, max(0, x))
        let yy = min(1 - hh, max(0, y))
        return NormBox(x: xx, y: yy, w: ww, h: hh)
    }
}

public struct AxisTriple: Codable, Equatable, Sendable {
    public var pan: Double
    public var tilt: Double
    public var zoom: Double

    public init(pan: Double = 0, tilt: Double = 0, zoom: Double = 0) {
        self.pan = pan
        self.tilt = tilt
        self.zoom = zoom
    }

    public static let zero = AxisTriple()

    public func quantized() -> AxisTriple {
        AxisTriple(pan: Double(quantizeSpeed(pan)), tilt: Double(quantizeSpeed(tilt)), zoom: Double(quantizeSpeed(zoom)))
    }
}

/// Panasonic speeds are integers −49...+49. Half-values round away from zero.
public func quantizeSpeed(_ value: Double) -> Int {
    let rounded = value.rounded()
    if rounded.isNaN { return 0 }
    return Int(min(49, max(-49, rounded)))
}
