import Foundation

public struct TickResult: Equatable, Sendable {
    public var phase: TrackingPhase
    public var lockedId: String?
    public var tracks: [Track]
    public var speeds: AxisTriple
    public var quantized: AxisTriple
    public var commands: [PtzCommand]
    public var aim: Aim
    public var predicted: NormBox?

    public init(phase: TrackingPhase, lockedId: String?, tracks: [Track], speeds: AxisTriple, quantized: AxisTriple, commands: [PtzCommand], aim: Aim, predicted: NormBox?) {
        self.phase = phase
        self.lockedId = lockedId
        self.tracks = tracks
        self.speeds = speeds
        self.quantized = quantized
        self.commands = commands
        self.aim = aim
        self.predicted = predicted
    }
}

/// One camera's tracking loop, with no video and no socket. Feed it boxes and it returns speeds and CGI commands.
public final class TrackingSession: @unchecked Sendable {
    public let cameraId: String
    public private(set) var settings: TrackingSettings
    public private(set) var phase: TrackingPhase = .off
    public private(set) var lockedId: String?
    public private(set) var tracks: [Track] = []
    public private(set) var speeds: AxisTriple = .zero
    public private(set) var aim: Aim
    public private(set) var predicted: NormBox?

    private var machine = PhaseMachine()
    private var motion = MotionController()
    private var associator = Associator()
    private var gate = CommandGate()
    private var report = CommandReport(pan: 0, tilt: 0, zoom: 0, panTilt: "PTS5050", zoomCode: nil)

    public init(cameraId: String, settings: TrackingSettings = TrackingSettings()) {
        self.cameraId = cameraId
        let clean = settings.clamped()
        self.settings = clean
        self.aim = Aim(centerX: clean.resolvedFraming.anchorX, top: clean.resolvedFraming.headroom, height: clean.resolvedFraming.subjectHeight)
    }

    public func replaceSettings(_ settings: TrackingSettings) {
        self.settings = settings.clamped()
    }

    public func start(now: Double) -> TickResult {
        machine.start()
        motion.reset()
        publishPhase()
        return finish(commands: stopCommands(now: now), now: now)
    }

    public func stop(now: Double) -> TickResult {
        machine.stop()
        motion.reset()
        associator.reset()
        tracks = []
        publishPhase()
        return finish(commands: stopCommands(now: now), now: now)
    }

    public func lock(targetId: String, now: Double) -> TickResult {
        machine.userLock(targetId)
        publishPhase()
        return advance(now: now)
    }

    public func unlock(now: Double) -> TickResult {
        let wasLocked = phase == .locked
        machine.unlock()
        publishPhase()
        if wasLocked {
            motion.reset()
            return finish(commands: stopCommands(now: now), now: now)
        }
        return advance(now: now)
    }

    /// Hard stop. The stick is in someone's hand; easing out would keep the head moving.
    /// `resumeAfter` is seconds. Nil uses `settings.overrideResumeMs`.
    public func override(now: Double, resumeAfter: Double? = nil) -> TickResult {
        if phase == .off { return finish(commands: [], now: now) }
        machine.override(now: now, resumeAfter: resumeAfter ?? settings.overrideResumeMs / 1000)
        motion.reset()
        publishPhase()
        return finish(commands: stopCommands(now: now), now: now)
    }

    public func resume(now: Double) -> TickResult {
        let visible = machineVisible
        machine.resume(lockedVisible: visible)
        publishPhase()
        return advance(now: now)
    }

    /// `detections == nil` advances timers only (pause expiry, lost hold) and does not count a missed frame.
    public func tick(detections: [Detection]?, now: Double) -> TickResult {
        if let detections {
            let floor = settings.resolvedMinSubject
            let usable = detections.filter {
                $0.kind == settings.detect
                    && $0.confidence >= settings.minConfidence
                    && $0.box.h + 1e-6 >= floor
            }
            tracks = associator.update(usable, time: now)
        }
        let step = machine.advance(tracks: tracks, now: now, settings: settings)
        publishPhase()
        if step.sendStop || phase == .paused || phase == .off {
            if step.sendStop || phase == .paused { motion.reset() }
            speeds = .zero
            return finish(commands: stopCommands(now: now), now: now)
        }
        let output = speedsForCurrentLock(now: now)
        speeds = output.continuous
        return finish(commands: movementCommands(output.quantized, now: now), now: now)
    }

    public func status(fps: Double) -> TrackerMessage {
        TrackerMessage(
            type: "status",
            cameraId: cameraId,
            state: phase.rawValue,
            fps: fps,
            detections: tracks.map(StatusDetection.init),
            lockedTarget: lockedId,
            lastCommand: report,
            aim: aim,
            velocity: speeds.quantized()
        )
    }

    private var machineVisible: Bool {
        guard let id = lockedId else { return false }
        return tracks.contains { $0.id == id && $0.missing == 0 }
    }

    private func publishPhase() {
        phase = machine.phase
        lockedId = machine.lockedId
    }

    private func speedsForCurrentLock(now: Double) -> MotionOutput {
        if phase == .locked, let id = lockedId, let track = tracks.first(where: { $0.id == id && $0.missing == 0 }) {
            let output = motion.update(box: track.box, time: now, settings: settings)
            aim = motion.aim
            predicted = motion.predicted
            return output
        }
        let output = motion.easeToStop(time: now, settings: settings)
        aim = motion.aim
        return output
    }

    private func movementCommands(_ quantized: AxisTriple, now: Double) -> [PtzCommand] {
        var out: [PtzCommand] = []
        let pt = Panasonic.panTilt(pan: quantized.pan, tilt: quantized.tilt)
        if let command = gate.emit(pt, now: now) { out.append(command) }
        if settings.zoomEnabled || gate.hasSent("z") {
            let zoom = Panasonic.zoom(settings.zoomEnabled ? quantized.zoom : 0)
            if let command = gate.emit(zoom, now: now) { out.append(command) }
        }
        remember(out, quantized: quantized)
        return out
    }

    private func stopCommands(now: Double) -> [PtzCommand] {
        var out: [PtzCommand] = []
        if let command = gate.emit(Panasonic.stopPanTilt(), now: now) { out.append(command) }
        if gate.hasSent("z"), let command = gate.emit(Panasonic.stopZoom(), now: now) { out.append(command) }
        remember(out, quantized: .zero)
        speeds = .zero
        return out
    }

    private func remember(_ commands: [PtzCommand], quantized: AxisTriple) {
        guard !commands.isEmpty else { return }
        var panTilt = report.panTilt
        var zoomCode = report.zoomCode
        for command in commands {
            if command.axisKey == "pt" { panTilt = command.code }
            if command.axisKey == "z" { zoomCode = command.code }
        }
        report = CommandReport(
            pan: quantizeSpeed(quantized.pan),
            tilt: quantizeSpeed(quantized.tilt),
            zoom: quantizeSpeed(quantized.zoom),
            panTilt: panTilt,
            zoomCode: zoomCode
        )
    }

    private func finish(commands: [PtzCommand], now: Double) -> TickResult {
        _ = now
        return TickResult(
            phase: phase,
            lockedId: lockedId,
            tracks: tracks,
            speeds: speeds,
            quantized: speeds.quantized(),
            commands: commands,
            aim: aim,
            predicted: predicted
        )
    }

    private func advance(now: Double) -> TickResult {
        tick(detections: nil, now: now)
    }
}
