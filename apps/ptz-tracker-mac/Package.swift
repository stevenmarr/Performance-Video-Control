// swift-tools-version: 5.9
// TrackingCore is plain Swift and is what `swift test` builds on Linux.
// PTZTracker is the macOS 14 menu-bar app. It is not part of the Linux build:
// this manifest adds that target only when the package is evaluated on macOS.
import PackageDescription

var products: [Product] = [
    .library(name: "TrackingCore", targets: ["TrackingCore"]),
]

var targets: [Target] = [
    .target(name: "TrackingCore", path: "Sources/TrackingCore"),
    .testTarget(name: "TrackingCoreTests", dependencies: ["TrackingCore"], path: "Tests/TrackingCoreTests"),
]

#if os(macOS)
products.append(.executable(name: "PTZTracker", targets: ["PTZTracker"]))
targets.append(
    .executableTarget(
        name: "PTZTracker",
        dependencies: ["TrackingCore"],
        path: "Sources/TrackerMac",
        linkerSettings: [
            .linkedFramework("AppKit"),
            .linkedFramework("Vision"),
            .linkedFramework("AVFoundation"),
            .linkedFramework("CoreMedia"),
            .linkedFramework("CoreImage"),
            .linkedFramework("CoreVideo"),
            .linkedFramework("ImageIO"),
            .linkedFramework("Network"),
        ]
    )
)
#endif

let package = Package(
    name: "PTZTracker",
    products: products,
    targets: targets
)
