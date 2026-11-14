import AppKit
import TrackingCore

/// Menu-bar app. No dock icon (`LSUIElement` in the bundle, and `.accessory` when launched from `swift build`).
/// Settings live in Control Center. This process keeps tracking if the browser closes.
///
/// This file has not been compiled here. The Linux agent cannot build AppKit. Build steps are in
/// docs/ptz-tracking.md.

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var runtime: TrackerRuntime?
    private let menu = MenuController()
    private var tuning: TuningWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let port = UInt16(ProcessInfo.processInfo.environment["PTZ_TRACKER_PORT"] ?? "") ?? 8765
        let runtime = TrackerRuntime(port: port)
        runtime.onState = { [weak self] snapshot in
            self?.menu.update(snapshot)
        }
        self.runtime = runtime
        menu.onQuit = { NSApp.terminate(nil) }
        menu.onTune = { [weak self] in self?.showTuning() }
        runtime.start()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        runtime?.shutdown {
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return runtime == nil ? .terminateNow : .terminateLater
    }

    private func showTuning() {
        guard let runtime else { return }
        if tuning == nil { tuning = TuningWindow(runtime: runtime) }
        tuning?.show()
    }
}

final class MenuController: NSObject {
    private var item: NSStatusItem?
    var onQuit: (() -> Void)?
    var onTune: (() -> Void)?

    func update(_ snapshot: TrackerSnapshot) {
        if item == nil {
            item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        }
        guard let item else { return }
        let tracking = snapshot.cameras.contains { $0.state == "locked" || $0.state == "searching" || $0.state == "lost" }
        item.button?.title = tracking ? "PTZ ●" : "PTZ"
        let menu = NSMenu()
        let title = NSMenuItem(title: "PTZ Tracker", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        let listen = NSMenuItem(title: snapshot.listening, action: nil, keyEquivalent: "")
        listen.isEnabled = false
        menu.addItem(listen)
        menu.addItem(.separator())
        if snapshot.cameras.isEmpty {
            let idle = NSMenuItem(title: "No camera yet. Start one from Control Center.", action: nil, keyEquivalent: "")
            idle.isEnabled = false
            menu.addItem(idle)
        } else {
            for camera in snapshot.cameras {
                let row = NSMenuItem(title: "\(camera.label)  \(camera.state)", action: nil, keyEquivalent: "")
                row.isEnabled = false
                menu.addItem(row)
            }
        }
        menu.addItem(.separator())
        let tune = NSMenuItem(title: "Tuning…", action: #selector(openTuning), keyEquivalent: "t")
        tune.target = self
        menu.addItem(tune)
        let quit = NSMenuItem(title: "Quit PTZ Tracker", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
    }

    @objc private func openTuning() { onTune?() }
    @objc private func quit() { onQuit?() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
