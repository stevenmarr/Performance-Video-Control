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

/// How quickly the head is willing to move. Separate from the shot size (`ShotPreset`).
public enum Feel: String, Codable, Equatable, Sendable {
    /// Wide dead zone, low speeds, heavy filtering. A lecturer who shifts their weight.
    case lecture
    /// The show default. One curve up to a moderate cap.
    case medium
    /// Tight dead zone, high caps, light filtering.
    case sports
    /// The stored numbers, not a built-in table.
    case custom
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
    /// Missing on a settings object from before feel presets. Nil keeps the stored numbers.
    public var feel: Feel?
    /// Speed counts per second when slowing down. Nil uses `maxAccel`.
    public var maxDecel: AxisLimits?
    /// Panasonic cap inside the gentle band. Nil is about 40% of `maxSpeed`.
    public var gentleSpeed: AxisLimits?
    /// How fast the curve climbs, per axis. Nil is 8.
    public var gain: AxisLimits?
    /// Low-pass strength per axis. Nil uses the single `smoothing` value.
    public var axisSmoothing: AxisLimits?
    /// Width of the gentle band past the dead zone, as a fraction of the frame. Nil or 0 is one curve.
    public var gentle: Double?
    /// Width of the ramp from the gentle cap up to full speed. Nil or 0 skips the ramp.
    public var fast: Double?
    /// How far past the dead zone a settled axis must be pushed before it moves again. Nil is 1.85.
    public var hysteresis: Double?
    /// Error filter. 0 is raw. Near 1, a one-frame spike barely moves the output.
    public var jitter: Double?
    /// Fraction of the frame per second that still counts as creep. 0 turns this off.
    public var drift: Double?
    /// Smallest subject height, as a fraction of the frame, that tracking will follow. 0 follows any box.
    public var minSubject: Double?

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
        control: CameraEndpoint? = nil,
        feel: Feel? = nil,
        maxDecel: AxisLimits? = nil,
        gentleSpeed: AxisLimits? = nil,
        gain: AxisLimits? = nil,
        axisSmoothing: AxisLimits? = nil,
        gentle: Double? = nil,
        fast: Double? = nil,
        hysteresis: Double? = nil,
        jitter: Double? = nil,
        drift: Double? = nil,
        minSubject: Double? = nil
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
        self.feel = feel
        self.maxDecel = maxDecel
        self.gentleSpeed = gentleSpeed
        self.gain = gain
        self.axisSmoothing = axisSmoothing
        self.gentle = gentle
        self.fast = fast
        self.hysteresis = hysteresis
        self.jitter = jitter
        self.drift = drift
        self.minSubject = minSubject
    }

    public var resolvedGentle: Double { min(0.5, max(0, gentle ?? 0)) }
    public var resolvedFast: Double { min(0.8, max(0, fast ?? 0)) }
    public var resolvedHysteresis: Double { min(3, max(1.05, hysteresis ?? 1.85)) }
    public var resolvedJitter: Double { min(0.95, max(0, jitter ?? 0)) }
    public var resolvedDrift: Double { min(1, max(0, drift ?? 0)) }
    public var resolvedMinSubject: Double { min(0.8, max(0, minSubject ?? 0)) }
    public var resolvedDecel: AxisLimits { maxDecel ?? maxAccel }
    public var resolvedGain: AxisLimits { gain ?? AxisLimits(pan: 8, tilt: 8, zoom: 8) }
    public var resolvedAxisSmoothing: AxisLimits { axisSmoothing ?? AxisLimits(pan: smoothing, tilt: smoothing, zoom: smoothing) }
    public var resolvedGentleSpeed: AxisLimits {
        gentleSpeed ?? AxisLimits(
            pan: max(1, maxSpeed.pan * 0.4),
            tilt: max(1, maxSpeed.tilt * 0.4),
            zoom: max(1, maxSpeed.zoom * 0.4)
        )
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
        if let decel = s.maxDecel {
            s.maxDecel = AxisLimits(pan: accelLimit(decel.pan), tilt: accelLimit(decel.tilt), zoom: accelLimit(decel.zoom))
        }
        if let gentleSpeed = s.gentleSpeed {
            s.gentleSpeed = AxisLimits(pan: speedLimit(gentleSpeed.pan), tilt: speedLimit(gentleSpeed.tilt), zoom: speedLimit(gentleSpeed.zoom))
        }
        if let gain = s.gain {
            s.gain = AxisLimits(pan: min(20, max(0.5, gain.pan)), tilt: min(20, max(0.5, gain.tilt)), zoom: min(20, max(0.5, gain.zoom)))
        }
        if let axisSmoothing = s.axisSmoothing {
            s.axisSmoothing = AxisLimits(pan: clampUnit(axisSmoothing.pan), tilt: clampUnit(axisSmoothing.tilt), zoom: clampUnit(axisSmoothing.zoom))
        }
        if let gentle = s.gentle { s.gentle = min(0.5, max(0, gentle)) }
        if let fast = s.fast { s.fast = min(0.8, max(0, fast)) }
        if let hysteresis = s.hysteresis { s.hysteresis = min(3, max(1.05, hysteresis)) }
        if let jitter = s.jitter { s.jitter = min(0.95, max(0, jitter)) }
        if let drift = s.drift { s.drift = min(1, max(0, drift)) }
        if let minSubject = s.minSubject { s.minSubject = min(0.8, max(0, minSubject)) }
        if s.preset != .custom {
            s.framing = s.preset.builtIn
        }
        return s
    }
}

/// Built-in reaction tables. The same numbers live in `lib/tracking/settings.js` (`FEELS`).
public enum FeelLibrary {
    public static func apply(_ feel: Feel, to base: TrackingSettings) -> TrackingSettings {
        guard feel != .custom else {
            var custom = base
            custom.feel = .custom
            return custom.clamped()
        }
        var s = base
        s.feel = feel
        switch feel {
        case .lecture:
            s.deadZone = DeadZone(x: 0.08, y: 0.09, size: 0.1)
            s.maxSpeed = AxisLimits(pan: 10, tilt: 8, zoom: 4)
            s.maxAccel = AxisLimits(pan: 28, tilt: 22, zoom: 12)
            s.maxDecel = AxisLimits(pan: 40, tilt: 32, zoom: 16)
            s.gentleSpeed = AxisLimits(pan: 3, tilt: 2, zoom: 2)
            s.gain = AxisLimits(pan: 5, tilt: 5, zoom: 4)
            s.axisSmoothing = AxisLimits(pan: 0.72, tilt: 0.75, zoom: 0.8)
            s.smoothing = 0.72
            s.latencyMs = 240
            s.lostHoldMs = 2000
            s.minConfidence = 0.35
            s.minSubject = 0.1
            s.gentle = 0.08
            s.fast = 0.2
            s.hysteresis = 2.2
            s.jitter = 0.7
            s.drift = 0.06
        case .medium:
            s.deadZone = DeadZone(x: 0.045, y: 0.05, size: 0.06)
            s.maxSpeed = AxisLimits(pan: 18, tilt: 14, zoom: 8)
            s.maxAccel = AxisLimits(pan: 70, tilt: 60, zoom: 30)
            s.maxDecel = AxisLimits(pan: 90, tilt: 80, zoom: 40)
            s.gentleSpeed = AxisLimits(pan: 6, tilt: 5, zoom: 3)
            s.gain = AxisLimits(pan: 8, tilt: 8, zoom: 6)
            s.axisSmoothing = AxisLimits(pan: 0.45, tilt: 0.5, zoom: 0.55)
            s.smoothing = 0.45
            s.latencyMs = 180
            s.lostHoldMs = 1200
            s.minConfidence = 0.4
            s.minSubject = 0.08
            s.gentle = 0.05
            s.fast = 0.12
            s.hysteresis = 1.85
            s.jitter = 0.35
            s.drift = 0.035
        case .sports:
            s.deadZone = DeadZone(x: 0.025, y: 0.03, size: 0.04)
            s.maxSpeed = AxisLimits(pan: 36, tilt: 28, zoom: 16)
            s.maxAccel = AxisLimits(pan: 160, tilt: 130, zoom: 70)
            s.maxDecel = AxisLimits(pan: 200, tilt: 170, zoom: 90)
            s.gentleSpeed = AxisLimits(pan: 12, tilt: 10, zoom: 6)
            s.gain = AxisLimits(pan: 12, tilt: 12, zoom: 10)
            s.axisSmoothing = AxisLimits(pan: 0.18, tilt: 0.22, zoom: 0.3)
            s.smoothing = 0.18
            s.latencyMs = 100
            s.lostHoldMs = 600
            s.minConfidence = 0.5
            s.minSubject = 0.05
            s.gentle = 0.02
            s.fast = 0.06
            s.hysteresis = 1.3
            s.jitter = 0.15
            s.drift = 0.015
        case .custom:
            break
        }
        return s.clamped()
    }
}

private func clampUnit(_ value: Double) -> Double { min(1, max(0, value)) }
private func speedLimit(_ value: Double) -> Double { min(49, max(1, value)) }
private func accelLimit(_ value: Double) -> Double { min(500, max(1, value)) }

public struct Aim: Codable, Equatable, Sendable {
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
