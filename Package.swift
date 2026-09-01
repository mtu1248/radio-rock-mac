// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "RadioRockMac",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "RadioRockMac",
            path: "Sources/RadioRockMac"
        )
    ]
)
