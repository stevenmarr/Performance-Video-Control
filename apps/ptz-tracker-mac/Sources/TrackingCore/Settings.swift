import Foundation

public enum DetectMode: String, Codable, Equatable, Sendable {
    case face
    case body
}

public enum ShotPreset: String, Codable, Equatable, Sendable {
    case wide
    case medium
    case close
    case custom

    /// Shot size the framing math uses. `custom` falls back to the medium numbers; the stored framing replaces them.
    public var builtIn: Framing {
        switch self {
        case .wide:
            return Framing(subjectHeight: 0.38, headroom: 0.16, anchorX: 0.50, lead: 0.06)
        case .medium, .custom:
            return Framing(subjectHeight: 0.55, headroom: 0.12, anchorX: 0.50, lead: 0.08)
        case .close:
            return Framing(subjectHeight: 0.78, headroom: 0.08, anchorX: 0.50, lead: 0.05)
        }
    }
}

public enum LostAction: String, Codable, Equatable, Sendable {
    /// Drop the lock and look again. One person in frame is taken automatically when auto-lock is on.
    case reacquire
    /// Give up and go idle. The camera has already been stopped.
    case stop
}

public enum VideoInput: String, Codable, Equatable, Sendable {
    /// `http://<camera>/cgi-bin/mjpeg`. Confirm the query on the UE150; it is configurable.
    case mjpeg
    /// Repeated `GET /cgi-bin/camera?resolution=640`, the snapshot this repo already uses.
    case jpeg
}

public struct Framing: Codable, Equatable, Sendable {
    /// Desired subject height as a fraction of the frame.
    public var subjectHeight: Double
    /// Empty frame above the subject, as a fraction of the frame.
    public var headroom: Double
    /// Horizontal anchor before lead room is applied. 0.5 is the centre.
    public var anchorX: Double
    /// Largest shift, as a fraction of the frame, that lead room may apply.
    public var lead: Double

    public init(subjectHeight: Double, headroom: Double, anchorX: Double, lead: Double) {
        self.subjectHeight = subjectHeight
        self.headroom = headroom
        self.anchorX = anchorX
        self.lead = lead
    }
}

public struct DeadZone: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var size: Double

    public init(x: Double, y: Double, size: Double) {
        self.x = x
        self.y = y
        self.size = size
    }
}

public struct AxisLimits: Codable, Equatable, Sendable {
    public var pan: Double
    public var tilt: Double
    public var zoom: Double

    public init(pan: Double, tilt: Double, zoom: Double) {
        self.pan = pan
        self.tilt = tilt
        self.zoom = zoom
    }
}

/// Where the camera is, attached by Control Center when it pushes settings. Not a second source of truth.
public struct CameraEndpoint: Codable, Equatable, Sendable {
    public var host: String
    public var port: Int
    public var user: String
    public var password: String
    public var streamUrl: String

    public init(host: String, port: Int, user: String, password: String, streamUrl: String) {
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.streamUrl = streamUrl
    }
}

public struct TrackingSettings: Codable, Equatable, Sendable {
    public var detect: DetectMode
    public var preset: ShotPreset
    public var framing: Framing
    public var deadZone: DeadZone
    public var maxSpeed: AxisLimits
    public var maxAccel: AxisLimits
    public var smoothing: Double
    public var latencyMs: Double
    public var lostHoldMs: Double
    public var lostAction: LostAction
    public var overrideResumeMs: Double
    public var zoomEnabled: Bool
    public var autoLock: Bool
    public var redetectEvery: Int
    public var minConfidence: Double
    public var source: VideoInput
    public var streamUrl: String
    public var control: CameraEndpoint?

    public init(
        detect: DetectMode = .body,
        preset: ShotPreset = .medium,
        framing: Framing = ShotPreset.medium.builtIn,
        deadZone: DeadZone = DeadZone(x: 0.045, y: 0.05, size: 0.06),
        maxSpeed: AxisLimits = AxisLimits(pan: 18, tilt: 14, zoom: 8),
        maxAccel: AxisLimits = AxisLimits(pan: 70, tilt: 60, zoom: 30),
        smoothing: Double = 0.45,
        latencyMs: Double = 180,
        lostHoldMs: Double = 1200,
        lostAction: LostAction = .reacquire,
        overrideResumeMs: Double = 2000,
        zoomEnabled: Bool = false,
        autoLock: Bool = true,
        redetectEvery: Int = 8,
        minConfidence: Double = 0.4,
        source: VideoInput = .mjpeg,
        streamUrl: String = "",
        control: CameraEndpoint? = nil
    ) {
        self.detect = detect
        self.preset = preset
        self.framing = framing
        self.deadZone = deadZone
        self.maxSpeed = maxSpeed
        self.maxAccel = maxAccel
        self.smoothing = smoothing
        self.latencyMs = latencyMs
        self.lostHoldMs = lostHoldMs
        self.lostAction = lostAction
        self.overrideResumeMs = overrideResumeMs
        self.zoomEnabled = zoomEnabled
        self.autoLock = autoLock
        self.redetectEvery = redetectEvery
        self.minConfidence = minConfidence
        self.source = source
        self.streamUrl = streamUrl
        self.control = control
    }

    /// Preset numbers win until the operator picks Custom. Then the stored framing is used.
    public var resolvedFraming: Framing {
        preset == .custom ? framing : preset.builtIn
    }

    /// Pull every value back into the range the motion math and the camera will accept.
    public func clamped() -> TrackingSettings {
        var s = self
        s.smoothing = clampUnit(s.smoothing)
        s.latencyMs = min(2000, max(0, s.latencyMs))
        s.lostHoldMs = min(10000, max(0, s.lostHoldMs))
        s.overrideResumeMs = min(30000, max(0, s.overrideResumeMs))
        s.minConfidence = clampUnit(s.minConfidence)
        s.redetectEvery = min(60, max(1, s.redetectEvery))
        s.deadZone = DeadZone(
            x: min(0.4, max(0, s.deadZone.x)),
            y: min(0.4, max(0, s.deadZone.y)),
            size: min(0.4, max(0, s.deadZone.size))
        )
        s.framing = Framing(
            subjectHeight: min(0.95, max(0.05, s.framing.subjectHeight)),
            headroom: min(0.45, max(0, s.framing.headroom)),
            anchorX: min(0.9, max(0.1, s.framing.anchorX)),
            lead: min(0.3, max(0, s.framing.lead))
        )
        s.maxSpeed = AxisLimits(
            pan: speedLimit(s.maxSpeed.pan),
            tilt: speedLimit(s.maxSpeed.tilt),
            zoom: speedLimit(s.maxSpeed.zoom)
        )
        s.maxAccel = AxisLimits(
            pan: accelLimit(s.maxAccel.pan),
            tilt: accelLimit(s.maxAccel.tilt),
            zoom: accelLimit(s.maxAccel.zoom)
        )
        if s.preset != .custom {
            s.framing = s.preset.builtIn
        }
        return s
    }
}

private func clampUnit(_ value: Double) -> Double { min(1, max(0, value)) }
private func speedLimit(_ value: Double) -> Double { min(49, max(1, value)) }
private func accelLimit(_ value: Double) -> Double { min(500, max(1, value)) }

public struct Aim: Equatable, Sendable {
    public var centerX: Double
    public var top: Double
    public var height: Double

    public init(centerX: Double, top: Double, height: Double) {
        self.centerX = centerX
        self.top = top
        self.height = height
    }
}

public enum FramingMath {
    /// Lead room sits the subject back from the direction they are moving, capped by `framing.lead`.
    /// `velocityX` is in frame-widths per second, positive to the right.
    public static func aim(box: NormBox, velocityX: Double, framing: Framing) -> Aim {
        let shift = min(framing.lead, max(-framing.lead, velocityX * 0.35))
        return Aim(centerX: framing.anchorX - shift, top: framing.headroom, height: framing.subjectHeight)
    }

    /// 0 inside the dead zone. Just outside it the speed starts at 0 and bends up toward `maxSpeed`.
    public static func response(error: Double, dead: Double, maxSpeed: Double, gain: Double = 8) -> Double {
        let mag = abs(error)
        if mag <= dead || maxSpeed <= 0 || mag.isNaN { return 0 }
        let shaped = PtMath.tanh(gain * (mag - dead))
        return (error < 0 ? -1 : 1) * maxSpeed * shaped
    }
}
