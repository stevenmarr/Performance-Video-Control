import XCTest
@testable import TrackingCore

final class FilterTests: XCTestCase {
    private func tune(dead: Double = 0.04, gentle: Double = 0.06, fast: Double = 0.10, gentleSpeed: Double = 6, maxSpeed: Double = 20, gain: Double = 8, hysteresis: Double = 1.85) -> AxisTune {
        AxisTune(dead: dead, gentle: gentle, fast: fast, gentleSpeed: gentleSpeed, maxSpeed: maxSpeed, gain: gain, hysteresis: hysteresis)
    }

    func testDeadZoneAndHysteresis() {
        let curve = tune()
        let inside = ResponseMath.target(error: 0.03, tune: curve, holding: false)
        XCTAssertEqual(inside.speed, 0)
        XCTAssertTrue(inside.holding)
        let released = ResponseMath.target(error: 0.05, tune: curve, holding: true)
        XCTAssertEqual(released.speed, 0, "a settled axis stays still until the error clears the release band")
        XCTAssertTrue(released.holding)
        let go = ResponseMath.target(error: 0.09, tune: curve, holding: true)
        XCTAssertGreaterThan(go.speed, 0)
        XCTAssertFalse(go.holding)
    }

    func testGentleBandStaysUnderTheGentleCapAndTheFastZoneCanUseTheMax() {
        let curve = tune()
        let gentle = ResponseMath.target(error: 0.07, tune: curve, holding: false)
        XCTAssertGreaterThan(gentle.speed, 0)
        XCTAssertLessThanOrEqual(gentle.speed, curve.gentleSpeed + 0.01)
        let far = ResponseMath.target(error: 0.40, tune: curve, holding: false)
        XCTAssertGreaterThan(far.speed, curve.gentleSpeed)
        XCTAssertLessThanOrEqual(far.speed, curve.maxSpeed)
        XCTAssertLessThanOrEqual(abs(far.speed), 49)
        let left = ResponseMath.target(error: -0.40, tune: curve, holding: false)
        XCTAssertLessThan(left.speed, 0)
        XCTAssertEqual(abs(left.speed), far.speed, accuracy: 1e-9)
    }

    func testZoneCapRampsBetweenTheBands() {
        let curve = tune()
        XCTAssertEqual(ResponseMath.zoneCap(excess: 0.02, tune: curve), curve.gentleSpeed, accuracy: 1e-9)
        XCTAssertEqual(ResponseMath.zoneCap(excess: 0.20, tune: curve), curve.maxSpeed, accuracy: 1e-9)
        let mid = ResponseMath.zoneCap(excess: 0.11, tune: curve)
        XCTAssertGreaterThan(mid, curve.gentleSpeed)
        XCTAssertLessThan(mid, curve.maxSpeed)
        let classic = tune(gentle: 0, fast: 0, maxSpeed: 18)
        XCTAssertEqual(ResponseMath.zoneCap(excess: 0.2, tune: classic), 18, accuracy: 1e-9)
    }

    func testJitterFilterBluntsASpike() {
        var filter = ErrorFilter()
        XCTAssertEqual(filter.push(0, jitter: 0.8), 0)
        let spiked = filter.push(1, jitter: 0.8)
        XCTAssertEqual(spiked, 0.2, accuracy: 1e-9)
        XCTAssertLessThan(spiked, 0.5)
        var raw = ErrorFilter()
        XCTAssertEqual(raw.push(0.25, jitter: 0), 0.25, accuracy: 1e-9)
    }

    func testDriftSuppressesCreepAndLetsARealMoveThrough() {
        XCTAssertTrue(ResponseMath.suppressDrift(error: 0.05, imageSpeed: 0.01, dead: 0.04, hysteresis: 1.85, drift: 0.04))
        XCTAssertFalse(ResponseMath.suppressDrift(error: 0.05, imageSpeed: 0.12, dead: 0.04, hysteresis: 1.85, drift: 0.04))
        XCTAssertFalse(ResponseMath.suppressDrift(error: 0.20, imageSpeed: 0.01, dead: 0.04, hysteresis: 1.85, drift: 0.04))
        XCTAssertFalse(ResponseMath.suppressDrift(error: 0.05, imageSpeed: 0.01, dead: 0.04, hysteresis: 1.85, drift: 0))
    }

    func testAccelAndDecelRampsAreSeparate() {
        let dt = 0.1
        var rise = Easer()
        let up = rise.step(toward: 20, dt: dt, smoothing: 0, maxAccel: 40, maxDecel: 5)
        XCTAssertLessThanOrEqual(up, 40 * dt + 0.001, "speeding up is limited by acceleration")
        XCTAssertGreaterThan(up, 1)

        var held = Easer()
        for _ in 0..<6 {
            _ = held.step(toward: 30, dt: 0.25, smoothing: 0, maxAccel: 200, maxDecel: 200)
        }
        let high = held.value
        XCTAssertGreaterThan(high, 15)
        let down = held.step(toward: 0, dt: dt, smoothing: 0, maxAccel: 400, maxDecel: 10)
        XCTAssertLessThanOrEqual(high - down, 10 * dt + 0.05, "slowing down is limited by deceleration, not the larger acceleration")
        XCTAssertGreaterThan(high - down, 0.2)
        let afterBrake = held.value
        let slammed = held.step(toward: 0, dt: dt, smoothing: 0, maxAccel: 5, maxDecel: 400)
        XCTAssertLessThan(slammed, afterBrake - 1, "a larger deceleration is allowed to shed speed faster")
    }

    func testFeelPresetsStayInsideTheCameraScale() {
        let base = TrackingSettings()
        let lecture = FeelLibrary.apply(.lecture, to: base)
        let sports = FeelLibrary.apply(.sports, to: base)
        XCTAssertLessThan(lecture.maxSpeed.pan, sports.maxSpeed.pan)
        XCTAssertGreaterThan(lecture.deadZone.x, sports.deadZone.x)
        XCTAssertGreaterThan(lecture.jitter ?? 0, sports.jitter ?? 0)
        for settings in [lecture, sports, FeelLibrary.apply(.medium, to: base)] {
            for speed in [settings.maxSpeed.pan, settings.maxSpeed.tilt, settings.maxSpeed.zoom] {
                XCTAssertGreaterThanOrEqual(speed, 1)
                XCTAssertLessThanOrEqual(speed, 49)
            }
        }
        XCTAssertEqual(lecture.feel, .lecture)
    }

    func testPanasonicCapNeverExceedsTheProtocol() {
        let curve = tune(gentle: 0, fast: 0, gentleSpeed: 49, maxSpeed: 80, gain: 20)
        let speed = ResponseMath.target(error: 1, tune: curve, holding: false).speed
        XCTAssertLessThanOrEqual(speed, 49)
        XCTAssertEqual(quantizeSpeed(49.4), 49)
        XCTAssertEqual(quantizeSpeed(-80), -49)
        XCTAssertEqual(Panasonic.speedCode(49), "99")
        XCTAssertEqual(Panasonic.speedCode(-49), "01")
        XCTAssertEqual(Panasonic.speedCode(0), "50")
    }

    func testSmallSubjectIsIgnoredAndANormalOneIsNot() {
        var settings = TrackingSettings()
        settings.minSubject = 0.2
        settings.minConfidence = 0.5
        let session = TrackingSession(cameraId: "ptz:cam1", settings: settings)
        _ = session.start(now: 0)
        let tiny = Detection(box: NormBox(x: 0.4, y: 0.1, w: 0.05, h: 0.1), confidence: 0.95, kind: .body)
        let grown = Detection(box: NormBox(x: 0.3, y: 0.1, w: 0.2, h: 0.5), confidence: 0.95, kind: .body)
        let weak = Detection(box: NormBox(x: 0.3, y: 0.1, w: 0.2, h: 0.5), confidence: 0.2, kind: .body)
        XCTAssertEqual(session.tick(detections: [tiny], now: 0.1).phase, .searching)
        XCTAssertEqual(session.tick(detections: [weak], now: 0.2).phase, .searching)
        XCTAssertEqual(session.tick(detections: [grown], now: 0.3).phase, .locked)
    }
}
