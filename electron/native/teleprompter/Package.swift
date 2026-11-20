// swift-tools-version:5.9
import Foundation
import PackageDescription

let infoPlist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

let package = Package(
    name: "filmareto-native",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "PrompterCore"),
        .executableTarget(
            name: "filmareto-native",
            dependencies: ["PrompterCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("Carbon"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("Speech"),
                .linkedFramework("Vision"),
                .linkedFramework("CoreImage"),
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist]),
            ]
        ),
        .testTarget(name: "PrompterCoreTests", dependencies: ["PrompterCore"]),
    ]
)
