import Foundation

public enum TrackingPhase: String, Codable, Equatable, Sendable {
    case off
    case searching
    case locked
    case lost
    case paused
}

public struct PhaseStep: Equatable, Sendable {
    /// The camera should be stopped now: the subject was lost, the hold expired, or tracking turned off.
    public var sendStop: Bool
    public var changed: Bool

    public init(sendStop: Bool, changed: Bool) {
        self.sendStop = sendStop
        self.changed = changed
    }
}

/// off → searching → locked, and locked → lost while the subject is missing.
/// An operator move parks the machine in `paused` until the resume time, or until `resume` is called.
/// The camera is not driven in any state except `locked`.
public struct PhaseMachine: Sendable {
    public private(set) var phase: TrackingPhase = .off
    public private(set) var lockedId: String?
    public private(set) var lostSince: Double?
    public private(set) var pausedUntil: Double?
    /// How many missed frames (the track still exists) before locked becomes lost.
    public var missLimit: Int = 2

    public init() {}

    public mutating func start() {
        if phase == .off || phase == .paused || phase == .lost {
            phase = .searching
        }
        lostSince = nil
        pausedUntil = nil
    }

    public mutating func stop() {
        phase = .off
        lockedId = nil
        lostSince = nil
        pausedUntil = nil
    }

    public mutating func userLock(_ id: String) {
        lockedId = id
        if phase == .searching || phase == .lost {
            phase = .searching
            lostSince = nil
        }
    }

    public mutating func unlock() {
        lockedId = nil
        if phase == .locked || phase == .lost {
            phase = .searching
            lostSince = nil
        }
    }

    /// Operator pan, tilt, zoom, focus, preset or stop. Ignored while tracking is off, so a stick
    /// moved before Start does not leave the machine paused.
    public mutating func override(now: Double, resumeAfter: Double) {
        if phase == .off { return }
        phase = .paused
        pausedUntil = now + max(0, resumeAfter)
        lostSince = nil
    }

    public mutating func resume(lockedVisible: Bool) {
        if phase == .off { return }
        pausedUntil = nil
        lostSince = nil
        if lockedId != nil && lockedVisible {
            phase = .locked
        } else {
            phase = .searching
        }
    }

    public mutating func advance(tracks: [Track], now: Double, settings: TrackingSettings) -> PhaseStep {
        let before = phase
        var stop = false
        switch phase {
        case .off:
            break
        case .paused:
            if let until = pausedUntil, now + 1e-6 >= until {
                pausedUntil = nil
                if let id = lockedId, visible(id, in: tracks) {
                    phase = .locked
                } else {
                    phase = .searching
                }
            }
        case .searching:
            if let id = lockedId {
                if visible(id, in: tracks) {
                    phase = .locked
                    lostSince = nil
                }
            } else if settings.autoLock {
                let fresh = tracks.filter { $0.missing == 0 && $0.confidence >= settings.minConfidence && $0.kind == settings.detect }
                if fresh.count == 1 {
                    lockedId = fresh[0].id
                    phase = .locked
                    lostSince = nil
                }
            }
        case .locked:
            guard let id = lockedId else {
                phase = .searching
                break
            }
            if let track = tracks.first(where: { $0.id == id }) {
                if track.missing >= missLimit {
                    phase = .lost
                    lostSince = now
                    stop = true
                }
            } else {
                phase = .lost
                lostSince = now
                stop = true
            }
        case .lost:
            if let id = lockedId, visible(id, in: tracks) {
                phase = .locked
                lostSince = nil
            } else if let since = lostSince, (now - since) * 1000 >= settings.lostHoldMs {
                stop = true
                lostSince = nil
                lockedId = nil
                phase = settings.lostAction == .stop ? .off : .searching
            }
        }
        return PhaseStep(sendStop: stop, changed: before != phase)
    }

    private func visible(_ id: String, in tracks: [Track]) -> Bool {
        tracks.contains { $0.id == id && $0.missing == 0 }
    }
}
