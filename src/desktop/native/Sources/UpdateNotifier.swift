import AppKit
import UserNotifications

/// Update reminders: one system notification per event and version (remembered
/// across launches), plus a badge on the menu-bar icon while something is
/// actionable. Never repeats a reminder the user has already seen.
final class UpdateNotifier: NSObject, UNUserNotificationCenterDelegate {
    enum Action: String {
        case updateRuntime = "botmux.update-runtime"
        case downloadShell = "botmux.download-shell"
        case restartFleet = "botmux.restart-fleet"
        case show = "botmux.show"
    }

    private let center = UNUserNotificationCenter.current()
    private let defaults = UserDefaults.standard
    private var authorized: Bool?
    var onAction: ((Action, [AnyHashable: Any]) -> Void)?

    override init() {
        super.init()
        center.delegate = self
        let update = UNNotificationAction(identifier: Action.updateRuntime.rawValue, title: "立即更新")
        let download = UNNotificationAction(identifier: Action.downloadShell.rawValue, title: "下载")
        let restart = UNNotificationAction(identifier: Action.restartFleet.rawValue, title: "重启 fleet")
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "runtime-update", actions: [update], intentIdentifiers: []),
            UNNotificationCategory(identifier: "shell-update", actions: [download], intentIdentifiers: []),
            UNNotificationCategory(identifier: "restart-pending", actions: [restart], intentIdentifiers: []),
        ])
    }

    /// Post `title`/`body` once for `key` (e.g. "runtime-3.57.0").
    func notifyOnce(key: String, title: String, body: String, category: String? = nil, userInfo: [AnyHashable: Any] = [:]) {
        let seenKey = "notified.\(key)"
        guard !defaults.bool(forKey: seenKey) else { return }
        withAuthorization { [weak self] granted in
            guard let self, granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.userInfo = userInfo
            if let category { content.categoryIdentifier = category }
            self.center.add(UNNotificationRequest(identifier: key, content: content, trigger: nil)) { error in
                if error == nil { DispatchQueue.main.async { self.defaults.set(true, forKey: seenKey) } }
            }
        }
    }

    private func withAuthorization(_ done: @escaping (Bool) -> Void) {
        if let authorized { return done(authorized) }
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
            DispatchQueue.main.async {
                self?.authorized = granted
                done(granted)
            }
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let action: Action
        switch response.actionIdentifier {
        case Action.updateRuntime.rawValue: action = .updateRuntime
        case Action.downloadShell.rawValue: action = .downloadShell
        case Action.restartFleet.rawValue: action = .restartFleet
        default:
            // Clicking the banner itself: do the obvious thing for its category.
            switch response.notification.request.content.categoryIdentifier {
            case "shell-update": action = .downloadShell
            default: action = .show
            }
        }
        DispatchQueue.main.async { self.onAction?(action, info) }
        completionHandler()
    }
}
