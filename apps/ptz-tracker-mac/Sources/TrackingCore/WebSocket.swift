import Foundation

public struct HTTPRequest: Equatable, Sendable {
    public var method: String
    public var path: String
    public var headers: [String: String]

    public init(method: String, path: String, headers: [String: String]) {
        self.method = method
        self.path = path
        self.headers = headers
    }

    public var isWebSocketUpgrade: Bool {
        (headers["upgrade"] ?? "").lowercased() == "websocket"
            && (headers["connection"] ?? "").lowercased().contains("upgrade")
    }

    public var webSocketKey: String? { headers["sec-websocket-key"] }
}

public enum WebSocketHandshake {
    public static let guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    /// RFC 6455 section 1.3. The sample key `dGhlIHNhbXBsZSBub25jZQ==` accepts as `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`.
    public static func accept(for key: String) -> String {
        Data(SHA1.hash(Data((key + guid).utf8))).base64EncodedString()
    }

    public static func upgradeResponse(key: String) -> String {
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept(for: key))\r\n\r\n"
    }

    public static func jsonResponse(status: Int, reason: String, body: String) -> String {
        let length = Data(body.utf8).count
        return "HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(length)\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n\(body)"
    }

    /// Parses one HTTP/1.1 request head. Header names are lowercased. Returns nil until the head is complete,
    /// and nil when the bytes are not an HTTP request.
    public static func parseRequest(_ raw: String) -> HTTPRequest? {
        guard let split = raw.range(of: "\r\n\r\n") else { return nil }
        let head = raw[..<split.lowerBound]
        var lines = head.split(separator: "\r\n", omittingEmptySubsequences: false).map(String.init)
        guard let first = lines.first else { return nil }
        let parts = first.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        lines.removeFirst()
        var headers: [String: String] = [:]
        for line in lines where line.contains(":") {
            let pair = line.split(separator: ":", maxSplits: 1).map(String.init)
            headers[pair[0].trimmingCharacters(in: .whitespaces).lowercased()] = pair[1].trimmingCharacters(in: .whitespaces)
        }
        return HTTPRequest(method: String(parts[0]), path: String(parts[1]), headers: headers)
    }
}

public struct WSFrame: Equatable, Sendable {
    public enum Opcode: Int, Sendable {
        case continuation = 0
        case text = 1
        case binary = 2
        case close = 8
        case ping = 9
        case pong = 10
    }

    public var fin: Bool
    public var opcode: Opcode
    public var payload: Data

    public init(fin: Bool = true, opcode: Opcode, payload: Data) {
        self.fin = fin
        self.opcode = opcode
        self.payload = payload
    }

    public var text: String? {
        opcode == .text ? String(data: payload, encoding: .utf8) : nil
    }
}

public enum WebSocketCodec {
    public static let maxPayload = 1_048_576

    public static func encode(text: String, masked: Bool, maskKey: [UInt8]? = nil) -> Data {
        encode(opcode: .text, payload: Data(text.utf8), masked: masked, maskKey: maskKey)
    }

    public static func encode(opcode: WSFrame.Opcode, payload: Data, masked: Bool, maskKey: [UInt8]? = nil) -> Data {
        var header = Data()
        header.append(0x80 | UInt8(opcode.rawValue))
        let length = payload.count
        let maskBit: UInt8 = masked ? 0x80 : 0
        if length < 126 {
            header.append(maskBit | UInt8(length))
        } else if length < 65536 {
            header.append(maskBit | 126)
            header.append(UInt8((length >> 8) & 0xff))
            header.append(UInt8(length & 0xff))
        } else {
            header.append(maskBit | 127)
            for shift in stride(from: 56, through: 0, by: -8) {
                header.append(UInt8((length >> shift) & 0xff))
            }
        }
        var body = payload
        if masked {
            var key = maskKey ?? [0, 0, 0, 0]
            if maskKey == nil {
                key = (0..<4).map { _ in UInt8.random(in: 0...255) }
            }
            header.append(contentsOf: key)
            var bytes = [UInt8](body)
            for i in bytes.indices { bytes[i] ^= key[i % 4] }
            body = Data(bytes)
        }
        header.append(body)
        return header
    }

    /// Pulls every complete frame out of `buffer` and leaves the unparsed tail.
    /// A frame that claims more than `maxPayload` bytes is dropped and the buffer cleared; the caller sees `.close`.
    public static func drain(_ buffer: inout Data) -> [WSFrame] {
        var frames: [WSFrame] = []
        while true {
            if buffer.count < 2 { break }
            let b0 = buffer[buffer.startIndex]
            let b1 = buffer[buffer.startIndex + 1]
            let fin = (b0 & 0x80) != 0
            guard let opcode = WSFrame.Opcode(rawValue: Int(b0 & 0x0f)) else {
                buffer.removeAll()
                frames.append(WSFrame(opcode: .close, payload: Data()))
                break
            }
            let masked = (b1 & 0x80) != 0
            var length = Int(b1 & 0x7f)
            var offset = 2
            if length == 126 {
                if buffer.count < 4 { break }
                length = (Int(buffer[buffer.startIndex + 2]) << 8) | Int(buffer[buffer.startIndex + 3])
                offset = 4
            } else if length == 127 {
                if buffer.count < 10 { break }
                var big: UInt64 = 0
                for i in 0..<8 {
                    big = (big << 8) | UInt64(buffer[buffer.startIndex + 2 + i])
                }
                if big > UInt64(maxPayload) {
                    buffer.removeAll()
                    frames.append(WSFrame(opcode: .close, payload: Data()))
                    break
                }
                length = Int(big)
                offset = 10
            }
            if length > maxPayload || length < 0 {
                buffer.removeAll()
                frames.append(WSFrame(opcode: .close, payload: Data()))
                break
            }
            let maskLength = masked ? 4 : 0
            if buffer.count < offset + maskLength + length { break }
            let maskStart = buffer.startIndex + offset
            var payload = Data(buffer[(maskStart + maskLength)..<(maskStart + maskLength + length)])
            if masked {
                let mask = [UInt8](buffer[maskStart..<(maskStart + 4)])
                var bytes = [UInt8](payload)
                for i in bytes.indices { bytes[i] ^= mask[i % 4] }
                payload = Data(bytes)
            }
            buffer.removeSubrange(buffer.startIndex..<(maskStart + maskLength + length))
            frames.append(WSFrame(fin: fin, opcode: opcode, payload: payload))
        }
        return frames
    }
}

/// Splits a Panasonic multipart MJPEG body into JPEG blobs. Bytes that are not yet a whole frame stay buffered.
public final class MJPEGParser: @unchecked Sendable {
    public var boundary: String?
    private var buffer = Data()

    public init() {}

    public func reset() { buffer.removeAll() }

    public func append(_ chunk: Data) -> [Data] {
        buffer.append(chunk)
        if buffer.count > 2_000_000 { buffer.removeFirst(buffer.count - 65_536) }
        guard let boundary, !boundary.isEmpty else { return [] }
        let marker = Data("--\(boundary)".utf8)
        var frames: [Data] = []
        while true {
            guard let start = buffer.range(of: marker) else {
                if buffer.count > marker.count { buffer.removeFirst(buffer.count - marker.count) }
                break
            }
            if start.lowerBound > buffer.startIndex {
                buffer.removeSubrange(buffer.startIndex..<start.lowerBound)
            }
            let after = buffer.index(start.lowerBound, offsetBy: marker.count)
            guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8), in: after..<buffer.endIndex) else { break }
            let header = String(data: buffer[after..<headerEnd.lowerBound], encoding: .utf8) ?? ""
            let bodyStart = headerEnd.upperBound
            if let length = contentLength(header) {
                if buffer.distance(from: bodyStart, to: buffer.endIndex) < length { break }
                let bodyEnd = buffer.index(bodyStart, offsetBy: length)
                frames.append(Data(buffer[bodyStart..<bodyEnd]))
                buffer.removeSubrange(buffer.startIndex..<bodyEnd)
                continue
            }
            guard let next = buffer.range(of: marker, in: bodyStart..<buffer.endIndex) else { break }
            var bodyEnd = next.lowerBound
            if bodyEnd >= buffer.index(buffer.startIndex, offsetBy: 2),
               buffer[buffer.index(bodyEnd, offsetBy: -2)] == 13,
               buffer[buffer.index(bodyEnd, offsetBy: -1)] == 10 {
                bodyEnd = buffer.index(bodyEnd, offsetBy: -2)
            }
            if bodyEnd > bodyStart { frames.append(Data(buffer[bodyStart..<bodyEnd])) }
            buffer.removeSubrange(buffer.startIndex..<next.lowerBound)
        }
        return frames.filter(isJPEG)
    }

    private func contentLength(_ header: String) -> Int? {
        for line in header.split(separator: "\r\n") {
            let parts = line.split(separator: ":", maxSplits: 1).map(String.init)
            if parts.count == 2 && parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
                return Int(parts[1].trimmingCharacters(in: .whitespaces))
            }
        }
        return nil
    }

    private func isJPEG(_ data: Data) -> Bool {
        data.count >= 4 && data[data.startIndex] == 0xFF && data[data.startIndex + 1] == 0xD8
    }
}

public enum MJPEG {
    /// `multipart/x-mixed-replace; boundary=frame` → `frame`.
    public static func boundary(from contentType: String) -> String? {
        let parts = contentType.split(separator: ";")
        for part in parts {
            let pair = part.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if pair.count == 2 && pair[0].lowercased() == "boundary" {
                var value = pair[1]
                if value.hasPrefix("\""), value.hasSuffix("\""), value.count >= 2 {
                    value = String(value.dropFirst().dropLast())
                }
                return value.isEmpty ? nil : value
            }
        }
        return nil
    }
}
