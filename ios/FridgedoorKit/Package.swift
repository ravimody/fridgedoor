// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "FridgedoorKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [.library(name: "FridgedoorKit", targets: ["FridgedoorKit"])],
    targets: [
        .target(name: "FridgedoorKit"),
        .testTarget(name: "FridgedoorKitTests", dependencies: ["FridgedoorKit"], resources: [.copy("Fixtures")]),
    ]
)
