import Foundation
import CoreVideo
import Vision
import TrackingCore

/// Apple Vision on the Neural Engine. Body rectangles or face rectangles, then `VNTrackObjectRequest`
/// between full passes. The default request revision is left alone so Vision can pick the Neural Engine.
///
/// Vision's box origin is the bottom-left. Detections handed to the core are top-left, matching the web overlay.
final class VisionDetector: Detecting {
    private let lock = NSLock()
    private var buffer: CVPixelBuffer?
    private var tracked: [VNDetectedObjectObservation] = []
    private let sequence = VNSequenceRequestHandler()
    private(set) var needsFullPass = false

    func setFrame(_ buffer: CVPixelBuffer) {
        lock.lock()
        self.buffer = buffer
        lock.unlock()
    }

    func reset() {
        lock.lock()
        buffer = nil
        tracked = []
        needsFullPass = false
        lock.unlock()
    }

    func detections(mode: DetectMode, fullPass: Bool) -> [Detection] {
        lock.lock()
        let buffer = self.buffer
        let previous = tracked
        lock.unlock()
        guard let buffer else { return [] }
        if fullPass || previous.isEmpty || needsFullPass {
            return detect(in: buffer, mode: mode)
        }
        return track(in: buffer, previous: previous, mode: mode)
    }

    private func detect(in buffer: CVPixelBuffer, mode: DetectMode) -> [Detection] {
        let request: VNImageBasedRequest
        if mode == .face {
            request = VNDetectFaceRectanglesRequest()
        } else {
            let human = VNDetectHumanRectanglesRequest()
            human.upperBodyOnly = false
            request = human
        }
        let handler = VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .up, options: [:])
        do {
            try handler.perform([request])
        } catch {
            trackerLog("Vision detect: \(error.localizedDescription)")
            return []
        }
        let observations = (request.results ?? []).compactMap { $0 as? VNDetectedObjectObservation }
        lock.lock()
        tracked = observations
        needsFullPass = false
        lock.unlock()
        return observations.map { detection($0, kind: mode) }
    }

    private func track(in buffer: CVPixelBuffer, previous: [VNDetectedObjectObservation], mode: DetectMode) -> [Detection] {
        let requests = previous.map { observation -> VNTrackObjectRequest in
            let request = VNTrackObjectRequest(detectedObjectObservation: observation)
            request.trackingLevel = .accurate
            return request
        }
        do {
            try sequence.perform(requests, on: buffer, orientation: .up)
        } catch {
            trackerLog("Vision track: \(error.localizedDescription)")
            lock.lock()
            needsFullPass = true
            lock.unlock()
            return []
        }
        var next: [VNDetectedObjectObservation] = []
        var weak = false
        for request in requests {
            guard let observation = request.results?.first as? VNDetectedObjectObservation else {
                weak = true
                continue
            }
            if observation.confidence < 0.35 {
                weak = true
                continue
            }
            next.append(observation)
        }
        lock.lock()
        tracked = next
        if weak { needsFullPass = true }
        lock.unlock()
        return next.map { detection($0, kind: mode) }
    }

    private func detection(_ observation: VNDetectedObjectObservation, kind: DetectMode) -> Detection {
        let box = observation.boundingBox
        let height = Double(box.height)
        let topLeft = NormBox(
            x: Double(box.origin.x),
            y: Double(1 - box.origin.y - box.height),
            w: Double(box.width),
            h: height
        )
        return Detection(box: topLeft, confidence: Double(observation.confidence), kind: kind)
    }
}
