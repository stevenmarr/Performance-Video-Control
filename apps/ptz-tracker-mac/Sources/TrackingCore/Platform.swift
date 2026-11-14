import Foundation

/// The menu-bar app implements these. The core never imports Vision, AppKit or Network.
/// A frame stays inside the app: the detector reads the latest pixel buffer it was handed,
/// and `TrackingSession.tick` only ever sees boxes.

public protocol Detecting: AnyObject {
    func reset()
    /// Set when an inter-frame track lost confidence and the next pass should be a full detection.
    var needsFullPass: Bool { get }
    func detections(mode: DetectMode, fullPass: Bool) -> [Detection]
}

public protocol VideoSource: AnyObject {
    func start(url: String)
    func stop()
}

public protocol CameraControlling: AnyObject {
    func send(_ command: PtzCommand)
    func stopAll()
}
