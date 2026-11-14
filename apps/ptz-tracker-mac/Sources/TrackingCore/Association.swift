import Foundation

public struct Detection: Equatable, Sendable {
    public var id: String?
    public var box: NormBox
    public var confidence: Double
    public var kind: DetectMode

    public init(id: String? = nil, box: NormBox, confidence: Double, kind: DetectMode) {
        self.id = id
        self.box = box
        self.confidence = confidence
        self.kind = kind
    }
}

public struct Track: Equatable, Sendable {
    public var id: String
    public var box: NormBox
    public var confidence: Double
    public var vx: Double
    public var vy: Double
    public var missing: Int
    public var age: Int
    public var kind: DetectMode
    public var lastSeen: Double

    public init(id: String, box: NormBox, confidence: Double, vx: Double = 0, vy: Double = 0, missing: Int = 0, age: Int = 1, kind: DetectMode, lastSeen: Double) {
        self.id = id
        self.box = box
        self.confidence = confidence
        self.vx = vx
        self.vy = vy
        self.missing = missing
        self.age = age
        self.kind = kind
        self.lastSeen = lastSeen
    }
}

/// Keeps one id on one person across frames, including a brief overlap with somebody else.
///
/// The cost prefers the box the track was already heading toward. When two people cross, the implied
/// velocity of the wrong box disagrees with the track, so the ids do not swap. A detector id, when the
/// platform has one, is a hint, not a licence to jump across the frame.
public final class Associator: @unchecked Sendable {
    public private(set) var tracks: [Track] = []
    public var gate: Double
    public var maxMissing: Int
    private var nextSerial = 1

    public init(gate: Double = 0.35, maxMissing: Int = 15) {
        self.gate = gate
        self.maxMissing = maxMissing
    }

    public func reset() {
        tracks = []
        nextSerial = 1
    }

    public func update(_ detections: [Detection], time: Double) -> [Track] {
        let dt = sampleInterval(to: time)
        var pairs: [(Double, Int, Int)] = []
        for ti in tracks.indices {
            for di in detections.indices {
                let cost = matchCost(tracks[ti], detections[di], dt: dt)
                if cost < 50 { pairs.append((cost, ti, di)) }
            }
        }
        pairs.sort { $0.0 < $1.0 }
        var usedT = Set<Int>()
        var usedD = Set<Int>()
        var assigned: [Int: Int] = [:]
        for (cost, ti, di) in pairs where cost < 50 {
            if usedT.contains(ti) || usedD.contains(di) { continue }
            usedT.insert(ti)
            usedD.insert(di)
            assigned[ti] = di
        }
        var next: [Track] = []
        for ti in tracks.indices {
            var track = tracks[ti]
            if let di = assigned[ti] {
                let det = detections[di]
                let elapsed = max(1e-3, time - track.lastSeen)
                let instVx = (det.box.centerX - track.box.centerX) / elapsed
                let instVy = (det.box.centerY - track.box.centerY) / elapsed
                track.vx = track.vx * 0.55 + instVx * 0.45
                track.vy = track.vy * 0.55 + instVy * 0.45
                track.box = det.box
                track.confidence = det.confidence
                track.kind = det.kind
                track.missing = 0
                track.age += 1
                track.lastSeen = time
                next.append(track)
            } else {
                track.missing += 1
                track.age += 1
                if track.missing <= maxMissing { next.append(track) }
            }
        }
        for di in detections.indices where !usedD.contains(di) {
            next.append(makeTrack(detections[di], time: time))
        }
        tracks = next
        return tracks
    }

    private func sampleInterval(to time: Double) -> Double {
        guard let last = tracks.map(\.lastSeen).max() else { return 1.0 / 15.0 }
        return min(0.5, max(1.0 / 60.0, time - last))
    }

    private func matchCost(_ track: Track, _ det: Detection, dt: Double) -> Double {
        let predX = track.box.centerX + track.vx * dt
        let predY = track.box.centerY + track.vy * dt
        let dx = predX - det.box.centerX
        let dy = predY - det.box.centerY
        let dist = (dx * dx + dy * dy).squareRoot()
        let pred = track.box.offset(dx: track.vx * dt, dy: track.vy * dt)
        let overlap = pred.iou(det.box)
        if dist > gate && overlap < 0.1 { return 100 }
        let elapsed = max(1e-3, dt)
        let impliedVx = (det.box.centerX - track.box.centerX) / elapsed
        let impliedVy = (det.box.centerY - track.box.centerY) / elapsed
        let velocityError = abs(impliedVx - track.vx) + abs(impliedVy - track.vy)
        var cost = dist + velocityError * 0.12 + (1 - overlap) * 0.08
        if let id = det.id, id == track.id { cost *= 0.25 }
        return cost
    }

    private func makeTrack(_ det: Detection, time: Double) -> Track {
        let id: String
        if let hinted = det.id, !tracks.contains(where: { $0.id == hinted }) {
            id = hinted
        } else {
            id = "t\(nextSerial)"
            nextSerial += 1
        }
        return Track(id: id, box: det.box, confidence: det.confidence, kind: det.kind, lastSeen: time)
    }
}
