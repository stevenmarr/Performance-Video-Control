import Foundation
import XCTest
@testable import TrackingCore

final class HarnessTests: XCTestCase {
    func testMediumWalkStaysCatchableAndSettles() {
        let run = TrackingHarness.run(settings: FeelLibrary.apply(.medium, to: TrackingSettings()), frames: TrackingHarness.walkScript())
        fputs(TrackingHarness.report(run, name: "medium") + "\n", stderr)
        let score = run.score
        XCTAssertNotNil(score.responseMs)
        XCTAssertLessThan(score.responseMs ?? 9999, 500, "medium should start moving within half a second of leaving the dead zone")
        XCTAssertLessThan(score.meanLag, 0.20, "during the walk the person stays within 20% of the aim")
        XCTAssertGreaterThan(score.meanLag, -0.05, "the head should not sit ahead of a walk this slow")
        XCTAssertLessThan(score.overshoot, 0.08, "after they stop, the coast past the aim stays under 8% of the picture")
        XCTAssertEqual(score.settleReversals, 0, "once they are standing, the head does not hunt")
        XCTAssertLessThan(score.walkReversalsPerSec, 1.5)
        XCTAssertTrue(score.stoppedOnLoss)
        XCTAssertNotNil(score.recoveryMs)
        XCTAssertLessThan(score.recoveryMs ?? 9999, 400, "back inside the hold, the same person is locked again quickly")
        XCTAssertEqual(score.finalPhase, .locked)
        let repeated = zip(score.commands, score.commands.dropFirst()).contains { $0.code == $1.code }
        XCTAssertFalse(repeated, "an unchanged speed is not sent twice")
        XCTAssertTrue(score.commands.contains { $0.code == "PTS5050" })
        XCTAssertTrue(score.commands.allSatisfy { $0.code.hasPrefix("PTS") || $0.code.hasPrefix("Z") })
        XCTAssertTrue(run.events.allSatisfy { abs($0.pan) <= 49 && abs($0.tilt) <= 49 && abs($0.zoom) <= 49 })
        XCTAssertTrue(run.events.allSatisfy { $0.zoom == 0 }, "zoom is off unless ZOOM FOLLOWS is on")
    }

    func testLectureIsQuieterThanSportsAndASwayDoesNotMove() {
        let lecture = TrackingHarness.run(settings: FeelLibrary.apply(.lecture, to: TrackingSettings()), frames: TrackingHarness.walkScript())
        let sports = TrackingHarness.run(settings: FeelLibrary.apply(.sports, to: TrackingSettings()), frames: TrackingHarness.walkScript())
        fputs(TrackingHarness.report(lecture, name: "lecture") + "\n", stderr)
        fputs(TrackingHarness.report(sports, name: "sports") + "\n", stderr)
        let lecturePeak = lecture.events.map { abs($0.pan) }.max() ?? 0
        let sportsPeak = sports.events.map { abs($0.pan) }.max() ?? 0
        XCTAssertLessThan(lecturePeak, sportsPeak, "the lecture cap is lower than the sports cap")
        XCTAssertLessThanOrEqual(lecturePeak, 10)
        XCTAssertLessThanOrEqual(sportsPeak, 36)
        XCTAssertLessThan(sports.score.meanLag, lecture.score.meanLag + 0.02, "sports sits closer to the aim on the same walk")

        let sway = TrackingHarness.run(settings: FeelLibrary.apply(.medium, to: TrackingSettings()), frames: TrackingHarness.swayScript())
        fputs(TrackingHarness.report(sway, name: "sway") + "\n", stderr)
        XCTAssertTrue(sway.events.allSatisfy { $0.pan == 0 && $0.tilt == 0 }, "a one-percent sway stays inside the dead zone")
        XCTAssertFalse(sway.score.commands.contains { $0.code != "PTS5050" })
    }

    func testARecordedPathFeedsTheSameLoop() throws {
        let recorded = """
        [{"t":0.00,"x":0.00,"y":0,"h":0.55,"present":true},
         {"t":0.10,"x":0.00,"y":0,"h":0.55,"present":true},
         {"t":0.20,"x":0.04,"y":0,"h":0.55,"present":true},
         {"t":0.30,"x":0.08,"y":0,"h":0.55,"present":true},
         {"t":0.40,"x":0.12,"y":0,"h":0.55,"present":true},
         {"t":0.50,"x":0.12,"y":0,"h":0.55,"present":false},
         {"t":0.70,"x":0.12,"y":0,"h":0.55,"present":false},
         {"t":0.90,"x":0.12,"y":0,"h":0.55,"present":true}]
        """
        let frames = try TrackingHarness.frames(from: Data(recorded.utf8))
        let run = TrackingHarness.run(settings: FeelLibrary.apply(.sports, to: TrackingSettings()), frames: frames)
        fputs(TrackingHarness.report(run, name: "recorded") + "\n", stderr)
        XCTAssertEqual(frames.count, 8)
        XCTAssertTrue(run.score.stoppedOnLoss)
        XCTAssertEqual(run.events.last?.phase, .locked)
        XCTAssertGreaterThan(run.events.map(\.pan).max() ?? 0, 0, "the recorded walk to the right pans right")
    }

    func testMotionMathIsFarBelowAFrame() {
        let micros = TrackingHarness.motionMicroseconds()
        fputs(String(format: "motion-us-per-update %.2f\n", micros), stderr)
        XCTAssertLessThan(micros, 200, "the pan/tilt/zoom math is a small part of a 15 fps frame")
    }

    func testHigherDeadZoneAndSmoothingDelayTheStart() {
        var loose = FeelLibrary.apply(.medium, to: TrackingSettings())
        loose.feel = .custom
        loose.deadZone = DeadZone(x: 0.09, y: 0.09, size: 0.09)
        loose.axisSmoothing = AxisLimits(pan: 0.9, tilt: 0.9, zoom: 0.9)
        loose.smoothing = 0.9
        var tight = FeelLibrary.apply(.medium, to: TrackingSettings())
        tight.feel = .custom
        tight.deadZone = DeadZone(x: 0.02, y: 0.02, size: 0.02)
        tight.axisSmoothing = AxisLimits(pan: 0.05, tilt: 0.05, zoom: 0.05)
        tight.smoothing = 0.05
        tight.gain = AxisLimits(pan: 16, tilt: 16, zoom: 8)
        let looseRun = TrackingHarness.run(settings: loose, frames: TrackingHarness.walkScript())
        let tightRun = TrackingHarness.run(settings: tight, frames: TrackingHarness.walkScript())
        fputs(TrackingHarness.report(looseRun, name: "wide-dead") + "\n", stderr)
        fputs(TrackingHarness.report(tightRun, name: "tight-dead") + "\n", stderr)
        let looseResponse = looseRun.score.responseMs ?? 0
        let tightResponse = tightRun.score.responseMs ?? 9999
        XCTAssertGreaterThan(looseResponse, tightResponse, "a wider dead zone and heavier smoothing wait longer before the head moves")
    }
}
