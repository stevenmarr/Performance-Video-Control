import XCTest
@testable import TrackingCore

final class MotionTests: XCTestCase {
    func testDeadZoneIsSilentAndJustOutsideItStartsAtZero() {
        XCTAssertEqual(FramingMath.response(error: 0.03, dead: 0.045, maxSpeed: 20), 0)
        XCTAssertEqual(FramingMath.response(error: -0.04, dead: 0.045, maxSpeed: 20), 0)
        let edge = FramingMath.response(error: 0.050, dead: 0.045, maxSpeed: 20)
        XCTAssertGreaterThan(edge, 0)
        XCTAssertLessThan(edge, 2, "a hair outside the dead zone is a creep, not a kick")
        let far = FramingMath.response(error: 0.40, dead: 0.045, maxSpeed: 20)
        XCTAssertLessThanOrEqual(far, 20)
        XCTAssertGreaterThan(far, 15)
    }

    func testLeadRoomSitsTheSubjectBackFromTheirDirection() {
        let box = NormBox(x: 0.4, y: 0.12, w: 0.2, h: 0.55)
        let framing = ShotPreset.medium.builtIn
        let right = FramingMath.aim(box: box, velocityX: 0.40, framing: framing)
        let left = FramingMath.aim(box: box, velocityX: -0.40, framing: framing)
        let still = FramingMath.aim(box: box, velocityX: 0, framing: framing)
        XCTAssertLessThan(right.centerX, framing.anchorX, "walking right, leave room in front")
        XCTAssertGreaterThan(left.centerX, framing.anchorX)
        XCTAssertEqual(still.centerX, framing.anchorX, accuracy: 1e-9)
        XCTAssertEqual(right.top, framing.headroom, accuracy: 1e-9)
        XCTAssertGreaterThanOrEqual(right.centerX, framing.anchorX - framing.lead - 1e-9)
    }

    func testHeadroomAndSizeSigns() {
        let settings = TrackingSettings()
        let motion = MotionController()
        // Subject low in the frame and small. Tilt must be down (negative). Zoom is off by default.
        let low = NormBox(x: 0.35, y: 0.55, w: 0.18, h: 0.30)
        var tilt = 0.0
        var zoom = 0.0
        var time = 0.0
        for _ in 0..<20 {
            time += 1.0 / 15.0
            let out = motion.update(box: low, time: time, settings: settings)
            tilt = out.continuous.tilt
            zoom = out.continuous.zoom
        }
        XCTAssertLessThan(tilt, -1, "subject below the headroom line, tilt down")
        XCTAssertEqual(zoom, 0, "zoom stays out of it until it is turned on")

        var zooming = TrackingSettings()
        zooming.zoomEnabled = true
        let zoomMotion = MotionController()
        time = 0
        var z = 0.0
        for _ in 0..<25 {
            time += 1.0 / 15.0
            z = zoomMotion.update(box: low, time: time, settings: zooming).continuous.zoom
        }
        XCTAssertGreaterThan(z, 1, "subject smaller than the preset, zoom tele")
    }

    func testSubjectOnTheRightPansRight() {
        let motion = MotionController()
        let settings = TrackingSettings()
        let box = NormBox(x: 0.72, y: 0.12, w: 0.2, h: 0.55)
        var pan = 0.0
        var time = 0.0
        for _ in 0..<12 {
            time += 1.0 / 15.0
            pan = motion.update(box: box, time: time, settings: settings).continuous.pan
        }
        XCTAssertGreaterThan(pan, 1)
    }

    func testAccelerationCapAndEaseToStop() {
        let motion = MotionController()
        var settings = TrackingSettings()
        settings.maxSpeed = AxisLimits(pan: 30, tilt: 20, zoom: 8)
        settings.maxAccel = AxisLimits(pan: 60, tilt: 60, zoom: 30)
        settings.smoothing = 0.2
        settings.latencyMs = 0
        let dt = 1.0 / 15.0
        let cap = settings.maxAccel.pan * dt + 0.02
        var time = 0.0
        var previous = 0.0
        let jumped = NormBox(x: 0.82, y: 0.12, w: 0.18, h: 0.55)
        for _ in 0..<10 {
            time += dt
            let speed = motion.update(box: jumped, time: time, settings: settings).continuous.pan
            XCTAssertLessThanOrEqual(abs(speed - previous), cap)
            XCTAssertLessThanOrEqual(abs(speed), settings.maxSpeed.pan + 0.01)
            previous = speed
        }
        XCTAssertGreaterThan(previous, 4)
        let beforeStop = previous
        time += dt
        // Put the box on the aim the controller just published and then ease.
        let aimed = NormBox(x: motion.aim.centerX - 0.09, y: motion.aim.top, w: 0.18, h: 0.55)
        let eased = motion.update(box: aimed, time: time, settings: settings).continuous.pan
        XCTAssertLessThan(eased, beforeStop)
        XCTAssertGreaterThan(eased, beforeStop * 0.45, "a stop inside the dead zone coasts down; it does not slam")
    }

    func testLatencyPredictorLeadsAConstantWalk() {
        var predictor = LatencyPredictor()
        var time = 0.0
        let dt = 1.0 / 15.0
        var last = NormBox(x: 0.2, y: 0.2, w: 0.2, h: 0.4)
        for step in 0..<20 {
            time += dt
            let box = NormBox(x: 0.2 + Double(step) * 0.02, y: 0.2, w: 0.2, h: 0.4)
            predictor.push(box, time: time)
            last = box
        }
        XCTAssertEqual(predictor.vx, 0.02 / dt, accuracy: 0.05)
        let ahead = predictor.predict(from: last, latency: 0.20)
        // 0.02 of the frame per 1/15 s is 0.30 widths/s, so 200 ms of lead is about 0.06.
        XCTAssertGreaterThan(ahead.centerX, last.centerX + 0.04)
        let none = predictor.predict(from: last, latency: 0)
        XCTAssertEqual(none.centerX, last.centerX, accuracy: 1e-6)
    }

    func testPresetsClampAndCustomFramingIsKept() {
        var wild = TrackingSettings()
        wild.maxSpeed = AxisLimits(pan: 400, tilt: 0, zoom: -3)
        wild.smoothing = 4
        wild.latencyMs = 9000
        wild.deadZone = DeadZone(x: -1, y: 2, size: 0.02)
        let clean = wild.clamped()
        XCTAssertEqual(clean.maxSpeed.pan, 49)
        XCTAssertEqual(clean.maxSpeed.tilt, 1)
        XCTAssertEqual(clean.smoothing, 1)
        XCTAssertEqual(clean.latencyMs, 2000)
        XCTAssertEqual(clean.deadZone.x, 0)
        XCTAssertEqual(clean.deadZone.y, 0.4)
        XCTAssertEqual(clean.resolvedFraming, ShotPreset.medium.builtIn)

        var custom = TrackingSettings()
        custom.preset = .custom
        custom.framing = Framing(subjectHeight: 0.42, headroom: 0.2, anchorX: 0.4, lead: 0.1)
        XCTAssertEqual(custom.clamped().resolvedFraming.subjectHeight, 0.42)
        XCTAssertEqual(ShotPreset.wide.builtIn.subjectHeight, 0.38)
        XCTAssertEqual(ShotPreset.close.builtIn.headroom, 0.08)
    }
}
