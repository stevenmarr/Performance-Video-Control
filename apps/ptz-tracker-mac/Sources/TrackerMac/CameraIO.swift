import Foundation
import CoreImage
import CoreVideo
import TrackingCore

func trackerLog(_ message: String) {
    fputs("ptz-tracker  \(message)\n", stderr)
}

/// JPEG bytes to a BGRA buffer Vision can read. One context per camera, reused.
final class FrameConverter {
    private let context = CIContext()

    func makeBuffer(_ jpeg: Data) -> CVPixelBuffer? {
        guard let raw = CIImage(data: jpeg) else { return nil }
        let rect = raw.extent.integral
        let width = Int(rect.width)
        let height = Int(rect.height)
        guard width > 16, height > 16, width <= 3840, height <= 2160 else { return nil }
        let image = raw.transformed(by: CGAffineTransform(translationX: -rect.origin.x, y: -rect.origin.y))
        var buffer: CVPixelBuffer?
        let attrs: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ]
        let created = CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &buffer)
        guard created == kCVReturnSuccess, let buffer else { return nil }
        context.render(image, to: buffer, bounds: CGRect(x: 0, y: 0, width: width, height: height), colorSpace: CGColorSpaceCreateDeviceRGB())
        return buffer
    }
}

/// Pulls the MJPEG stream and keeps only the newest JPEG. A slow detector does not grow a queue.
final class MJPEGSource: NSObject, VideoSource, URLSessionDataDelegate {
    var onJPEG: ((Data) -> Void)?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private let parser = MJPEGParser()
    private var user = "admin"
    private var password = "12345"
    private let lock = NSLock()

    func configure(user: String, password: String) {
        lock.lock()
        self.user = user
        self.password = password
        lock.unlock()
    }

    func start(url: String) {
        stop()
        guard let target = URL(string: url) else {
            trackerLog("MJPEG URL is not usable: \(url)")
            return
        }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 60 * 60
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session
        parser.reset()
        var request = URLRequest(url: target)
        request.httpMethod = "GET"
        task = session.dataTask(with: request)
        task?.resume()
        trackerLog("MJPEG \(url)")
    }

    func stop() {
        task?.cancel()
        task = nil
        session?.invalidateAndCancel()
        session = nil
        parser.reset()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let http = response as? HTTPURLResponse, let type = http.value(forHTTPHeaderField: "Content-Type"), let boundary = MJPEG.boundary(from: type) {
            parser.boundary = boundary
        }
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            trackerLog("MJPEG HTTP \(http.statusCode)")
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let frames = parser.append(data)
        if let latest = frames.last { onJPEG?(latest) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error, (error as NSError).code != NSURLErrorCancelled {
            trackerLog("MJPEG ended: \(error.localizedDescription)")
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        answer(challenge, completionHandler: completionHandler)
    }

    private func answer(_ challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let method = challenge.protectionSpace.authenticationMethod
        let http = method == NSURLAuthenticationMethodHTTPBasic || method == NSURLAuthenticationMethodHTTPDigest || method == NSURLAuthenticationMethodDefault
        if http && challenge.previousFailureCount == 0 {
            lock.lock()
            let credential = URLCredential(user: user, password: password, persistence: .forSession)
            lock.unlock()
            completionHandler(.useCredential, credential)
            return
        }
        completionHandler(.performDefaultHandling, nil)
    }
}

/// Repeated JPEG snapshots, the `/cgi-bin/camera?resolution=640` path Control Center already uses.
/// One request at a time. A late frame is dropped rather than queued.
final class JPEGPollSource: NSObject, VideoSource, URLSessionTaskDelegate {
    var onJPEG: ((Data) -> Void)?
    private var session: URLSession?
    private var timer: DispatchSourceTimer?
    private var inflight = false
    private var urlString = ""
    private var user = "admin"
    private var password = "12345"
    private let lock = NSLock()

    func configure(user: String, password: String) {
        lock.lock()
        self.user = user
        self.password = password
        lock.unlock()
    }

    func start(url: String) {
        stop()
        urlString = url
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInitiated))
        timer.schedule(deadline: .now(), repeating: 1.0 / 12.0)
        timer.setEventHandler { [weak self] in self?.pull() }
        self.timer = timer
        timer.resume()
        trackerLog("JPEG poll \(url)")
    }

    func stop() {
        timer?.cancel()
        timer = nil
        session?.invalidateAndCancel()
        session = nil
        inflight = false
    }

    private func pull() {
        lock.lock()
        if inflight { lock.unlock(); return }
        inflight = true
        lock.unlock()
        guard let session, let url = URL(string: urlString) else {
            lock.lock()
            inflight = false
            lock.unlock()
            return
        }
        session.dataTask(with: URLRequest(url: url)) { [weak self] data, response, _ in
            guard let self else { return }
            if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), let data, data.count > 4 {
                self.onJPEG?(data)
            }
            self.lock.lock()
            self.inflight = false
            self.lock.unlock()
        }.resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let method = challenge.protectionSpace.authenticationMethod
        let http = method == NSURLAuthenticationMethodHTTPBasic || method == NSURLAuthenticationMethodHTTPDigest || method == NSURLAuthenticationMethodDefault
        if http && challenge.previousFailureCount == 0 {
            lock.lock()
            let credential = URLCredential(user: user, password: password, persistence: .forSession)
            lock.unlock()
            completionHandler(.useCredential, credential)
            return
        }
        completionHandler(.performDefaultHandling, nil)
    }
}

/// Sends the CGI commands the session produces. One request in flight, latest speed wins, 40 ms gap.
/// Login is URLSession's own Basic/Digest handling, with the same factory default as Control Center (`admin` / `12345`).
final class PanasonicClient: NSObject, CameraControlling, URLSessionTaskDelegate {
    private let commands = PtzCommandQueue(gap: 0.040)
    private var session: URLSession?
    private var origin = ""
    private var user = "admin"
    private var password = "12345"
    private var pumping = false
    private var drained: (() -> Void)?
    private let lock = NSLock()

    override init() {
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    func configure(_ endpoint: CameraEndpoint) {
        lock.lock()
        origin = "http://\(bracket(endpoint.host)):\(endpoint.port)"
        user = endpoint.user.isEmpty ? "admin" : endpoint.user
        password = endpoint.password
        lock.unlock()
    }

    func send(_ command: PtzCommand) {
        commands.submit(command)
        pump()
    }

    func stopAll() {
        send(Panasonic.stopPanTilt())
        send(Panasonic.stopZoom())
    }

    /// Quit and disconnect. Calls `done` once the stop commands have been written, or after a short wait.
    func stopAll(then done: @escaping () -> Void) {
        lock.lock()
        drained = done
        lock.unlock()
        stopAll()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.fireDrained()
        }
    }

    private func pump() {
        lock.lock()
        if pumping { lock.unlock(); return }
        guard let job = commands.take(now: Date().timeIntervalSince1970) else {
            pumping = false
            lock.unlock()
            fireDrained()
            return
        }
        pumping = true
        let origin = self.origin
        lock.unlock()
        guard !origin.isEmpty, let url = URL(string: origin + job.command.path), let session else {
            finishPump()
            return
        }
        session.dataTask(with: URLRequest(url: url)) { [weak self] data, response, error in
            if let error {
                trackerLog("camera \(job.command.code): \(error.localizedDescription)")
            } else if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                trackerLog("camera \(job.command.code): HTTP \(http.statusCode)")
            } else if let data, let body = String(data: data, encoding: .utf8), let refused = Panasonic.errorReply(body) {
                trackerLog("camera refused \(job.command.code) (\(refused))")
            }
            self?.finishPump()
        }.resume()
    }

    private func finishPump() {
        lock.lock()
        pumping = false
        commands.finish(now: Date().timeIntervalSince1970)
        lock.unlock()
        pump()
    }

    private func fireDrained() {
        lock.lock()
        let callback = (commands.depth == 0 && !pumping) ? drained : nil
        if callback != nil { drained = nil }
        lock.unlock()
        callback?()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let method = challenge.protectionSpace.authenticationMethod
        let http = method == NSURLAuthenticationMethodHTTPBasic || method == NSURLAuthenticationMethodHTTPDigest || method == NSURLAuthenticationMethodDefault
        if http && challenge.previousFailureCount == 0 {
            lock.lock()
            let credential = URLCredential(user: user, password: password, persistence: .forSession)
            lock.unlock()
            completionHandler(.useCredential, credential)
            return
        }
        completionHandler(.cancelAuthenticationChallenge, nil)
    }

    private func bracket(_ host: String) -> String {
        host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    }
}
