import Foundation

/// Client for `botmux __desktop-host`, the TypeScript runtime host that ships
/// inside the bundled binary. Requests are newline-delimited JSON on stdin;
/// replies and events come back on stdout behind `framePrefix` (the shared
/// logger also writes to stdout, so unprefixed lines are ignored).
final class HostProcess {
    typealias Reply = (Result<Any, Error>) -> Void

    struct HostError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private static let framePrefix = "\u{1E}BOTMUX "

    private let binaryURL: URL
    private let queue = DispatchQueue(label: "botmux.desktop.host")
    private var process: Process?
    private var stdinHandle: FileHandle?
    private var buffer = Data()
    private var nextId = 1
    private var pending: [Int: Reply] = [:]
    private var stopping = false
    private var restartDelay: TimeInterval = 1

    /// Called on the main queue for every `{"event": …}` frame.
    var onEvent: ((String, Any) -> Void)?
    /// Extra environment for every launch.
    var env: [String: String] = [:]
    /// Extra environment for the NEXT launch only (cleared once used).
    var oneShotEnv: [String: String] = [:]

    init(binaryURL: URL) {
        self.binaryURL = binaryURL
    }

    func start() {
        queue.async { self.launch() }
    }

    /// Closing stdin ends the host; the fleet keeps running by design.
    func stop() {
        queue.sync {
            stopping = true
            try? stdinHandle?.close()
            stdinHandle = nil
        }
    }

    func call(_ method: String, params: [Any] = [], reply: @escaping Reply) {
        queue.async {
            guard let stdin = self.stdinHandle else {
                DispatchQueue.main.async { reply(.failure(HostError(message: "Botmux runtime host is not running"))) }
                return
            }
            let id = self.nextId
            self.nextId += 1
            let request: [String: Any] = ["id": id, "method": method, "params": params]
            guard var line = try? JSONSerialization.data(withJSONObject: request) else {
                DispatchQueue.main.async { reply(.failure(HostError(message: "Request is not JSON-serializable"))) }
                return
            }
            line.append(0x0A)
            self.pending[id] = reply
            do {
                try stdin.write(contentsOf: line)
            } catch {
                self.pending.removeValue(forKey: id)
                DispatchQueue.main.async { reply(.failure(error)) }
            }
        }
    }

    // MARK: - Process lifecycle (all on `queue`)

    private func launch() {
        guard !stopping else { return }
        let proc = Process()
        proc.executableURL = binaryURL
        proc.arguments = ["__desktop-host"]
        var env = ProcessInfo.processInfo.environment
        // Finder launches carry launchd's minimal PATH; the host probes the
        // user's login shell itself, this is only a sane floor.
        let floor = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        env["PATH"] = [env["PATH"], floor].compactMap { $0 }.joined(separator: ":")
        env["BOTMUX_DESKTOP_SHELL"] = "native"
        for (key, value) in self.env { env[key] = value }
        for (key, value) in oneShotEnv { env[key] = value }
        oneShotEnv = [:]
        proc.environment = env
        proc.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser

        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardInput = stdinPipe
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self, !data.isEmpty else { return }
            self.queue.async { self.consume(data) }
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if !data.isEmpty { FileHandle.standardError.write(data) }
        }
        proc.terminationHandler = { [weak self] finished in
            guard let self else { return }
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            self.queue.async { self.handleExit(finished) }
        }

        do {
            try proc.run()
            process = proc
            stdinHandle = stdinPipe.fileHandleForWriting
            buffer.removeAll()
        } catch {
            NSLog("[botmux] failed to launch runtime host at \(binaryURL.path): \(error)")
            scheduleRelaunch()
        }
    }

    private func handleExit(_ finished: Process) {
        guard finished === process else { return }
        process = nil
        stdinHandle = nil
        let failed = pending
        pending.removeAll()
        for reply in failed.values {
            DispatchQueue.main.async { reply(.failure(HostError(message: "Botmux runtime host exited"))) }
        }
        if !stopping {
            NSLog("[botmux] runtime host exited with \(finished.terminationStatus); relaunching")
            scheduleRelaunch()
        }
    }

    private func scheduleRelaunch() {
        let delay = restartDelay
        restartDelay = min(restartDelay * 2, 30)
        queue.asyncAfter(deadline: .now() + delay) { self.launch() }
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: buffer.startIndex..<newline)
            buffer.removeSubrange(buffer.startIndex...newline)
            guard let line = String(data: lineData, encoding: .utf8),
                  let range = line.range(of: Self.framePrefix) else { continue }
            let payload = Data(line[range.upperBound...].utf8)
            guard let object = try? JSONSerialization.jsonObject(with: payload, options: [.fragmentsAllowed]),
                  let frame = object as? [String: Any] else { continue }
            handle(frame)
        }
    }

    private func handle(_ frame: [String: Any]) {
        if let event = frame["event"] as? String {
            if event == "ready" { restartDelay = 1 }
            let data = frame["data"] ?? NSNull()
            DispatchQueue.main.async { self.onEvent?(event, data) }
            return
        }
        guard let id = (frame["id"] as? NSNumber)?.intValue, let reply = pending.removeValue(forKey: id) else { return }
        if (frame["ok"] as? Bool) == true {
            let result = frame["result"] ?? NSNull()
            DispatchQueue.main.async { reply(.success(result)) }
        } else {
            let message = frame["error"] as? String ?? "Unknown host error"
            DispatchQueue.main.async { reply(.failure(HostError(message: message))) }
        }
    }
}
