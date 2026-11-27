#if os(Linux)
import Glibc
#else
import Darwin
#endif
import Foundation
import XCTest
@testable import TrackingCore

/// A tiny AW-protocol stand-in. It records the CGI path and can refuse to answer or drop the connection.
final class AwMockServer {
    private var listenFD: Int32 = -1
    private var thread: Thread?
    private let lock = NSLock()
    private let stopped = DispatchSemaphore(value: 0)
    private var running = false
    private var hung: [Int32] = []
    private(set) var port: UInt16 = 0
    private var hits: [String] = []
    var silence = 0
    var reset = 0

    func start() throws {
        let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        if fd < 0 { throw URLError(.cannotConnectToHost) }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout.size(ofValue: yes)))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                bind(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if bound != 0 || listen(fd, 8) != 0 {
            close(fd)
            throw URLError(.cannotConnectToHost)
        }
        var got = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &got) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                getsockname(fd, sa, &length)
            }
        }
        if named != 0 {
            close(fd)
            throw URLError(.cannotConnectToHost)
        }
        listenFD = fd
        port = UInt16(bigEndian: got.sin_port)
        running = true
        let thread = Thread { [weak self] in
            self?.serve()
            self?.stopped.signal()
        }
        thread.start()
        self.thread = thread
    }

    func stop() {
        running = false
        if listenFD >= 0 {
            close(listenFD)
            listenFD = -1
        }
        lock.lock()
        let leftover = hung
        hung.removeAll()
        lock.unlock()
        for fd in leftover { close(fd) }
        _ = stopped.wait(timeout: .now() + 2)
    }

    func paths() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return hits
    }

    private func serve() {
        while running {
            var wait = pollfd(fd: listenFD, events: Int16(POLLIN), revents: 0)
            let ready = poll(&wait, 1, 50)
            if !running || listenFD < 0 { break }
            if ready <= 0 { continue }
            var clientAddr = sockaddr_in()
            var length = socklen_t(MemoryLayout<sockaddr_in>.size)
            let client = withUnsafeMutablePointer(to: &clientAddr) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                    accept(listenFD, sa, &length)
                }
            }
            if client < 0 { continue }
            handle(client)
        }
    }

    private func handle(_ client: Int32) {
        let request = readHead(client)
        let path = request.flatMap(pathOf) ?? ""
        lock.lock()
        if !path.isEmpty { hits.append(path) }
        let drop = reset > 0
        if drop { reset -= 1 }
        let hold = !drop && silence > 0
        if hold { silence -= 1 }
        if hold { hung.append(client) }
        lock.unlock()
        if hold { return }
        if drop {
            close(client)
            return
        }
        let body = "pTS5050"
        let response = "HTTP/1.1 200 OK\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
        _ = response.withCString { send(client, $0, strlen($0), 0) }
        close(client)
    }

    private func readHead(_ client: Int32) -> String? {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 1024)
        while buffer.count < 4096 {
            let n = read(client, &chunk, chunk.count)
            if n <= 0 { break }
            buffer.append(contentsOf: chunk.prefix(n))
            if buffer.range(of: Data("\r\n\r\n".utf8)) != nil { break }
        }
        return String(data: buffer, encoding: .utf8)
    }

    private func pathOf(_ head: String) -> String? {
        guard let line = head.split(separator: "\r\n").first else { return nil }
        let parts = line.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        return String(parts[1])
    }
}

enum AwHTTP {
    static func get(port: UInt16, path: String, timeoutMs: Int) -> String? {
        let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        if fd < 0 { return nil }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        let connected = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                connect(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if connected != 0 && errno != EINPROGRESS {
            return nil
        }
        var writeWait = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        if poll(&writeWait, 1, Int32(timeoutMs)) <= 0 { return nil }
        let request = "GET \(path) HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        _ = request.withCString { send(fd, $0, strlen($0), 0) }
        var readWait = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        if poll(&readWait, 1, Int32(timeoutMs)) <= 0 { return nil }
        var chunk = [UInt8](repeating: 0, count: 2048)
        let n = read(fd, &chunk, chunk.count)
        if n <= 0 { return nil }
        return String(bytes: chunk.prefix(n), encoding: .utf8)
    }
}

final class CameraServerTests: XCTestCase {
    func testTheMockCameraReceivesTheRealCGIAndAStopSkipsTheGap() throws {
        let server = AwMockServer()
        try server.start()
        defer { server.stop() }
        var link = CameraLink()
        link.submit(Panasonic.panTilt(pan: 7, tilt: 0))
        let move = try XCTUnwrap(link.poll(now: 1))
        let body = AwHTTP.get(port: server.port, path: move.path, timeoutMs: 500)
        XCTAssertTrue(body?.contains("200") == true)
        XCTAssertEqual(server.paths(), ["/cgi-bin/aw_ptz?cmd=%23PTS5750&res=1"])
        link.succeed(now: 1.005)
        link.submit(Panasonic.panTilt(pan: 11, tilt: 0))
        XCTAssertNil(link.poll(now: 1.02))
        XCTAssertEqual(server.paths().count, 1, "the speed inside the gap is not on the wire")
        link.submit(Panasonic.stopPanTilt())
        let stop = try XCTUnwrap(link.poll(now: 1.02))
        XCTAssertEqual(stop.code, "PTS5050")
        XCTAssertNotNil(AwHTTP.get(port: server.port, path: stop.path, timeoutMs: 500))
        XCTAssertEqual(server.paths().last, "/cgi-bin/aw_ptz?cmd=%23PTS5050&res=1")
    }

    func testATimeoutThenADroppedConnectionBothEndInAStop() throws {
        let server = AwMockServer()
        try server.start()
        defer { server.stop() }
        var link = CameraLink(timeout: 0.05, stopRetries: 1, backoffs: [0.05])
        server.silence = 1
        link.submit(Panasonic.panTilt(pan: 8, tilt: 1))
        let move = try XCTUnwrap(link.poll(now: 0))
        XCTAssertNil(AwHTTP.get(port: server.port, path: move.path, timeoutMs: 80), "the camera never answered")
        XCTAssertTrue(link.timedOut(now: 0.05))
        XCTAssertEqual(link.fail(now: 0.08), 0)
        let stop = try XCTUnwrap(link.poll(now: 0.08))
        XCTAssertEqual(stop.code, "PTS5050")
        server.silence = 0
        XCTAssertNotNil(AwHTTP.get(port: server.port, path: stop.path, timeoutMs: 500))
        link.succeed(now: 0.1)

        server.reset = 1
        link.submit(Panasonic.zoom(5))
        let zoom = try XCTUnwrap(link.poll(now: 0.2))
        XCTAssertEqual(zoom.code, "Z55")
        XCTAssertNil(AwHTTP.get(port: server.port, path: zoom.path, timeoutMs: 500), "the camera closed the connection")
        XCTAssertEqual(server.paths().last, "/cgi-bin/aw_ptz?cmd=%23Z55&res=1")
        XCTAssertEqual(link.fail(now: 0.21), 0)
        XCTAssertEqual(link.poll(now: 0.21)?.code, "Z50", "a lost zoom is stopped")
    }
}
