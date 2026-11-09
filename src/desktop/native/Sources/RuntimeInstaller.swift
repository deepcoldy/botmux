import Foundation

/// The botmux binary the app actually runs lives OUTSIDE the bundle, at
/// `~/.botmux/app-runtime/botmux`:
///  · `botmux update` / dashboard / maintenance can replace it in place (it is
///    classified like an install.sh binary), without touching the signed .app
///  · the fleet, the `~/.botmux/bin/botmux` launcher and launchd keep a stable
///    path when the app is moved or reinstalled
/// The bundle carries a seed copy; whichever of the two is newer wins.
enum RuntimeInstaller {
    struct Result {
        let binary: URL
        /// The runtime file was just (re)seeded from the bundle — a fleet already
        /// running from that path must be restarted to pick the new build up.
        let replaced: Bool
        let version: String?
    }

    static var runtimeURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".botmux/app-runtime/botmux")
    }

    /// Read and cleared by the host (desktop-host.ts launchPolicy).
    static var restartMarkerURL: URL {
        runtimeURL.deletingLastPathComponent().appendingPathComponent(".restart-needed")
    }

    static func ensure(bundled: URL) -> Result {
        let fm = FileManager.default
        let target = runtimeURL
        let bundledVersion = version(of: bundled)
        let installedVersion = fm.isExecutableFile(atPath: target.path) ? version(of: target) : nil

        if let installed = installedVersion, let seed = bundledVersion {
            let order = compare(installed, seed)
            // Newer (self-updated) runtime wins. Same version keeps it too, unless
            // the bundle carries a different build of it (a reinstall/rebuild).
            if order > 0 || (order == 0 && fm.contentsEqual(atPath: target.path, andPath: bundled.path)) {
                return Result(binary: target, replaced: false, version: installed)
            }
        }
        if installedVersion != nil && bundledVersion == nil {
            return Result(binary: target, replaced: false, version: installedVersion)
        }
        do {
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            // Copy next to the target, then rename over it: a running fleet keeps
            // its old inode, and nothing ever execs a half-written file.
            let temp = target.deletingLastPathComponent().appendingPathComponent(".botmux.\(UUID().uuidString)")
            try fm.copyItem(at: bundled, to: temp)
            // copyItem keeps the bundle's (old) mtime; stamp "now" so the host's
            // restart-pending check sees this file as newer than a running fleet.
            try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: temp.path)
            if rename(temp.path, target.path) != 0 {
                try? fm.removeItem(at: temp)
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            let replaced = installedVersion != nil
            if replaced {
                // Persisted, not passed once: the host clears it only after the
                // restart onto this build succeeded, so a failed restart or a host
                // relaunch cannot silently leave the fleet on the old build.
                fm.createFile(atPath: restartMarkerURL.path, contents: Data(ISO8601DateFormatter().string(from: Date()).utf8))
            }
            return Result(binary: target, replaced: replaced, version: bundledVersion)
        } catch {
            NSLog("[botmux] could not seed app runtime at \(target.path): \(error); using the bundled binary")
            return Result(binary: bundled, replaced: false, version: bundledVersion)
        }
    }

    /// `botmux --version`, probe mode (no side effects, no update checks).
    static func version(of binary: URL) -> String? {
        let proc = Process()
        proc.executableURL = binary
        proc.arguments = ["--version"]
        var env = ProcessInfo.processInfo.environment
        env["BOTMUX_INSTALL_PROBE"] = "1"
        proc.environment = env
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = FileHandle.nullDevice
        do { try proc.run() } catch { return nil }
        proc.waitUntilExit()
        guard proc.terminationStatus == 0 else { return nil }
        let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.range(of: #"^\d+\.\d+\.\d+"#, options: .regularExpression) != nil ? text : nil
    }

    /// Semver precedence (core numerically; a release outranks its pre-releases).
    static func compare(_ a: String, _ b: String) -> Int {
        func split(_ v: String) -> ([Int], String?) {
            let parts = v.split(separator: "-", maxSplits: 1).map(String.init)
            let core = parts[0].split(separator: ".").map { Int($0) ?? 0 }
            return (core, parts.count > 1 ? parts[1] : nil)
        }
        let (ca, pa) = split(a)
        let (cb, pb) = split(b)
        for i in 0..<max(ca.count, cb.count) {
            let x = i < ca.count ? ca[i] : 0
            let y = i < cb.count ? cb[i] : 0
            if x != y { return x < y ? -1 : 1 }
        }
        switch (pa, pb) {
        case (nil, nil): return 0
        case (nil, _): return 1
        case (_, nil): return -1
        case let (x?, y?): return x == y ? 0 : (x.compare(y, options: .numeric) == .orderedAscending ? -1 : 1)
        }
    }
}
