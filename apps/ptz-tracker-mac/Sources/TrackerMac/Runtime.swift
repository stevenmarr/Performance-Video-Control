import Foundation
import TrackingCore

struct CameraRow {
    var label: String
    var state: String
}

struct TrackerSnapshot {
    var listening: String
    var cameras: [CameraRow]
}

/// Owns one pipeline per camera id (`ptz:cam1`). The control socket, Vision, and the CGI client meet here.
final class TrackerRuntime {
    var onState: ((TrackerSnapshot) -> Void)?
    private let queue: DispatchQueue
    private let server: ControlServer
    private var cameras: [String: Pipeline] = [:]
    private var port: UInt16
    private var clock: DispatchSourceTimer?

    init(port: UInt16) {
        let queue = DispatchQueue(label: "ptz.tracker.runtime")
        self.queue = queue
        self.port = port
        server = ControlServer(port: port, queue: queue)
    }

    func start() {
        server.onMessage = { [weak self] message, reply in
            self?.handle(message, reply: reply)
        }
        server.health = { [weak self] in
            self?.health() ?? HealthReport(ok: true, cameras: [])
        }
        server.start()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.2, repeating: 0.2)
        timer.setEventHandler { [weak self] in self?.advance() }
        timer.resume()
        clock = timer
        publish()
        trackerLog(server.listening)
    }

    func shutdown(_ done: @escaping () -> Void) {
        queue.async { [weak self] in
            guard let self else { done(); return }
            self.clock?.cancel()
            let group = DispatchGroup()
            for pipeline in self.cameras.values {
                group.enter()
                pipeline.stop {
                    group.leave()
                }
            }
            group.notify(queue: self.queue) {
                self.server.stop()
                DispatchQueue.main.async { done() }
            }
        }
    }

    private func handle(_ message: TrackerMessage, reply: @escaping (TrackerMessage) -> Void) {
        switch message.type {
        case "hello":
            reply(ProtocolCodec.hello(role: "tracker", name: "ptz-tracker"))
            for pipeline in cameras.values { send(pipeline.session.status(fps: pipeline.fps)) }
        case "ping":
            reply(TrackerMessage(type: "pong"))
        case "settings.get":
            guard let id = message.cameraId, let pipeline = cameras[id] else {
                reply(ProtocolCodec.error(code: "unknown_camera", message: "No settings for that camera yet.", cameraId: message.cameraId))
                return
            }
            reply(TrackerMessage(type: "settings", cameraId: id, settings: pipeline.session.settings))
        case "settings.set":
            guard let id = message.cameraId, var settings = message.settings else {
                reply(ProtocolCodec.error(code: "bad_message", message: "settings.set needs cameraId and settings.", cameraId: message.cameraId))
                return
            }
            settings = settings.clamped()
            let pipeline = cameras[id] ?? Pipeline(cameraId: id, settings: settings, queue: queue)
            pipeline.apply(settings)
            cameras[id] = pipeline
            reply(TrackerMessage(type: "settings", cameraId: id, settings: pipeline.session.settings))
            publish()
        case "start":
            guard let id = message.cameraId, let pipeline = cameras[id] else {
                reply(ProtocolCodec.error(code: "unknown_camera", message: "Send settings before start.", cameraId: message.cameraId))
                return
            }
            guard pipeline.session.settings.control != nil else {
                reply(ProtocolCodec.error(code: "no_camera", message: "Settings have no camera address.", cameraId: id))
                return
            }
            pipeline.start()
            reply(pipeline.session.status(fps: pipeline.fps))
            publish()
        case "stop":
            guard let id = message.cameraId, let pipeline = cameras[id] else {
                reply(ProtocolCodec.error(code: "unknown_camera", message: "That camera is not set up.", cameraId: message.cameraId))
                return
            }
            pipeline.userStop()
            reply(pipeline.session.status(fps: 0))
            publish()
        case "lock":
            guard let id = message.cameraId, let target = message.targetId, let pipeline = cameras[id] else {
                reply(ProtocolCodec.error(code: "bad_message", message: "lock needs cameraId and targetId.", cameraId: message.cameraId))
                return
            }
            let result = pipeline.session.lock(targetId: target, now: now())
            pipeline.send(result.commands)
            reply(pipeline.session.status(fps: pipeline.fps))
        case "unlock":
            guard let id = message.cameraId, let pipeline = cameras[id] else {
                reply(ProtocolCodec.error(code: "unknown_camera", message: "That camera is not set up.", cameraId: message.cameraId))
                return
            }
            let result = pipeline.session.unlock(now: now())
            pipeline.send(result.commands)
            reply(pipeline.session.status(fps: pipeline.fps))
        case "resume":
            guard let id = message.cameraId, let pipeline = cameras[id] else {
                reply(ProtocolCodec.error(code: "unknown_camera", message: "That camera is not set up.", cameraId: message.cameraId))
                return
            }
            let result = pipeline.session.resume(now: now())
            pipeline.send(result.commands)
            reply(pipeline.session.status(fps: pipeline.fps))
        case "override":
            guard let id = message.cameraId, let pipeline = cameras[id] else { return }
            let result = pipeline.session.override(now: now())
            pipeline.send(result.commands)
            send(pipeline.session.status(fps: pipeline.fps))
            publish()
        default:
            break
        }
    }

    /// Pause expiry and loss hold, plus "the stream went quiet" so a dead MJPEG link stops the head.
    private func advance() {
        let time = now()
        for pipeline in cameras.values where pipeline.running {
            if time - pipeline.lastFrame > 0.5 && pipeline.session.phase == .locked {
                let result = pipeline.session.tick(detections: [], now: time)
                pipeline.send(result.commands)
            } else {
                let result = pipeline.session.tick(detections: nil, now: time)
                pipeline.send(result.commands)
            }
            if pipeline.session.phase != pipeline.lastPublished {
                pipeline.lastPublished = pipeline.session.phase
                send(pipeline.session.status(fps: pipeline.fps))
                publish()
            }
        }
    }

    private func send(_ message: TrackerMessage) { server.broadcast(message) }

    private func health() -> HealthReport {
        HealthReport(ok: true, cameras: cameras.keys.sorted().map { id in
            HealthCamera(cameraId: id, state: cameras[id]?.session.phase.rawValue ?? "off")
        })
    }

    private func publish() {
        let rows = cameras.keys.sorted().map { id in
            CameraRow(label: id, state: cameras[id]?.session.phase.rawValue ?? "off")
        }
        let snapshot = TrackerSnapshot(listening: server.listening, cameras: rows)
        DispatchQueue.main.async { [onState] in onState?(snapshot) }
    }

    private func now() -> Double { Date().timeIntervalSince1970 }
}

private final class Pipeline {
    let session: TrackingSession
    let detector = VisionDetector()
    let camera = PanasonicClient()
    let converter = FrameConverter()
    private var mjpeg: MJPEGSource?
    private var jpeg: JPEGPollSource?
    private var cadence: DetectCadence
    private var clock = FrameClock(fps: 15)
    private var framesInWindow = 0
    private var windowStart = Date().timeIntervalSince1970
    private(set) var fps = 0.0
    private(set) var running = false
    var lastFrame = 0.0
    var lastPublished: TrackingPhase = .off
    private var pending: Data?
    private var analysing = false

    private let queue: DispatchQueue

    init(cameraId: String, settings: TrackingSettings, queue: DispatchQueue) {
        self.queue = queue
        session = TrackingSession(cameraId: cameraId, settings: settings)
        cadence = DetectCadence(every: settings.redetectEvery)
        if let endpoint = settings.control { camera.configure(endpoint) }
    }

    func apply(_ settings: TrackingSettings) {
        let previous = session.settings
        session.replaceSettings(settings)
        cadence = DetectCadence(every: settings.redetectEvery)
        if let endpoint = settings.control { camera.configure(endpoint) }
        if running && streamURL(settings) != streamURL(previous) {
            openSource(settings)
        }
        if running && settings.detect != previous.detect { detector.reset() }
    }

    func start() {
        let settings = session.settings
        guard settings.control != nil else { return }
        running = true
        lastFrame = Date().timeIntervalSince1970
        _ = session.start(now: lastFrame)
        camera.stopAll()
        openSource(settings)
        trackerLog("start \(session.cameraId)")
    }

    func userStop() {
        running = false
        closeSource()
        let result = session.stop(now: Date().timeIntervalSince1970)
        send(result.commands)
        detector.reset()
        trackerLog("stop \(session.cameraId)")
    }

    func stop(_ done: @escaping () -> Void) {
        running = false
        closeSource()
        _ = session.stop(now: Date().timeIntervalSince1970)
        camera.stopAll(then: done)
    }

    func send(_ commands: [PtzCommand]) {
        for command in commands { camera.send(command) }
    }

    private func openSource(_ settings: TrackingSettings) {
        closeSource()
        guard let url = streamURL(settings), let endpoint = settings.control else { return }
        if settings.source == .jpeg {
            let source = JPEGPollSource()
            source.configure(user: endpoint.user, password: endpoint.password)
            source.onJPEG = { [weak self] data in self?.offer(data) }
            source.start(url: url)
            jpeg = source
        } else {
            let source = MJPEGSource()
            source.configure(user: endpoint.user, password: endpoint.password)
            source.onJPEG = { [weak self] data in self?.offer(data) }
            source.start(url: url)
            mjpeg = source
        }
    }

    private func closeSource() {
        mjpeg?.stop()
        jpeg?.stop()
        mjpeg = nil
        jpeg = nil
    }

    private func streamURL(_ settings: TrackingSettings) -> String? {
        if !settings.streamUrl.isEmpty { return settings.streamUrl }
        let url = settings.control?.streamUrl ?? ""
        return url.isEmpty ? nil : url
    }

    /// Newest JPEG wins. Called from the URLSession queue; the work runs on the runtime queue
    /// so the session and the CGI client are only touched there.
    private func offer(_ data: Data) {
        queue.async { [weak self] in
            guard let self, self.running else { return }
            self.pending = data
            self.drain()
        }
    }

    private func drain() {
        if analysing { return }
        guard let data = pending else { return }
        pending = nil
        let time = Date().timeIntervalSince1970
        guard clock.shouldTake(now: time), let buffer = converter.makeBuffer(data) else {
            if pending != nil { drain() }
            return
        }
        analysing = true
        lastFrame = time
        detector.setFrame(buffer)
        if detector.needsFullPass { cadence.invalidate() }
        let full = cadence.wantsFullPass()
        let boxes = detector.detections(mode: session.settings.detect, fullPass: full)
        let result = session.tick(detections: boxes, now: time)
        send(result.commands)
        framesInWindow += 1
        if time - windowStart >= 1 {
            fps = Double(framesInWindow) / max(0.001, time - windowStart)
            framesInWindow = 0
            windowStart = time
        }
        analysing = false
        if pending != nil { drain() }
    }
}
