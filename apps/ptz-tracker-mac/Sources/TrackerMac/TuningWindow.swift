import AppKit
import TrackingCore

/// The same reaction controls as PTZ → TRACKING. A change is sent back to Control Center,
/// which stores it, so the page and this window stay on one set of numbers.
/// This file has not been compiled here.
final class TuningWindow: NSObject {
    private let runtime: TrackerRuntime
    private var window: NSWindow?
    private var cameraId: String?
    private var base = TrackingSettings()
    private var touched = Date.distantPast
    private var timer: Timer?
    private let feel = NSPopUpButton()
    private let readout = NSTextField(labelWithString: "Pan 0   Tilt 0   Zoom 0")
    private var sliders: [String: NSSlider] = [:]
    private var valueLabels: [String: NSTextField] = [:]

    init(runtime: TrackerRuntime) {
        self.runtime = runtime
    }

    func show() {
        if window == nil { build() }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in self?.refresh() }
        }
        refresh()
    }

    private func build() {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)

        let title = NSTextField(labelWithString: "Tracking feel")
        title.font = NSFont.boldSystemFont(ofSize: 15)
        stack.addArrangedSubview(title)
        readout.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        readout.lineBreakMode = .byWordWrapping
        readout.maximumNumberOfLines = 3
        stack.addArrangedSubview(readout)

        feel.addItems(withTitles: ["Slow / Lecture", "Medium", "Fast / Sports", "Custom"])
        feel.target = self
        feel.action = #selector(feelChanged)
        stack.addArrangedSubview(labeled("Reaction preset", feel))

        addSlider(stack, key: "deadX", title: "Dead zone, pan", unit: "% of the picture", min: 0, max: 40, scale: 100)
        addSlider(stack, key: "confidence", title: "Confidence", unit: "%", min: 0, max: 100, scale: 100)
        addSlider(stack, key: "minSubject", title: "Smallest subject", unit: "% of the picture height", min: 0, max: 80, scale: 100)
        addSlider(stack, key: "lost", title: "Hold after a loss", unit: "ms", min: 0, max: 10000, scale: 1)
        addSlider(stack, key: "latency", title: "Delay before the aim leads", unit: "ms", min: 0, max: 2000, scale: 1)
        addSlider(stack, key: "pan", title: "Pan speed cap", unit: "camera speed 1–49", min: 1, max: 49, scale: 1)
        addSlider(stack, key: "tilt", title: "Tilt speed cap", unit: "camera speed 1–49", min: 1, max: 49, scale: 1)
        addSlider(stack, key: "zoom", title: "Zoom speed cap", unit: "camera speed 1–49", min: 1, max: 49, scale: 1)
        addSlider(stack, key: "accel", title: "Pan acceleration", unit: "counts per second", min: 1, max: 500, scale: 1)
        addSlider(stack, key: "decel", title: "Pan deceleration", unit: "counts per second", min: 1, max: 500, scale: 1)
        addSlider(stack, key: "smooth", title: "Smoothing", unit: "0 snaps, 1 eases", min: 0, max: 1, scale: 1)
        addSlider(stack, key: "jitter", title: "Jitter filter", unit: "0 raw, 1 heavy", min: 0, max: 0.95, scale: 1)

        let reset = NSButton(title: "Reset to Medium", target: self, action: #selector(resetFeel))
        stack.addArrangedSubview(reset)
        let note = NSTextField(wrappingLabelWithString: "Speeds are the Panasonic scale, 1 to 49. Changes apply while tracking is running and are saved by Control Center.")
        note.preferredMaxLayoutWidth = 360
        stack.addArrangedSubview(note)

        let host = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 640))
        host.addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            stack.topAnchor.constraint(equalTo: host.topAnchor),
        ])
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 680), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        win.title = "PTZ tracking"
        win.contentView = host
        win.center()
        window = win
    }

    private func labeled(_ title: String, _ control: NSView) -> NSView {
        let label = NSTextField(labelWithString: title)
        label.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        let row = NSStackView(views: [label, control])
        row.orientation = .vertical
        row.alignment = .leading
        return row
    }

    private func addSlider(_ stack: NSStackView, key: String, title: String, unit: String, min: Double, max: Double, scale: Double) {
        let slider = NSSlider(value: min, minValue: min, maxValue: max, target: self, action: #selector(sliderMoved(_:)))
        slider.isContinuous = true
        slider.tag = sliders.count
        sliders[key] = slider
        let value = NSTextField(labelWithString: unit)
        value.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        valueLabels[key] = value
        let row = NSStackView(views: [slider, value])
        row.orientation = .horizontal
        slider.widthAnchor.constraint(equalToConstant: 220).isActive = true
        stack.addArrangedSubview(labeled("\(title) — \(unit)", row))
        _ = scale
    }

    @objc private func feelChanged() {
        let choice: Feel = [Feel.lecture, .medium, .sports, .custom][feel.indexOfSelectedItem]
        let next = FeelLibrary.apply(choice, to: base)
        commit(next)
    }

    @objc private func resetFeel() {
        commit(FeelLibrary.apply(.medium, to: base))
    }

    @objc private func sliderMoved(_ sender: NSSlider) {
        guard cameraId != nil else { return }
        var next = base
        next.feel = .custom
        next.deadZone.x = (sliders["deadX"]?.doubleValue ?? 4.5) / 100
        next.deadZone.y = next.deadZone.x
        next.minConfidence = (sliders["confidence"]?.doubleValue ?? 40) / 100
        next.minSubject = (sliders["minSubject"]?.doubleValue ?? 8) / 100
        next.lostHoldMs = sliders["lost"]?.doubleValue ?? 1200
        next.latencyMs = sliders["latency"]?.doubleValue ?? 180
        next.maxSpeed.pan = sliders["pan"]?.doubleValue ?? 18
        next.maxSpeed.tilt = sliders["tilt"]?.doubleValue ?? 14
        next.maxSpeed.zoom = sliders["zoom"]?.doubleValue ?? 8
        next.maxAccel.pan = sliders["accel"]?.doubleValue ?? 70
        next.maxDecel = AxisLimits(pan: sliders["decel"]?.doubleValue ?? 90, tilt: next.resolvedDecel.tilt, zoom: next.resolvedDecel.zoom)
        let smooth = sliders["smooth"]?.doubleValue ?? 0.45
        next.smoothing = smooth
        next.axisSmoothing = AxisLimits(pan: smooth, tilt: smooth, zoom: smooth)
        next.jitter = sliders["jitter"]?.doubleValue ?? 0.35
        commit(next)
        _ = sender
    }

    private func commit(_ settings: TrackingSettings) {
        guard let cameraId else { return }
        touched = Date()
        base = settings
        runtime.applyLocal(cameraId: cameraId, settings: settings)
        showValues(settings)
    }

    private func refresh() {
        runtime.readTuning { [weak self] rows in
            guard let self else { return }
            guard let row = rows.first(where: { $0.cameraId == self.cameraId }) ?? rows.first else {
                self.readout.stringValue = "No camera yet. Start one from Control Center, then open this again."
                return
            }
            self.cameraId = row.cameraId
            let speed = { (n: Double) -> String in let v = Int(n.rounded()); return v > 0 ? "+\(v)" : "\(v)" }
            self.readout.stringValue = "\(row.cameraId)  \(row.phase.rawValue)\nPan \(speed(row.pan))   Tilt \(speed(row.tilt))   Zoom \(speed(row.zoom))\ncamera speed, −49 to +49, 0 is stop"
            if Date().timeIntervalSince(self.touched) < 0.6 { return }
            self.base = row.settings
            self.showValues(row.settings)
            let index = [Feel.lecture, .medium, .sports, .custom].firstIndex(of: row.settings.feel ?? .custom) ?? 3
            self.feel.selectItem(at: index)
        }
    }

    private func showValues(_ settings: TrackingSettings) {
        sliders["deadX"]?.doubleValue = settings.deadZone.x * 100
        sliders["confidence"]?.doubleValue = settings.minConfidence * 100
        sliders["minSubject"]?.doubleValue = settings.resolvedMinSubject * 100
        sliders["lost"]?.doubleValue = settings.lostHoldMs
        sliders["latency"]?.doubleValue = settings.latencyMs
        sliders["pan"]?.doubleValue = settings.maxSpeed.pan
        sliders["tilt"]?.doubleValue = settings.maxSpeed.tilt
        sliders["zoom"]?.doubleValue = settings.maxSpeed.zoom
        sliders["accel"]?.doubleValue = settings.maxAccel.pan
        sliders["decel"]?.doubleValue = settings.resolvedDecel.pan
        sliders["smooth"]?.doubleValue = settings.smoothing
        sliders["jitter"]?.doubleValue = settings.resolvedJitter
        let text: [String: String] = [
            "deadX": String(format: "%.1f%%", settings.deadZone.x * 100),
            "confidence": String(format: "%.0f%%", settings.minConfidence * 100),
            "minSubject": String(format: "%.0f%%", settings.resolvedMinSubject * 100),
            "lost": "\(Int(settings.lostHoldMs)) ms",
            "latency": "\(Int(settings.latencyMs)) ms",
            "pan": "\(Int(settings.maxSpeed.pan))",
            "tilt": "\(Int(settings.maxSpeed.tilt))",
            "zoom": "\(Int(settings.maxSpeed.zoom))",
            "accel": "\(Int(settings.maxAccel.pan))/s",
            "decel": "\(Int(settings.resolvedDecel.pan))/s",
            "smooth": String(format: "%.2f", settings.smoothing),
            "jitter": String(format: "%.2f", settings.resolvedJitter),
        ]
        for (key, label) in text { valueLabels[key]?.stringValue = label }
    }
}
