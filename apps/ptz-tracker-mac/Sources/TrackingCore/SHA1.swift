import Foundation

/// SHA-1 for the WebSocket accept key (RFC 6455). Not a general hash API.
enum SHA1 {
    static func hash(_ data: Data) -> [UInt8] {
        var message = [UInt8](data)
        let bitCount = UInt64(message.count) * 8
        message.append(0x80)
        while message.count % 64 != 56 { message.append(0) }
        for shift in stride(from: 56, through: 0, by: -8) {
            message.append(UInt8((bitCount >> shift) & 0xff))
        }
        var h0: UInt32 = 0x67452301
        var h1: UInt32 = 0xEFCDAB89
        var h2: UInt32 = 0x98BADCFE
        var h3: UInt32 = 0x10325476
        var h4: UInt32 = 0xC3D2E1F0
        var offset = 0
        while offset < message.count {
            var w = [UInt32](repeating: 0, count: 80)
            for i in 0..<16 {
                let j = offset + i * 4
                w[i] = (UInt32(message[j]) << 24) | (UInt32(message[j + 1]) << 16) | (UInt32(message[j + 2]) << 8) | UInt32(message[j + 3])
            }
            for i in 16..<80 {
                let mixed = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
                w[i] = (mixed << 1) | (mixed >> 31)
            }
            var a = h0, b = h1, c = h2, d = h3, e = h4
            for i in 0..<80 {
                let f: UInt32
                let k: UInt32
                switch i {
                case 0..<20:
                    f = (b & c) | (~b & d)
                    k = 0x5A827999
                case 20..<40:
                    f = b ^ c ^ d
                    k = 0x6ED9EBA1
                case 40..<60:
                    f = (b & c) | (b & d) | (c & d)
                    k = 0x8F1BBCDC
                default:
                    f = b ^ c ^ d
                    k = 0xCA62C1D6
                }
                let temp = rotl(a, 5) &+ f &+ e &+ k &+ w[i]
                e = d
                d = c
                c = rotl(b, 30)
                b = a
                a = temp
            }
            h0 = h0 &+ a
            h1 = h1 &+ b
            h2 = h2 &+ c
            h3 = h3 &+ d
            h4 = h4 &+ e
            offset += 64
        }
        var out: [UInt8] = []
        out.reserveCapacity(20)
        for word in [h0, h1, h2, h3, h4] {
            out.append(UInt8((word >> 24) & 0xff))
            out.append(UInt8((word >> 16) & 0xff))
            out.append(UInt8((word >> 8) & 0xff))
            out.append(UInt8(word & 0xff))
        }
        return out
    }

    private static func rotl(_ value: UInt32, _ count: UInt32) -> UInt32 {
        (value << count) | (value >> (32 - count))
    }
}
