import Foundation

public let trackingProtocolVersion = 1

public struct StatusDetection: Codable, Equatable, Sendable {
    public var id: String
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double
    public var confidence: Double
    public var kind: String
    public var missing: Bool

    public init(id: String, x: Double, y: Double, w: Double, h: Double, confidence: Double, kind: String, missing: Bool) {
        self.id = id
        self.x = x
        self.y = y
        self.w = w
        self.h = h
        self.confidence = confidence
        self.kind = kind
        self.missing = missing
    }

    public init(_ track: Track) {
        self.init(
            id: track.id,
            x: track.box.x,
            y: track.box.y,
            w: track.box.w,
            h: track.box.h,
            confidence: track.confidence,
            kind: track.kind.rawValue,
            missing: track.missing > 0
        )
    }
}

public struct CommandReport: Codable, Equatable, Sendable {
    public var pan: Int
    public var tilt: Int
    public var zoom: Int
    public var panTilt: String
    public var zoomCode: String?

    public init(pan: Int, tilt: Int, zoom: Int, panTilt: String, zoomCode: String?) {
        self.pan = pan
        self.tilt = tilt
        self.zoom = zoom
        self.panTilt = panTilt
        self.zoomCode = zoomCode
    }
}

/// One JSON object on the WebSocket. `type` selects the message. Unknown keys are ignored on decode.
/// Nil fields are left out of the encoded object.
public struct TrackerMessage: Codable, Equatable, Sendable {
    public var v: Int
    public var type: String
    public var role: String?
    public var name: String?
    public var proto: Int?
    public var cameraId: String?
    public var settings: TrackingSettings?
    public var targetId: String?
    public var reason: String?
    public var command: String?
    public var state: String?
    public var fps: Double?
    public var detections: [StatusDetection]?
    public var lockedTarget: String?
    public var lastCommand: CommandReport?
    public var aim: Aim?
    public var velocity: AxisTriple?
    public var code: String?
    public var message: String?

    public init(
        v: Int = trackingProtocolVersion,
        type: String,
        role: String? = nil,
        name: String? = nil,
        proto: Int? = nil,
        cameraId: String? = nil,
        settings: TrackingSettings? = nil,
        targetId: String? = nil,
        reason: String? = nil,
        command: String? = nil,
        state: String? = nil,
        fps: Double? = nil,
        detections: [StatusDetection]? = nil,
        lockedTarget: String? = nil,
        lastCommand: CommandReport? = nil,
        aim: Aim? = nil,
        velocity: AxisTriple? = nil,
        code: String? = nil,
        message: String? = nil
    ) {
        self.v = v
        self.type = type
        self.role = role
        self.name = name
        self.proto = proto
        self.cameraId = cameraId
        self.settings = settings
        self.targetId = targetId
        self.reason = reason
        self.command = command
        self.state = state
        self.fps = fps
        self.detections = detections
        self.lockedTarget = lockedTarget
        self.lastCommand = lastCommand
        self.aim = aim
        self.velocity = velocity
        self.code = code
        self.message = message
    }

    enum CodingKeys: String, CodingKey {
        case v, type, role, name
        case proto = "protocol"
        case cameraId, settings, targetId, reason, command, state, fps, detections, lockedTarget, lastCommand, aim, velocity, code, message
    }
}

public enum ProtocolDecodeError: Error, Equatable {
    case unsupportedVersion(Int)
    case unknownType(String)
    case malformed
}

public enum KnownMessage {
    public static let types: Set<String> = [
        "hello", "settings.get", "settings.set", "settings",
        "start", "stop", "lock", "unlock", "resume", "override",
        "status", "error", "ping", "pong",
    ]
}

public enum ProtocolCodec {
    public static func encode(_ message: TrackerMessage) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(message)
    }

    public static func encodeString(_ message: TrackerMessage) throws -> String {
        let data = try encode(message)
        return String(decoding: data, as: UTF8.self)
    }

    public static func decode(_ data: Data) throws -> TrackerMessage {
        let message: TrackerMessage
        do {
            message = try JSONDecoder().decode(TrackerMessage.self, from: data)
        } catch {
            throw ProtocolDecodeError.malformed
        }
        if message.v != trackingProtocolVersion { throw ProtocolDecodeError.unsupportedVersion(message.v) }
        if !KnownMessage.types.contains(message.type) { throw ProtocolDecodeError.unknownType(message.type) }
        return message
    }

    public static func error(code: String, message: String, cameraId: String? = nil) -> TrackerMessage {
        TrackerMessage(type: "error", cameraId: cameraId, code: code, message: message)
    }

    public static func hello(role: String, name: String) -> TrackerMessage {
        TrackerMessage(type: "hello", role: role, name: name, proto: trackingProtocolVersion)
    }
}

public struct HealthCamera: Codable, Equatable, Sendable {
    public var cameraId: String
    public var state: String

    public init(cameraId: String, state: String) {
        self.cameraId = cameraId
        self.state = state
    }
}

public struct HealthReport: Codable, Equatable, Sendable {
    public var ok: Bool
    public var app: String
    public var proto: Int
    public var cameras: [HealthCamera]

    public init(ok: Bool, app: String = "ptz-tracker", proto: Int = trackingProtocolVersion, cameras: [HealthCamera]) {
        self.ok = ok
        self.app = app
        self.proto = proto
        self.cameras = cameras
    }

    enum CodingKeys: String, CodingKey {
        case ok, app
        case proto = "protocol"
        case cameras
    }
}
