import AppKit
import ServiceManagement

/// Botmux.app — native shell around the botmux binary.
///
/// Bundle layout (assembled by scripts/build-native-desktop.mjs):
///   Contents/MacOS/Botmux             this executable
///   Contents/Resources/bin/botmux     seed copy of the compiled botmux CLI (arm64)
///   Contents/Resources/status/        local page shown while the fleet is down
///   Contents/Resources/bridge.js      window.botmuxDesktop for that page
/// The runtime itself runs from ~/.botmux/app-runtime/botmux (see RuntimeInstaller).
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var host: HostProcess!
    private var windowController: MainWindowController!
    private var statusItem: NSStatusItem!
    private var runtimeVersion: String?
    private var overview: [String: Any] = [:]
    private let notifier = UpdateNotifier()
    private static var shellVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0.0.0"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let resources = Bundle.main.resourceURL!
        let env = ProcessInfo.processInfo.environment
        let bundled = env["BOTMUX_DESKTOP_BINARY"].map(URL.init(fileURLWithPath:))
            ?? resources.appendingPathComponent("bin/botmux")
        let statusDir = env["BOTMUX_DESKTOP_STATUS_DIR"].map(URL.init(fileURLWithPath:))
            ?? resources.appendingPathComponent("status")
        let bridgeScript = (try? String(contentsOf: resources.appendingPathComponent("bridge.js"), encoding: .utf8)) ?? ""

        // Dev override runs the given binary as-is; otherwise seed/refresh the
        // out-of-bundle runtime from the bundle when the bundle is newer.
        let runtime = env["BOTMUX_DESKTOP_BINARY"] != nil
            ? RuntimeInstaller.Result(binary: bundled, replaced: false, version: RuntimeInstaller.version(of: bundled))
            : RuntimeInstaller.ensure(bundled: bundled)
        runtimeVersion = runtime.version

        installMainMenu()
        // Host = the bundled binary (protocol always matches this shell);
        // fleet = the self-updatable runtime copy.
        host = HostProcess(binaryURL: bundled)
        host.env["BOTMUX_DESKTOP_SHELL_VERSION"] = Self.shellVersion
        host.env["BOTMUX_DESKTOP_RUNTIME"] = runtime.binary.path
        // Auto-takeover of an older install is an app-launch decision only.
        host.oneShotEnv["BOTMUX_DESKTOP_APP_LAUNCH"] = "1"
        windowController = MainWindowController(host: host, statusDir: statusDir, bridgeScript: bridgeScript)
        windowController.nativeMethods = [
            "getLoginItem": { _, reply in reply(Self.loginItemState(), nil) },
            "setLoginItem": { params, reply in
                guard let enabled = params.first as? Bool else { return reply(nil, "setLoginItem expects a boolean") }
                do {
                    try Self.setLoginItem(enabled)
                    reply(Self.loginItemState(), nil)
                } catch {
                    reply(nil, error.localizedDescription)
                }
            },
            "openLogsDir": { _, reply in reply(Self.openHomePath(".botmux/logs"), nil) },
            "openBotmuxHome": { _, reply in reply(Self.openHomePath(".botmux"), nil) },
        ]
        host.onEvent = { [weak self] name, data in
            guard let self else { return }
            if name == "ready", let info = data as? [String: Any], let version = info["version"] as? String {
                self.runtimeReady(version)
                return
            }
            guard name == "overview", let overview = data as? [String: Any] else { return }
            self.overview = overview
            self.windowController.apply(overview: overview)
            self.updateStatusIcon()
            self.remindIfNeeded()
        }
        notifier.onAction = { [weak self] action, _ in
            guard let self else { return }
            switch action {
            case .updateRuntime: self.applyUpdate()
            case .downloadShell: self.downloadShell()
            case .restartFleet: self.runtimeAction("restart")
            case .show: self.windowController.show()
            }
        }
        host.start()
        installStatusItem(resources: resources)

        // Launched as a login item → stay in the menu bar; otherwise show the window.
        let event = NSAppleEventManager.shared().currentAppleEvent
        let launchedAsLoginItem = event?.eventID == AEEventID(kAEOpenApplication)
            && event?.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == AEEventClass(keyAELaunchedAsLogInItem)
        if !launchedAsLoginItem { windowController.show() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        windowController.show()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        // Ends the host only. The supervised fleet keeps running after Quit,
        // exactly like closing a terminal after `botmux start`.
        host?.stop()
    }

    // MARK: - Menu-bar item (rebuilt from the latest overview each time it opens)

    private func installStatusItem(resources: URL) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let image = NSImage(contentsOf: resources.appendingPathComponent("trayTemplate.png")) {
            image.isTemplate = true
            image.size = NSSize(width: 18, height: 18)
            statusItem.button?.image = image
        } else {
            statusItem.button?.title = "B"
        }
        statusItem.button?.toolTip = "Botmux"
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu
    }

    private func updateStatusIcon() {
        let state = overview["state"] as? [String: Any] ?? [:]
        let status = state["status"] as? String ?? "unknown"
        statusItem?.button?.appearsDisabled = status != "running"
        // A small badge next to the icon while an update / restart is actionable.
        let badge = actionableUpdate() != nil
        statusItem?.length = badge ? NSStatusItem.variableLength : NSStatusItem.squareLength
        statusItem?.button?.imagePosition = badge ? .imageLeft : .imageOnly
        statusItem?.button?.title = badge ? "●" : ""
        statusItem?.button?.toolTip = "Botmux · \(Self.statusLabel(status))" + (actionableUpdate().map { " · \($0)" } ?? "")
    }

    /// Short description of what the user can act on, if anything.
    private func actionableUpdate() -> String? {
        let update = overview["update"] as? [String: Any] ?? [:]
        let shell = update["shell"] as? [String: Any] ?? [:]
        if (update["restartPending"] as? Bool) == true { return "重启后生效" }
        if (update["available"] as? Bool) == true, (update["policy"] as? String) == "remind", let latest = update["latest"] as? String {
            return "botmux \(latest) 可用"
        }
        if (shell["available"] as? Bool) == true, let latest = shell["latest"] as? String { return "Botmux.app \(latest) 可下载" }
        return nil
    }

    private func remindIfNeeded() {
        let update = overview["update"] as? [String: Any] ?? [:]
        let shell = update["shell"] as? [String: Any] ?? [:]
        if (update["available"] as? Bool) == true, (update["policy"] as? String) == "remind",
           (update["inProgress"] as? Bool) != true, let latest = update["latest"] as? String {
            notifier.notifyOnce(key: "runtime-\(latest)", title: "botmux \(latest) 可用",
                                body: "当前 \(runtimeVersion ?? "?")。更新后自动重启由 App 运行的 fleet。", category: "runtime-update")
        }
        if (update["restartPending"] as? Bool) == true {
            notifier.notifyOnce(key: "restart-\(runtimeVersion ?? "?")", title: "botmux 已更新到 \(runtimeVersion ?? "新版本")",
                                body: "fleet 仍在运行旧版本，重启后生效。", category: "restart-pending")
        }
        if (shell["available"] as? Bool) == true, let latest = shell["latest"] as? String {
            notifier.notifyOnce(key: "shell-\(latest)", title: "Botmux.app \(latest) 可下载",
                                body: "App 外壳有新版本（当前 \(Self.shellVersion)）。运行时会继续自动更新，不受影响。", category: "shell-update")
        }
    }

    /// The host (re)started: after an update it relaunches from the new binary.
    private func runtimeReady(_ version: String) {
        let previous = runtimeVersion
        runtimeVersion = version
        if let previous, RuntimeInstaller.compare(version, previous) > 0 {
            notifier.notifyOnce(key: "updated-\(version)", title: "botmux 已更新到 \(version)", body: "由 \(previous) 更新。")
        }
    }

    @objc private func downloadShell() {
        let update = overview["update"] as? [String: Any] ?? [:]
        let shell = update["shell"] as? [String: Any] ?? [:]
        if let raw = shell["url"] as? String, let url = URL(string: raw) { NSWorkspace.shared.open(url) }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let state = overview["state"] as? [String: Any] ?? [:]
        let status = state["status"] as? String ?? "unknown"
        let alignment = overview["alignment"] as? [String: Any] ?? [:]
        let update = overview["update"] as? [String: Any] ?? [:]
        let running = status == "running" || status == "degraded"

        var header = "Botmux · \(Self.statusLabel(status))"
        if let online = state["onlineDaemonCount"] as? Int, let bots = state["botCount"] as? Int, running {
            header += "（\(online)/\(bots) 在线）"
        }
        menu.addItem(info(header))
        menu.addItem(info("App 运行时 \(runtimeVersion ?? "?")"))
        if (state["runtimeSource"] as? String) == "global-cli", let path = state["runtimePath"] as? String {
            let version = (state["runtimeVersion"] as? String).map { " \($0)" } ?? ""
            menu.addItem(info("当前 fleet：已安装的 CLI\(version)"))
            menu.addItem(info("  \(Self.abbreviate(path))"))
        }
        menu.addItem(.separator())

        if status == "degraded", (state["runtimeManaged"] as? Bool) == false {
            menu.addItem(item("切换到 App 运行时（重启 fleet）", #selector(alignFleet)))
        }
        switch alignment["kind"] as? String {
        case "owner-older":
            let app = alignment["appVersion"] as? String ?? ""
            menu.addItem(item("对齐到 App 版本 \(app)（切换 fleet）", #selector(alignFleet)))
        case "owner-newer":
            let owner = alignment["ownerVersion"] as? String ?? ""
            menu.addItem(info("CLI \(owner) 比 App 新，建议更新 App 运行时"))
        default:
            break
        }
        if (update["restartPending"] as? Bool) == true {
            menu.addItem(item("重启 fleet 以应用 \(runtimeVersion ?? "新版本")", #selector(restartRuntime)))
        }
        if (update["available"] as? Bool) == true, let latest = update["latest"] as? String {
            let busy = (update["inProgress"] as? Bool) == true
            let updateItem = item(busy ? "正在更新到 \(latest)…" : "更新运行时到 \(latest)", #selector(applyUpdate))
            updateItem.isEnabled = !busy
            menu.addItem(updateItem)
            if (update["policy"] as? String) == "cli-auto" {
                let time = (update["autoUpdateTime"] as? String).map { "每天 \($0)" } ?? "按计划"
                menu.addItem(info("  已开启自动更新，将在\(time)由 daemon 更新"))
            }
        }
        if let shell = update["shell"] as? [String: Any], (shell["available"] as? Bool) == true, let latest = shell["latest"] as? String {
            menu.addItem(item("下载 Botmux.app \(latest)…", #selector(downloadShell)))
        }
        menu.addItem(item("检查更新", #selector(checkUpdate)))
        menu.addItem(.separator())

        menu.addItem(item("显示控制台", #selector(showConsole)))
        let start = item("启动", #selector(startRuntime))
        start.isEnabled = !running && status != "not_configured"
        menu.addItem(start)
        let stop = item("停止", #selector(stopRuntime))
        stop.isEnabled = running
        menu.addItem(stop)
        let restart = item("重启", #selector(restartRuntime))
        restart.isEnabled = running
        menu.addItem(restart)
        menu.addItem(.separator())

        let login = item("开机启动", #selector(toggleLoginItem))
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(item("打开日志目录", #selector(openLogs)))
        menu.addItem(item("打开 ~/.botmux", #selector(openHome)))
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出 Botmux", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp
        menu.addItem(quit)
    }

    private func info(_ title: String) -> NSMenuItem {
        let menuItem = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        menuItem.isEnabled = false
        return menuItem
    }

    private func item(_ title: String, _ action: Selector) -> NSMenuItem {
        let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: "")
        menuItem.target = self
        return menuItem
    }

    @objc private func showConsole() { windowController.show() }
    @objc private func startRuntime() { runtimeAction("start") }
    @objc private func stopRuntime() { runtimeAction("stop") }
    @objc private func restartRuntime() { runtimeAction("restart") }
    @objc private func alignFleet() { runtimeAction("takeover") }
    @objc private func reloadWindow() { windowController.reload() }
    @objc private func openLogs() { _ = Self.openHomePath(".botmux/logs") }
    @objc private func openHome() { _ = Self.openHomePath(".botmux") }

    @objc private func checkUpdate() {
        host.call("checkUpdate") { [weak self] result in
            guard case .success(let value) = result, let update = value as? [String: Any] else {
                if case .failure(let error) = result { Self.alert("检查更新失败", error.localizedDescription) }
                return
            }
            if (update["available"] as? Bool) == true, let latest = update["latest"] as? String {
                let alert = NSAlert()
                alert.messageText = "botmux \(latest) 可用"
                alert.informativeText = "当前 App 运行时 \(self?.runtimeVersion ?? "?")。更新会替换 ~/.botmux/app-runtime/botmux，并重启由 App 运行的 fleet。"
                alert.addButton(withTitle: "更新")
                alert.addButton(withTitle: "稍后")
                if alert.runModal() == .alertFirstButtonReturn { self?.applyUpdate() }
            } else if let error = update["error"] as? String {
                Self.alert("检查更新失败", error)
            } else {
                Self.alert("已是最新版本", "App 运行时 \(self?.runtimeVersion ?? "?")")
            }
        }
    }

    @objc private func applyUpdate() {
        host.call("applyUpdate") { [weak self] result in
            switch result {
            case .success(let value):
                let outcome = value as? [String: Any] ?? [:]
                if (outcome["ok"] as? Bool) == true {
                    self?.runtimeVersion = RuntimeInstaller.version(of: RuntimeInstaller.runtimeURL) ?? self?.runtimeVersion
                } else {
                    Self.alert("更新失败", outcome["message"] as? String ?? "")
                }
            case .failure(let error):
                // The host exits on success to relaunch from the new binary; a
                // reply lost to that exit is not a failure.
                let version = RuntimeInstaller.version(of: RuntimeInstaller.runtimeURL)
                if version != self?.runtimeVersion { self?.runtimeVersion = version } else {
                    Self.alert("更新失败", error.localizedDescription)
                }
            }
        }
    }

    @objc private func toggleLoginItem() {
        do {
            try Self.setLoginItem(SMAppService.mainApp.status != .enabled)
        } catch {
            Self.alert("无法修改开机启动", error.localizedDescription)
        }
    }

    private func runtimeAction(_ method: String) {
        host.call(method) { result in
            switch result {
            case .success(let value):
                let run = value as? [String: Any] ?? [:]
                if let code = run["code"] as? Int, code != 0 {
                    Self.alert("\(method) 失败", (run["stderr"] as? String) ?? (run["stdout"] as? String) ?? "exit \(code)")
                }
            case .failure(let error):
                Self.alert("\(method) 失败", error.localizedDescription)
            }
        }
    }

    // MARK: - Main menu (also needed for ⌘C/⌘V/⌘Q inside the web view)

    private func installMainMenu() {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 Botmux", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        let check = NSMenuItem(title: "检查更新…", action: #selector(checkUpdate), keyEquivalent: "")
        check.target = self
        appMenu.addItem(check)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 Botmux", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 Botmux", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(submenu: appMenu, title: "Botmux")

        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        main.addItem(submenu: edit, title: "编辑")

        let view = NSMenu(title: "显示")
        let reload = NSMenuItem(title: "重新加载", action: #selector(reloadWindow), keyEquivalent: "r")
        reload.target = self
        view.addItem(reload)
        main.addItem(submenu: view, title: "显示")

        let window = NSMenu(title: "窗口")
        window.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        main.addItem(submenu: window, title: "窗口")
        NSApp.windowsMenu = window

        NSApp.mainMenu = main
    }

    // MARK: - Helpers

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "running": return "运行中"
        case "stopped": return "已停止"
        case "starting": return "启动中"
        case "degraded": return "需要处理"
        case "not_configured": return "未配置机器人"
        default: return "检查中"
        }
    }

    static func abbreviate(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }

    static func openHomePath(_ relative: String) -> String {
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else { return "Path does not exist: \(url.path)" }
        return NSWorkspace.shared.open(url) ? "" : "Failed to open \(url.path)"
    }

    static func loginItemState() -> [String: Any] {
        let legacy = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.botmux.daemon.plist")
        return [
            "openAtLogin": SMAppService.mainApp.status == .enabled,
            "legacyAutostart": FileManager.default.fileExists(atPath: legacy.path),
            "legacyPath": legacy.path,
        ]
    }

    static func setLoginItem(_ enabled: Bool) throws {
        if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }

    static func alert(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = String(detail.prefix(1200))
        alert.runModal()
    }
}

private extension NSMenu {
    func addItem(submenu: NSMenu, title: String) {
        let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        holder.submenu = submenu
        addItem(holder)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
