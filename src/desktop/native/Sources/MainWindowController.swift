import AppKit
import WebKit

/// One window, one WKWebView. While the fleet runs it shows the web dashboard
/// itself — its own sidebar, top bar, i18n and pages — so the app never
/// re-implements dashboard chrome. Otherwise it shows the bundled status page
/// (`status/index.html`), the only page that gets the privileged bridge.
final class MainWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
    WKScriptMessageHandlerWithReply {
    private let host: HostProcess
    private let statusDir: URL
    private let webView: WKWebView
    private var dashboardURL: URL?
    private var locating = false
    private var lastLocateAttempt = Date.distantPast
    private var lastLocateError: String?
    private(set) var overview: [String: Any] = [:]

    /// Extra bridge methods handled natively (login item, update, …).
    var nativeMethods: [String: ([Any], @escaping (Any?, String?) -> Void) -> Void] = [:]

    init(host: HostProcess, statusDir: URL, bridgeScript: String) {
        self.host = host
        self.statusDir = statusDir

        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        config.userContentController = controller
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)

        let screen = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1440, height: 900)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: min(1480, screen.width - 48), height: min(920, screen.height - 48)),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Botmux"
        window.minSize = NSSize(width: 980, height: 640)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        super.init(window: window)
        if !window.setFrameUsingName("BotmuxMainWindow") { window.center() }
        window.setFrameAutosaveName("BotmuxMainWindow")

        controller.addScriptMessageHandler(self, contentWorld: .page, name: "botmux")
        window.delegate = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        if ProcessInfo.processInfo.environment["BOTMUX_DESKTOP_DEBUG"] == "1", #available(macOS 13.3, *) {
            webView.isInspectable = true
        }
        showStatusPage()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func show() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func reload() {
        if dashboardURL != nil { webView.reload() } else { showStatusPage() }
    }

    // MARK: - Runtime state → which page

    func apply(overview: [String: Any]) {
        self.overview = overview
        pushOverviewToStatusPage()
        let state = overview["state"] as? [String: Any] ?? [:]
        let running = (state["status"] as? String) == "running"
        if running {
            if dashboardURL == nil { locateDashboard() }
        } else if dashboardURL != nil {
            dashboardURL = nil
            showStatusPage()
        }
    }

    func locateDashboard(force: Bool = false) {
        guard !locating, force || Date().timeIntervalSince(lastLocateAttempt) > 8 else { return }
        locating = true
        lastLocateAttempt = Date()
        host.call("locateDashboard") { [weak self] result in
            guard let self else { return }
            self.locating = false
            guard case .success(let value) = result, let located = value as? [String: Any] else {
                if case .failure(let error) = result { self.lastLocateError = error.localizedDescription }
                self.pushOverviewToStatusPage()
                return
            }
            if (located["ok"] as? Bool) == true, let raw = located["url"] as? String, let url = URL(string: raw) {
                self.lastLocateError = nil
                self.dashboardURL = url
                self.webView.load(URLRequest(url: url))
            } else {
                self.lastLocateError = located["message"] as? String ?? "Dashboard unavailable"
                self.pushOverviewToStatusPage()
            }
        }
    }

    private func showStatusPage() {
        webView.loadFileURL(statusDir.appendingPathComponent("index.html"), allowingReadAccessTo: statusDir)
    }

    private func pushOverviewToStatusPage() {
        guard webView.url?.isFileURL == true else { return }
        var payload = overview
        if let error = lastLocateError { payload["dashboardError"] = error }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.botmuxStatus && window.botmuxStatus.render(\(json))")
    }

    // MARK: - NSWindowDelegate

    /// Closing the window hides it; the fleet and the menu-bar item stay.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    // MARK: - Bridge (status page only)

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        // Only the bundled status page may drive the runtime; the dashboard is
        // HTTP content and never reaches this handler's privileges.
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "file",
              let body = message.body as? [String: Any], let method = body["method"] as? String else {
            replyHandler(nil, "bridge call rejected")
            return
        }
        let params = body["params"] as? [Any] ?? []
        if method == "retryDashboard" {
            lastLocateError = nil
            locateDashboard(force: true)
            replyHandler(true, nil)
            return
        }
        if let native = nativeMethods[method] {
            native(params, replyHandler)
            return
        }
        let allowed: Set<String> = ["getOverview", "start", "stop", "restart", "takeover", "checkUpdate", "applyUpdate", "listLogTargets", "tailLogs"]
        guard allowed.contains(method) else {
            replyHandler(nil, "unknown method: \(method)")
            return
        }
        host.call(method, params: params) { result in
            switch result {
            case .success(let value): replyHandler(value, nil)
            case .failure(let error): replyHandler(nil, error.localizedDescription)
            }
        }
    }

    // MARK: - Navigation

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        if url.isFileURL { return decisionHandler(url.path.hasPrefix(statusDir.path) ? .allow : .cancel) }
        if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return decisionHandler(.allow) }
        // Subframes (embedded terminals, previews) load freely inside the dashboard.
        if navigationAction.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
        if let dashboard = dashboardURL, Self.origin(of: url) == Self.origin(of: dashboard) {
            return decisionHandler(.allow)
        }
        if Self.isWeb(url) { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView.url?.isFileURL == true { pushOverviewToStatusPage() }
        if ProcessInfo.processInfo.environment["BOTMUX_DESKTOP_DEBUG"] == "1" {
            // Origin + hash only: the query can carry the dashboard token.
            let url = webView.url
            let shown = url.map { "\(Self.origin(of: $0) ?? $0.scheme ?? "")\($0.path)#\($0.fragment ?? "")" } ?? "nil"
            let probe = "JSON.stringify({title: document.title, sidebar: !!document.querySelector('.sidebar'), navItems: document.querySelectorAll('.sidebar a, .sidebar button').length, lang: document.documentElement.lang, nodes: document.querySelectorAll('*').length})"
            for delay in [0.0, 4.0] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    webView.evaluateJavaScript(probe) { info, _ in
                        FileHandle.standardError.write(Data("[botmux-debug] +\(Int(delay))s \(shown) \(info ?? "")\n".utf8))
                    }
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        dashboardLoadFailed(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        dashboardLoadFailed(error)
    }

    private func dashboardLoadFailed(_ error: Error) {
        let code = (error as NSError).code
        guard dashboardURL != nil, code != NSURLErrorCancelled, code != 102 /* frame load interrupted */ else { return }
        lastLocateError = error.localizedDescription
        dashboardURL = nil
        showStatusPage()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: - WKUIDelegate

    /// target=_blank / window.open: open in the browser, never a child window.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, Self.isWeb(url) { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    /// <input type=file> in the dashboard (uploads, bundle import).
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        completionHandler(panel.runModal() == .OK ? panel.urls : nil)
    }

    // MARK: - Helpers

    static func isWeb(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased()
        return scheme == "http" || scheme == "https"
    }

    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
        return url.port.map { "\(scheme)://\(host):\($0)" } ?? "\(scheme)://\(host)"
    }
}
