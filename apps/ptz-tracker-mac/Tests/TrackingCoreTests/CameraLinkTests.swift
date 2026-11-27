import XCTest
@testable import TrackingCore

final class CameraLinkTests: XCTestCase {
    func testAMoveInsideTheGapWaitsAndAStopDoesNot() {
        var link = CameraLink()
        link.submit(Panasonic.panTilt(pan: 7, tilt: 0))
        let first = link.poll(now: 1)
        XCTAssertEqual(first?.code, "PTS5750")
        XCTAssertEqual(first?.path, "/cgi-bin/aw_ptz?cmd=%23PTS5750&res=1")
        link.succeed(now: 1.01)
        link.submit(Panasonic.panTilt(pan: 9, tilt: -2))
        XCTAssertNil(link.poll(now: 1.02), "two speeds inside 40 ms, the second waits")
        link.submit(Panasonic.stopPanTilt())
        XCTAssertEqual(link.poll(now: 1.02)?.code, "PTS5050", "a stop cuts in front of the gap")
    }

    func testALostMoveIsFollowedByAStopAndALostStopIsRetried() {
        var link = CameraLink(timeout: 0.05, stopRetries: 3, backoffs: [0.5])
        link.submit(Panasonic.panTilt(pan: 12, tilt: 0))
        XCTAssertEqual(link.poll(now: 0)?.code, "PTS6250")
        XCTAssertTrue(link.timedOut(now: 0.05))
        XCTAssertEqual(link.fail(now: 0.05), 0, "the stop goes out immediately")
        XCTAssertTrue(link.isRecovering)
        link.submit(Panasonic.panTilt(pan: 20, tilt: 0))
        XCTAssertEqual(link.poll(now: 0.05)?.code, "PTS5050", "a new speed cannot replace the stop")
        XCTAssertEqual(link.fail(now: 0.06), 0)
        XCTAssertEqual(link.poll(now: 0.06)?.code, "PTS5050")
        XCTAssertEqual(link.fail(now: 0.07), 0)
        XCTAssertEqual(link.poll(now: 0.07)?.code, "PTS5050")
        XCTAssertEqual(link.fail(now: 0.08), 0)
        XCTAssertEqual(link.poll(now: 0.08)?.code, "PTS5050")
        let wait = link.fail(now: 0.09)
        XCTAssertEqual(wait, 0.5, "after the retries, wait and try the stop again")
        XCTAssertNil(link.poll(now: 0.2))
        XCTAssertEqual(link.poll(now: 0.09 + 0.5)?.code, "PTS5050")
        link.succeed(now: 0.6)
        XCTAssertFalse(link.isRecovering)
        XCTAssertFalse(link.isBackingOff)
        link.submit(Panasonic.panTilt(pan: 3, tilt: 0))
        XCTAssertEqual(link.poll(now: 0.7)?.code, "PTS5350", "once a command lands, speeds are allowed again")
    }

    func testUnchangedSpeedIsNotRequiredTwiceFromTheGate() {
        var gate = CommandGate()
        XCTAssertEqual(gate.emit(Panasonic.zoom(4), now: 1)?.code, "Z54")
        XCTAssertNil(gate.emit(Panasonic.zoom(4), now: 2))
        XCTAssertEqual(gate.emit(Panasonic.stopZoom(), now: 2.01)?.code, "Z50")
    }
}
