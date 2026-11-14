import XCTest
@testable import TrackingCore

final class AssociationTests: XCTestCase {
    func testCrossingDoesNotSwapIds() {
        let associator = Associator()
        let dt = 1.0 / 15.0
        var idA = ""
        var lastA = 0.0
        for step in 0..<50 {
            let t = Double(step) * dt
            let ax = 0.12 + t * 0.26
            let bx = 0.78 - t * 0.26
            let tracks = associator.update([
                Detection(box: NormBox(x: ax, y: 0.28, w: 0.16, h: 0.42), confidence: 0.95, kind: .body),
                Detection(box: NormBox(x: bx, y: 0.33, w: 0.16, h: 0.42), confidence: 0.95, kind: .body),
            ], time: t)
            if step == 0 {
                idA = tracks.min { $0.box.centerX < $1.box.centerX }?.id ?? ""
            }
            if let track = tracks.first(where: { $0.id == idA && $0.missing == 0 }) {
                lastA = track.box.centerX
            }
        }
        XCTAssertFalse(idA.isEmpty)
        XCTAssertGreaterThan(lastA, 0.70, "the person who started on the left is still the one walking right")
        let other = associator.tracks.first { $0.id != idA && $0.missing == 0 }
        XCTAssertNotNil(other)
        XCTAssertLessThan(other?.box.centerX ?? 1, 0.45)
    }

    func testBriefHoleKeepsTheSameId() {
        let associator = Associator()
        var time = 0.0
        var id = ""
        for step in 0..<10 {
            time += 1.0 / 15.0
            let box = NormBox(x: 0.2 + Double(step) * 0.02, y: 0.2, w: 0.18, h: 0.5)
            let tracks = associator.update([Detection(box: box, confidence: 0.9, kind: .body)], time: time)
            id = tracks[0].id
        }
        for _ in 0..<6 {
            time += 1.0 / 15.0
            _ = associator.update([], time: time)
        }
        XCTAssertEqual(associator.tracks.first?.id, id)
        XCTAssertGreaterThan(associator.tracks.first?.missing ?? 0, 0)
        time += 1.0 / 15.0
        let back = NormBox(x: 0.2 + 15 * 0.02, y: 0.2, w: 0.18, h: 0.5)
        let tracks = associator.update([Detection(box: back, confidence: 0.9, kind: .body)], time: time)
        XCTAssertEqual(tracks.first { $0.missing == 0 }?.id, id)
    }
}

final class PhaseTests: XCTestCase {
    func testLostHoldThenReacquireOrStop() {
        var machine = PhaseMachine()
        var settings = TrackingSettings()
        settings.lostHoldMs = 500
        settings.autoLock = true
        machine.start()
        let person = Track(id: "t1", box: NormBox(x: 0.4, y: 0.1, w: 0.2, h: 0.5), confidence: 0.9, kind: .body, lastSeen: 0)
        var step = machine.advance(tracks: [person], now: 0, settings: settings)
        XCTAssertEqual(machine.phase, .locked)
        XCTAssertFalse(step.sendStop)

        var missing = person
        missing.missing = 2
        step = machine.advance(tracks: [missing], now: 0.2, settings: settings)
        XCTAssertEqual(machine.phase, .lost)
        XCTAssertTrue(step.sendStop)

        step = machine.advance(tracks: [person], now: 0.4, settings: settings)
        XCTAssertEqual(machine.phase, .locked, "back inside the hold")
        XCTAssertEqual(machine.lockedId, "t1")

        _ = machine.advance(tracks: [missing], now: 1.0, settings: settings)
        XCTAssertEqual(machine.phase, .lost)
        step = machine.advance(tracks: [missing], now: 1.6, settings: settings)
        XCTAssertEqual(machine.phase, .searching)
        XCTAssertNil(machine.lockedId)
        XCTAssertTrue(step.sendStop)

        settings.lostAction = .stop
        machine.userLock("t1")
        _ = machine.advance(tracks: [person], now: 2, settings: settings)
        XCTAssertEqual(machine.phase, .locked)
        _ = machine.advance(tracks: [missing], now: 2.1, settings: settings)
        _ = machine.advance(tracks: [missing], now: 2.8, settings: settings)
        XCTAssertEqual(machine.phase, .off)
    }

    func testOverridePausesAndDoesNotResumeEarly() {
        var machine = PhaseMachine()
        let settings = TrackingSettings()
        machine.start()
        let person = Track(id: "t1", box: NormBox(x: 0.4, y: 0.1, w: 0.2, h: 0.5), confidence: 0.9, kind: .body, lastSeen: 0)
        _ = machine.advance(tracks: [person], now: 0, settings: settings)
        machine.override(now: 1, resumeAfter: 2)
        XCTAssertEqual(machine.phase, .paused)
        _ = machine.advance(tracks: [person], now: 2.5, settings: settings)
        XCTAssertEqual(machine.phase, .paused, "the operator is still inside the hold")
        _ = machine.advance(tracks: [person], now: 3.01, settings: settings)
        XCTAssertEqual(machine.phase, .locked)
        machine.stop()
        machine.override(now: 4, resumeAfter: 2)
        XCTAssertEqual(machine.phase, .off, "a stick moved while tracking is off does not arm a pause")
    }

    func testTwoPeopleDoNotAutoLock() {
        var machine = PhaseMachine()
        let settings = TrackingSettings()
        machine.start()
        let a = Track(id: "t1", box: NormBox(x: 0.1, y: 0.1, w: 0.2, h: 0.5), confidence: 0.9, kind: .body, lastSeen: 0)
        let b = Track(id: "t2", box: NormBox(x: 0.6, y: 0.1, w: 0.2, h: 0.5), confidence: 0.9, kind: .body, lastSeen: 0)
        _ = machine.advance(tracks: [a, b], now: 0, settings: settings)
        XCTAssertEqual(machine.phase, .searching)
        machine.userLock("t2")
        _ = machine.advance(tracks: [a, b], now: 0.1, settings: settings)
        XCTAssertEqual(machine.phase, .locked)
        XCTAssertEqual(machine.lockedId, "t2")
    }
}

final class PanasonicTests: XCTestCase {
    func testSpeedCodesMatchTheControlCenterDriver() {
        XCTAssertEqual(Panasonic.speedCode(0), "50")
        XCTAssertEqual(Panasonic.speedCode(25), "75")
        XCTAssertEqual(Panasonic.speedCode(-25), "25")
        XCTAssertEqual(Panasonic.speedCode(400), "99")
        XCTAssertEqual(Panasonic.speedCode(-400), "01")
        XCTAssertEqual(Panasonic.panTilt(pan: 7, tilt: -3).code, "PTS5747")
        XCTAssertEqual(Panasonic.zoom(12).code, "Z62")
        XCTAssertEqual(Panasonic.stopPanTilt().code, "PTS5050")
        XCTAssertEqual(Panasonic.stopZoom().code, "Z50")
        XCTAssertEqual(Panasonic.stopPanTilt().path, "/cgi-bin/aw_ptz?cmd=%23PTS5050&res=1")
        XCTAssertEqual(Panasonic.panTilt(pan: 20, tilt: -10).path, "/cgi-bin/aw_ptz?cmd=%23PTS7040&res=1")
    }

    func testErrorReplies() {
        XCTAssertEqual(Panasonic.errorReply("eR1:PTS5050"), "eR1:PTS5050")
        XCTAssertEqual(Panasonic.errorReply("ER2"), "ER2")
        XCTAssertEqual(Panasonic.errorReply("E3"), "E3")
        XCTAssertNil(Panasonic.errorReply("pS1"))
        XCTAssertNil(Panasonic.errorReply("  "))
    }

    func testGateDropsRepeatsAndLetsAStopThroughTheGap() {
        var gate = CommandGate()
        let first = gate.emit(Panasonic.panTilt(pan: 10, tilt: 0), now: 1)
        XCTAssertEqual(first?.code, "PTS6050")
        XCTAssertNil(gate.emit(Panasonic.panTilt(pan: 10, tilt: 0), now: 1.01))
        XCTAssertNil(gate.emit(Panasonic.panTilt(pan: 12, tilt: 0), now: 1.01), "inside the 40 ms gap")
        XCTAssertEqual(gate.emit(Panasonic.panTilt(pan: 12, tilt: 0), now: 1.05)?.code, "PTS6250")
        XCTAssertEqual(gate.emit(Panasonic.stopPanTilt(), now: 1.06)?.code, "PTS5050")
    }

    func testQueueKeepsTheLatestSpeedForAnAxis() {
        let queue = PtzCommandQueue()
        queue.submit(Panasonic.panTilt(pan: 5, tilt: 0))
        let taken = queue.take(now: 0)
        XCTAssertEqual(taken?.command.code, "PTS5550")
        queue.submit(Panasonic.panTilt(pan: 8, tilt: 1))
        queue.submit(Panasonic.panTilt(pan: 9, tilt: -2))
        XCTAssertEqual(queue.depth, 1)
        XCTAssertEqual(queue.pending("pt")?.code, "PTS5948")
        XCTAssertNil(queue.take(now: 0.01), "still in flight, and the gap has not elapsed")
        queue.finish(now: 0.01)
        XCTAssertNil(queue.take(now: 0.02))
        XCTAssertEqual(queue.take(now: 0.06)?.command.code, "PTS5948")
    }
}

final class ProtocolTests: XCTestCase {
    func testRoundTripAndTheDocumentedHello() throws {
        let hello = ProtocolCodec.hello(role: "control", name: "control-center")
        let text = try ProtocolCodec.encodeString(hello)
        XCTAssertTrue(text.contains("\"protocol\":1"))
        XCTAssertTrue(text.contains("\"type\":\"hello\""))
        XCTAssertFalse(text.contains("null"))
        let back = try ProtocolCodec.decode(Data(text.utf8))
        XCTAssertEqual(back.role, "control")
        XCTAssertEqual(back.proto, 1)

        var settings = TrackingSettings()
        settings.control = CameraEndpoint(host: "10.0.0.20", port: 80, user: "admin", password: "12345", streamUrl: "http://10.0.0.20/cgi-bin/mjpeg")
        let set = TrackerMessage(type: "settings.set", cameraId: "ptz:cam1", settings: settings)
        let decoded = try ProtocolCodec.decode(try ProtocolCodec.encode(set))
        XCTAssertEqual(decoded.cameraId, "ptz:cam1")
        XCTAssertEqual(decoded.settings?.control?.host, "10.0.0.20")
        XCTAssertEqual(decoded.settings?.detect, .body)
        XCTAssertEqual(decoded.settings?.preset, .medium)
        XCTAssertEqual(decoded.settings?.maxSpeed.pan, 18)

        let nodeShaped = """
        {"cameraId":"ptz:cam1","settings":{"autoLock":true,"control":{"host":"10.0.0.8","password":"secret","port":80,"streamUrl":"http://10.0.0.8/cgi-bin/mjpeg?resolution=640&framerate=15","user":"admin"},"deadZone":{"size":0.06,"x":0.045,"y":0.05},"detect":"face","framing":{"anchorX":0.5,"headroom":0.12,"lead":0.08,"subjectHeight":0.55},"latencyMs":180,"lostAction":"reacquire","lostHoldMs":1200,"maxAccel":{"pan":70,"tilt":60,"zoom":30},"maxSpeed":{"pan":18,"tilt":14,"zoom":8},"minConfidence":0.4,"overrideResumeMs":2000,"preset":"medium","redetectEvery":8,"smoothing":0.45,"source":"mjpeg","streamUrl":"","zoomEnabled":false},"type":"settings.set","v":1}
        """
        let fromNode = try ProtocolCodec.decode(Data(nodeShaped.utf8))
        XCTAssertEqual(fromNode.settings?.detect, .face)
        XCTAssertEqual(fromNode.settings?.control?.password, "secret")
    }

    func testRejectsABadVersionAndAnUnknownType() {
        XCTAssertThrowsError(try ProtocolCodec.decode(Data("{\"v\":2,\"type\":\"hello\"}".utf8))) { error in
            XCTAssertEqual(error as? ProtocolDecodeError, .unsupportedVersion(2))
        }
        XCTAssertThrowsError(try ProtocolCodec.decode(Data("{\"v\":1,\"type\":\"dance\"}".utf8))) { error in
            XCTAssertEqual(error as? ProtocolDecodeError, .unknownType("dance"))
        }
        XCTAssertThrowsError(try ProtocolCodec.decode(Data("not json".utf8)))
    }

    func testStatusCarriesBoxesAndTheLastCommand() throws {
        let message = TrackerMessage(
            type: "status",
            cameraId: "ptz:cam1",
            state: "locked",
            fps: 14.5,
            detections: [StatusDetection(id: "t3", x: 0.4, y: 0.12, w: 0.2, h: 0.55, confidence: 0.91, kind: "body", missing: false)],
            lockedTarget: "t3",
            lastCommand: CommandReport(pan: 6, tilt: 0, zoom: 0, panTilt: "PTS5650", zoomCode: nil)
        )
        let back = try ProtocolCodec.decode(try ProtocolCodec.encode(message))
        XCTAssertEqual(back.state, "locked")
        XCTAssertEqual(back.detections?.first?.id, "t3")
        XCTAssertEqual(back.lastCommand?.panTilt, "PTS5650")
    }
}

final class WireTests: XCTestCase {
    func testAcceptKeyMatchesTheRFCSample() {
        XCTAssertEqual(WebSocketHandshake.accept(for: "dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    }

    func testMaskedAndSplitFrames() {
        let encoded = WebSocketCodec.encode(text: "hello", masked: true, maskKey: [1, 2, 3, 4])
        var buffer = Data(encoded.prefix(3))
        XCTAssertTrue(WebSocketCodec.drain(&buffer).isEmpty)
        buffer.append(encoded.dropFirst(3))
        let frames = WebSocketCodec.drain(&buffer)
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].text, "hello")
        XCTAssertTrue(buffer.isEmpty)

        var server = WebSocketCodec.encode(opcode: .ping, payload: Data([9, 9]), masked: false)
        let ping = WebSocketCodec.drain(&server)
        XCTAssertEqual(ping.first?.opcode, .ping)
        XCTAssertEqual([UInt8](ping.first?.payload ?? Data()), [9, 9])
    }

    func testUpgradeAndHealthResponses() {
        let raw = "GET /v1 HTTP/1.1\r\nHost: 127.0.0.1:8765\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        let request = WebSocketHandshake.parseRequest(raw)
        XCTAssertEqual(request?.path, "/v1")
        XCTAssertEqual(request?.isWebSocketUpgrade, true)
        XCTAssertTrue(WebSocketHandshake.upgradeResponse(key: request?.webSocketKey ?? "").contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="))
        let health = WebSocketHandshake.jsonResponse(status: 200, reason: "OK", body: "{\"ok\":true}")
        XCTAssertTrue(health.contains("Content-Length: 11"))
        XCTAssertTrue(health.hasSuffix("{\"ok\":true}"))
    }

    func testMJPEGParserReassemblesAcrossChunks() {
        let jpeg = Data([0xFF, 0xD8, 0x00, 0x11, 0x22, 0xFF, 0xD9])
        var head = Data("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: \(jpeg.count)\r\n\r\n".utf8)
        head.append(jpeg)
        head.append(Data("\r\n--frame\r\n".utf8))
        let parser = MJPEGParser()
        XCTAssertEqual(MJPEG.boundary(from: "multipart/x-mixed-replace; boundary=frame"), "frame")
        parser.boundary = "frame"
        let cut = head.count / 2
        XCTAssertTrue(parser.append(Data(head.prefix(cut))).isEmpty)
        let frames = parser.append(Data(head.dropFirst(cut)))
        XCTAssertEqual(frames, [jpeg])
    }

    func testClockDropsFramesFasterThanFifteen() {
        var clock = FrameClock(fps: 15)
        XCTAssertTrue(clock.shouldTake(now: 1))
        XCTAssertFalse(clock.shouldTake(now: 1.02))
        XCTAssertTrue(clock.shouldTake(now: 1.07))
        var cadence = DetectCadence(every: 4)
        let passes = (0..<8).map { _ in cadence.wantsFullPass() }
        XCTAssertEqual(passes, [true, false, false, false, true, false, false, false])
    }
}
