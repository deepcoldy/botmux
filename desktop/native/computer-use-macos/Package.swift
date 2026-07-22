// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BotmuxComputerUseMacOS",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "BotmuxComputerUseMacOSCore",
            targets: ["BotmuxComputerUseMacOSCore"]
        ),
        .executable(
            name: "botmux-computer-use-macos",
            targets: ["BotmuxComputerUseMacOS"]
        )
    ],
    targets: [
        .target(
            name: "BotmuxComputerUseMacOSCore",
            path: "Sources/BotmuxComputerUseMacOSCore"
        ),
        .executableTarget(
            name: "BotmuxComputerUseMacOS",
            dependencies: ["BotmuxComputerUseMacOSCore"],
            path: "Sources/BotmuxComputerUseMacOS"
        ),
        .testTarget(
            name: "BotmuxComputerUseMacOSTests",
            dependencies: ["BotmuxComputerUseMacOSCore"],
            path: "Tests/BotmuxComputerUseMacOSTests"
        )
    ]
)
