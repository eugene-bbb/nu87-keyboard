// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "NU87Companion",
    platforms: [.macOS(.v13)],
    targets: [.executableTarget(name: "NU87Companion", path: "Sources/NU87Companion")],
    swiftLanguageVersions: [.v5]
)
