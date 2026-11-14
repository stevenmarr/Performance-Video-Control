import XCTest
@testable import TrackingCore

/// Closed-loop paths. The plant moves the camera by the speeds the session actually commands,
/// then the next box is what that camera would be looking at.
final class PathTests: XCTestCase {
    func testAWalkIsBoundedSmoothAndSettles() {
        let session = makeSession()
        var plant = StagePlant()
        let dt = 1.0 / 15.0
        var time = 0.0
        var pans: [Int] = []
        var commands: [String] = []
        _ = session.start(now: 0)
        for step in 0..<90 {
            time += dt
            let walking = step < 60
            if walking { plant.personX = Double(step) * dt * 0.08 }
            let result = session.tick(detections: [plant.detection()], now: time)
            plant.integrate(quantized: result.quantized, dt: dt)
            XCTAssertLessThanOrEqual(abs(result.quantized.pan), session.settings.maxSpeed.pan)
            XCTAssertLessThanOrEqual(abs(result.quantized.tilt), session.settings.maxSpeed.tilt)
            XCTAssertEqual(result.quantized.zoom, 0, "zoom is off for a pan/tilt follow")
            if step > 0 {
                let previous = pans.last ?? 0
                // maxAccel 70 / 15 fps is 4.7, plus one count for rounding onto the integer speed.
                XCTAssertLessThanOrEqual(abs(Int(result.quantized.pan) - previous), 6)
            }
            pans.append(Int(result.quantized.pan))
            for command in result.commands where command.axisKey == "pt" {
                commands.append(command.code)
            }
            if step == 30 {
                XCTAssertEqual(result.phase, .locked)
                XCTAssertGreaterThan(result.quantized.pan, 0, "the person is walking right, so the head pans right")
            }
        }
        for pair in zip(commands, commands.dropFirst()) {
            XCTAssertNotEqual(pair.0, pair.1, "an unchanged speed is not sent again")
        }
        XCTAssertEqual(commands.last, "PTS5050")
        XCTAssertGreaterThan(commands.count, 3)
        XCTAssertNotEqual(commands.dropLast().last, "PTS5050", "the stop is the end of a move, not the only command")
        XCTAssertEqual(session.phase, .locked)
        let box = plant.box()
        XCTAssertGreaterThan(box.centerX, 0.25)
        XCTAssertLessThan(box.centerX, 0.75, "the walk stays in frame")
        XCTAssertEqual(pans.suffix(2).filter { $0 != 0 }, [], "once they stop, the head eases to still")
    }

    func testSmallSwayDoesNotMoveTheCamera() {
        let session = makeSession()
        var plant = StagePlant()
        let dt = 1.0 / 15.0
        var time = 0.0
        _ = session.start(now: 0)
        for _ in 0..<15 {
            time += dt
            let result = session.tick(detections: [plant.detection()], now: time)
            plant.integrate(quantized: result.quantized, dt: dt)
        }
        let origin = plant.camX
        var moved = false
        for step in 0..<40 {
            time += dt
            let phase = Double(step % 20) / 10
            let triangle = phase < 1 ? phase : 2 - phase
            plant.personX = (triangle - 0.5) * 0.02
            let result = session.tick(detections: [plant.detection()], now: time)
            plant.integrate(quantized: result.quantized, dt: dt)
            if result.quantized.pan != 0 || result.quantized.tilt != 0 { moved = true }
        }
        XCTAssertFalse(moved, "a sway inside the dead zone is not a cue to chase")
        XCTAssertEqual(plant.camX, origin, accuracy: 1e-9)
    }

    func testOcclusionHoldsThenPicksTheSamePersonUp() {
        let session = makeSession()
        var time = 0.0
        let dt = 1.0 / 15.0
        _ = session.start(now: 0)
        var locked = ""
        let parked = NormBox(x: 0.72, y: 0.12, w: 0.2, h: 0.55)
        for _ in 0..<18 {
            time += dt
            let result = session.tick(detections: [Detection(box: parked, confidence: 0.95, kind: .body)], now: time)
            locked = result.lockedId ?? locked
        }
        XCTAssertEqual(session.phase, .locked)
        XCTAssertGreaterThan(session.speeds.pan, 2, "precondition: the head is following, so a loss has something to cancel")
        var sawStop = false
        for _ in 0..<8 {
            time += dt
            let result = session.tick(detections: [], now: time)
            if result.commands.contains(where: { $0.code == "PTS5050" }) { sawStop = true }
        }
        XCTAssertEqual(session.phase, .lost)
        XCTAssertTrue(sawStop, "a loss stops the head; it does not keep the last speed")
        var returned: TickResult?
        for _ in 0..<4 {
            time += dt
            returned = session.tick(detections: [Detection(box: parked, confidence: 0.95, kind: .body)], now: time)
        }
        XCTAssertEqual(session.phase, .locked)
        XCTAssertEqual(returned?.lockedId, locked)
    }

    func testOverrideStopsImmediatelyAndHoldsTheCamera() {
        let session = makeSession()
        var plant = StagePlant()
        let dt = 1.0 / 15.0
        var time = 0.0
        _ = session.start(now: 0)
        for step in 0..<25 {
            time += dt
            plant.personX = Double(step) * dt * 0.10
            let result = session.tick(detections: [plant.detection()], now: time)
            plant.integrate(quantized: result.quantized, dt: dt)
        }
        XCTAssertGreaterThan(session.speeds.pan, 2, "precondition: the head is moving")
        time += dt
        let stopped = session.override(now: time)
        XCTAssertEqual(session.phase, .paused)
        XCTAssertTrue(stopped.commands.contains { $0.code == "PTS5050" })
        XCTAssertEqual(stopped.quantized.pan, 0, "override does not coast")
        let held = plant.camX
        for step in 0..<20 {
            time += dt
            plant.personX += 0.01
            let result = session.tick(detections: [plant.detection()], now: time)
            plant.integrate(quantized: result.quantized, dt: dt)
            XCTAssertEqual(result.phase, .paused)
            XCTAssertEqual(result.quantized.pan, 0)
            XCTAssertEqual(result.quantized.tilt, 0)
            _ = step
        }
        XCTAssertEqual(plant.camX, held, accuracy: 1e-9, "while paused the head does not fight the operator")
        let resumed = session.resume(now: time)
        XCTAssertEqual(resumed.phase, .locked)
    }

    func testLostHoldExpiryStopsChasing() {
        var settings = TrackingSettings()
        settings.lostHoldMs = 400
        settings.lostAction = .stop
        let session = TrackingSession(cameraId: "ptz:cam1", settings: settings)
        var time = 0.0
        _ = session.start(now: 0)
        time += 1.0 / 15.0
        _ = session.tick(detections: [Detection(box: NormBox(x: 0.4, y: 0.12, w: 0.2, h: 0.55), confidence: 0.9, kind: .body)], now: time)
        XCTAssertEqual(session.phase, .locked)
        for _ in 0..<12 {
            time += 1.0 / 15.0
            _ = session.tick(detections: [], now: time)
        }
        XCTAssertEqual(session.phase, .off)
        let after = session.tick(detections: [Detection(box: NormBox(x: 0.7, y: 0.12, w: 0.2, h: 0.55), confidence: 0.9, kind: .body)], now: time + 0.1)
        XCTAssertEqual(after.phase, .off)
        XCTAssertEqual(after.quantized, .zero)
    }

    func testZoomOnASmallSubjectGrowsTheShotWithoutExceedingTheCap() {
        var settings = TrackingSettings()
        settings.zoomEnabled = true
        settings.latencyMs = 0
        let session = TrackingSession(cameraId: "ptz:cam1", settings: settings)
        var plant = StagePlant(personH: 0.32)
        let dt = 1.0 / 15.0
        var time = 0.0
        var tele = false
        _ = session.start(now: 0)
        let startHeight = plant.box().h
        for _ in 0..<120 {
            time += dt
            let result = session.tick(detections: [plant.detection()], now: time)
            XCTAssertLessThanOrEqual(abs(result.quantized.zoom), settings.maxSpeed.zoom)
            if result.quantized.zoom > 0 { tele = true }
            plant.integrate(quantized: result.quantized, dt: dt)
        }
        XCTAssertTrue(tele)
        XCTAssertGreaterThan(plant.box().h, startHeight + 0.08)
        XCTAssertLessThan(plant.box().h, 0.75)
    }

    func testDelayedVideoStillAimsAheadOfTheBoxWeWereShown() {
        var settings = TrackingSettings()
        settings.latencyMs = 200
        settings.deadZone = DeadZone(x: 0.02, y: 0.05, size: 0.06)
        let session = TrackingSession(cameraId: "ptz:cam1", settings: settings)
        var time = 0.0
        let dt = 1.0 / 15.0
        _ = session.start(now: 0)
        var predictedAhead = false
        for step in 0..<25 {
            time += dt
            let shown = NormBox(x: 0.20 + Double(step) * 0.015, y: 0.12, w: 0.2, h: 0.55)
            let result = session.tick(detections: [Detection(box: shown, confidence: 0.95, kind: .body)], now: time)
            if let predicted = result.predicted, step > 8 {
                if predicted.centerX > shown.centerX + 0.01 { predictedAhead = true }
            }
        }
        XCTAssertTrue(predictedAhead, "delay compensation puts the aim ahead of the late frame")
    }

    private func makeSession() -> TrackingSession {
        var settings = TrackingSettings()
        settings.latencyMs = 0
        settings.smoothing = 0.35
        return TrackingSession(cameraId: "ptz:cam1", settings: settings)
    }
}
