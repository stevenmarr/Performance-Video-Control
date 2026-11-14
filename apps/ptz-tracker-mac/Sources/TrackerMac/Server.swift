import Foundation
import Network
import TrackingCore

/// One TCP port. `GET /health` and `GET /status` answer JSON. Anything with `Upgrade: websocket`
/// becomes the control channel. Control Center is the client; the browser never connects here.
final class ControlServer {
    private let port: UInt16
    private let queue: DispatchQueue
    private var listener: NWListener?
    private var clients: [ObjectIdentifier: Client] = [:]
    var onMessage: ((TrackerMessage, @escaping (TrackerMessage) -> Void) -> Void)?
    var health: () -> HealthReport = { HealthReport(ok: true, cameras: []) }
    private(set) var listening = "starting"

    init(port: UInt16, queue: DispatchQueue) {
        self.port = port
        self.queue = queue
    }

    func start() {
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            guard let endpoint = NWEndpoint.Port(rawValue: port) else {
                listening = "bad port \(port)"
                return
            }
            let listener = try NWListener(using: params, on: endpoint)
            listener.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            listener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    self?.listening = "listening on port \(self?.port ?? 0)"
                case .failed(let error):
                    self?.listening = "not listening: \(error.localizedDescription)"
                default:
                    break
                }
            }
            listener.start(queue: queue)
            self.listener = listener
        } catch {
            listening = "not listening: \(error.localizedDescription)"
        }
    }

    func broadcast(_ message: TrackerMessage) {
        guard let data = try? ProtocolCodec.encode(message), let text = String(data: data, encoding: .utf8) else { return }
        for client in clients.values where client.open { client.send(text: text) }
    }

    func stop() {
        listener?.cancel()
        for client in clients.values { client.close() }
        clients.removeAll()
    }

    private func accept(_ connection: NWConnection) {
        let client = Client(connection: connection, queue: queue)
        clients[ObjectIdentifier(client)] = client
        client.onText = { [weak self, weak client] text in
            guard let self, let client else { return }
            self.onMessage?(self.decode(text)) { reply in
                if let encoded = try? ProtocolCodec.encodeString(reply) { client.send(text: encoded) }
            }
        }
        client.onHTTP = { [weak self] request in
            guard let self else { return nil }
            if request.method == "GET" && (request.path == "/health" || request.path == "/status" || request.path == "/") {
                let body = (try? JSONEncoder().encode(self.health())) ?? Data("{}".utf8)
                let json = String(data: body, encoding: .utf8) ?? "{}"
                return WebSocketHandshake.jsonResponse(status: 200, reason: "OK", body: json)
            }
            return nil
        }
        client.onClose = { [weak self, weak client] in
            guard let client else { return }
            self?.clients.removeValue(forKey: ObjectIdentifier(client))
        }
        connection.start(queue: queue)
        client.receive()
    }

    private func decode(_ text: String) -> TrackerMessage {
        do {
            return try ProtocolCodec.decode(Data(text.utf8))
        } catch ProtocolDecodeError.unsupportedVersion(let version) {
            return ProtocolCodec.error(code: "unsupported_version", message: "This tracker speaks protocol 1 (got \(version)).")
        } catch ProtocolDecodeError.unknownType(let type) {
            return ProtocolCodec.error(code: "bad_type", message: "Unknown message type \(type).")
        } catch {
            return ProtocolCodec.error(code: "bad_json", message: "That message is not valid JSON.")
        }
    }
}

private final class Client {
    let connection: NWConnection
    let queue: DispatchQueue
    var onText: ((String) -> Void)?
    var onHTTP: ((HTTPRequest) -> String?)?
    var onClose: (() -> Void)?
    private(set) var open = false
    private var buffer = Data()
    private var upgraded = false

    init(connection: NWConnection, queue: DispatchQueue) {
        self.connection = connection
        self.queue = queue
    }

    func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty { self.consume(data) }
            if error != nil || isComplete {
                self.close()
                return
            }
            self.receive()
        }
    }

    func send(text: String) {
        let frame = WebSocketCodec.encode(text: text, masked: false)
        connection.send(content: frame, completion: .contentProcessed { _ in })
    }

    func close() {
        if connection.state != .cancelled { connection.cancel() }
        onClose?()
        onClose = nil
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        if !upgraded {
            guard let text = String(data: buffer, encoding: .utf8), text.contains("\r\n\r\n") else { return }
            guard let request = WebSocketHandshake.parseRequest(text) else {
                close()
                return
            }
            if request.isWebSocketUpgrade, let key = request.webSocketKey {
                let response = Data(WebSocketHandshake.upgradeResponse(key: key).utf8)
                connection.send(content: response, completion: .contentProcessed { _ in })
                upgraded = true
                open = true
                if let range = buffer.range(of: Data("\r\n\r\n".utf8)) {
                    buffer.removeSubrange(buffer.startIndex..<range.upperBound)
                } else {
                    buffer.removeAll()
                }
            } else if let http = onHTTP?(request) {
                connection.send(content: Data(http.utf8), completion: .contentProcessed { [weak self] _ in
                    self?.close()
                })
                return
            } else {
                let missing = WebSocketHandshake.jsonResponse(status: 404, reason: "Not Found", body: "{\"ok\":false}")
                connection.send(content: Data(missing.utf8), completion: .contentProcessed { [weak self] _ in self?.close() })
                return
            }
        }
        let frames = WebSocketCodec.drain(&buffer)
        for frame in frames {
            switch frame.opcode {
            case .text:
                if let text = frame.text { onText?(text) }
            case .ping:
                let pong = WebSocketCodec.encode(opcode: .pong, payload: frame.payload, masked: false)
                connection.send(content: pong, completion: .contentProcessed { _ in })
            case .close:
                close()
                return
            default:
                break
            }
        }
    }
}
