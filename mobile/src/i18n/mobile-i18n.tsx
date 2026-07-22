import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { NativeModules, Platform } from 'react-native'

export type MobileLocale = 'en' | 'zh-CN'
export type MobileLanguagePreference = 'system' | MobileLocale
export type MobileTranslationValues = Readonly<Record<string, string | number>>

const LANGUAGE_STORAGE_KEY = 'botmux:language'

// Source English doubles as the stable message id. This keeps call sites readable
// while still giving the app one catalog and one fallback path.
const ZH_CN: Readonly<Record<string, string>> = {
  'System default': '跟随系统',
  English: 'English',
  'Simplified Chinese': '简体中文',
  Language: '语言',
  Settings: '设置',
  Terminal: '终端',
  'Native chat': '原生聊天',
  Browser: '浏览器',
  Voice: '语音',
  Notifications: '通知',
  Troubleshooting: '故障排查',
  About: '关于',
  Support: '支持',
  Back: '返回',
  Cancel: '取消',
  Save: '保存',
  Retry: '重试',
  Refresh: '刷新',
  Copy: '复制',
  Delete: '删除',
  Edit: '编辑',
  Add: '添加',
  Done: '完成',
  Close: '关闭',
  Continue: '继续',
  Connect: '连接',
  Disconnect: '断开连接',
  Remove: '移除',
  Search: '搜索',
  On: '开启',
  Off: '关闭',
  None: '无',
  Loading: '正在加载',
  'Try Again': '重试',
  'Open Settings': '打开系统设置',
  'Back to home': '返回首页',
  'Pair Desktop': '配对桌面端',
  'New Workspace': '新建工作区',
  Tasks: '任务',
  Desktops: '桌面端',
  Resume: '继续',
  'Quick Actions': '快捷操作',
  'How it works': '工作原理',
  'Connect your desktop': '连接桌面端',
  'Pair with Botmux on your computer to check on your agents, jump into any terminal, and drive work from your phone.':
    '与电脑上的 Botmux 配对，即可在手机上查看 Agent、进入任意终端并推进工作。',
  'Open Botmux desktop': '打开 Botmux Desktop',
  'Go to Settings → Mobile and generate a pairing QR code.':
    '进入“设置”→“移动端”，生成配对二维码。',
  'Scan the code': '扫描二维码',
  'Tap the button above to open the scanner. Point at the QR code on your screen.':
    '点击上方按钮打开扫描器，并对准屏幕上的二维码。',
  "You're connected": '连接完成',
  'Your desktop will appear here. Everything is encrypted end-to-end.':
    '桌面端会显示在这里，所有数据均采用端到端加密。',
  'Welcome back': '欢迎回来',
  'Agents spawned': '已启动 Agent',
  'Agent time': 'Agent 用时',
  'PRs created': '已创建 PR',
  'No task sources connected': '未连接任务来源',
  'Open {{provider}} tasks': '打开 {{provider}} 任务',
  'Account usage': '账户用量',
  Reconnect: '重新连接',
  Host: '主机',
  'Host not found': '找不到主机',
  'Back to hosts': '返回主机列表',
  Filter: '筛选',
  'Filter workspaces': '筛选工作区',
  '{{count}} active': '{{count}} 个筛选条件已启用',
  'Sort by {{sort}}': '排序方式：{{sort}}',
  'Group workspaces': '工作区分组',
  Group: '分组',
  Status: '状态',
  Repo: '仓库',
  PR: 'PR',
  'Hide sidebar': '隐藏侧栏',
  'Close search': '关闭搜索',
  'Search workspaces': '搜索工作区',
  'Search worktrees…': '搜索 worktree…',
  'No matching worktrees': '没有匹配的 worktree',
  'No worktrees match filters': '没有符合筛选条件的 worktree',
  'No worktrees': '没有 worktree',
  'Sort By': '排序方式',
  'Group By': '分组方式',
  'Clear filters': '清除筛选',
  Workspaces: '工作区',
  'Hide sleeping': '隐藏休眠项',
  'Hide default branch': '隐藏默认分支',
  Repositories: '仓库',
  'Delete Worktree': '删除 Worktree',
  'Delete "{{name}}" ({{branch}})?': '要删除“{{name}}”（{{branch}}）吗？',
  Sleep: '休眠',
  Pin: '置顶',
  Unpin: '取消置顶',
  'Agent activity': 'Agent 活动',
  'Agents that need attention, then recent activity': '需要处理的 Agent 优先，其次按最近活动排序',
  'Alphabetical by name': '按名称排序',
  Recent: '最近',
  'Most recent output first': '最近输出优先',
  'Repository, then workspace name': '先按仓库，再按工作区名称',
  Manual: '手动',
  'Server order': '服务器顺序',
  'No Grouping': '不分组',
  Repository: '仓库',
  'PR Status': 'PR 状态',
  'Edit host': '编辑主机',
  'Remove Host': '移除主机',
  'Remove "{{host}}"? You can re-pair later.': '要移除“{{host}}”吗？之后可以重新配对。',
  'Open-source agent IDE for 100x builders': '面向高效开发者的开源 Agent IDE',
  'Pairing credential cleanup': '配对凭据清理',
  "Cleanup still couldn't be confirmed. Try again later.": '仍无法确认清理结果，请稍后重试。',
  "Couldn't check cleanup status on this device. Retry to be safe.":
    '无法检查此设备上的清理状态，建议重试以确保安全。',
  "Couldn't confirm cleanup for {{count}} credential on this device.":
    '无法确认此设备上的 {{count}} 个凭据已清理。',
  "Couldn't confirm cleanup for {{count}} credentials on this device.":
    '无法确认此设备上的 {{count}} 个凭据已清理。',
  'Retry clearing pairing credentials': '重试清理配对凭据',
  'Use the app language selected below. System default follows the language configured on this device.':
    '选择应用显示语言。“跟随系统”会使用此设备当前配置的语言。',
  'Current language: {{language}}': '当前语言：{{language}}',
  LINKS: '链接',
  'Choose where HTTP(S) links tapped in terminal output open.':
    '选择点击终端输出中的 HTTP(S) 链接时使用的打开方式。',
  'Open terminal links': '打开终端链接',
  'Botmux browser on desktop': '桌面端 Botmux 浏览器',
  'Open in the streamed browser from your paired desktop.': '在已配对桌面端的流式浏览器中打开。',
  'Phone browser': '手机浏览器',
  'Open in Safari, Chrome, or another browser on this phone.':
    '在此手机上的 Safari、Chrome 或其他浏览器中打开。',
  'DEFAULT VIEW': '默认视图',
  'Choose how supported agent sessions (Claude, Codex, and other chat-capable agents) open on this device. Terminal shows the raw CLI; native chat shows a chat interface like the desktop app. You can still switch any individual session from its long-press menu.':
    '选择支持聊天的 Agent 会话（Claude、Codex 等）在此设备上的打开方式。终端会显示原始 CLI，原生聊天则提供类似桌面端的聊天界面。你仍可通过长按菜单单独切换任一会话。',
  'Choose how supported agent sessions (Claude, Codex, and other chat-capable agents) open on this device. Native chat is the Orca-style structured message view (recommended default); terminal shows the raw CLI. You can still switch any individual session from its long-press menu.':
    '选择支持聊天的 Agent 会话（Claude、Codex 等）在此设备上的打开方式。原生聊天使用 Orca 风格的结构化消息视图（推荐默认），终端则显示原始 CLI。你仍可通过长按菜单单独切换任一会话。',
  'Open sessions in native chat': '默认使用原生聊天打开会话',
  'Agent notifications': 'Agent 通知',
  'Notifications are disabled in system settings.': '系统设置中已关闭通知。',
  'Get notified on this device when an agent needs your input or finishes a task.':
    '当 Agent 需要你输入或完成任务时，在此设备上接收通知。',
  'WHEN YOU LEAVE THE APP': '离开应用时',
  "While you're using a terminal on your phone, Botmux shrinks it to fit your screen. When you close the app or switch away, this controls whether it stays at phone size (so interactive CLI tools don't reflow) or resizes back to your desktop. You can always use Restore this terminal or Restore all terminals on the banner to resize manually.":
    '在手机上使用终端时，Botmux 会将其缩放以适应屏幕。关闭应用或切换到后台后，此设置决定终端保持手机尺寸（避免交互式 CLI 重新排版），还是恢复为桌面尺寸。你也可以随时通过提示条中的“恢复此终端”或“恢复全部终端”手动调整。',
  'No paired desktops yet. Pair one to control terminal behavior.':
    '尚未配对桌面端。配对后即可控制终端行为。',
  'TEXT SIZE': '文字大小',
  'Text size': '文字大小',
  'Terminal text size': '终端文字大小',
  'Smallest (50%)': '最小（50%）',
  'Smaller (75%)': '较小（75%）',
  'Default (100%)': '默认（100%）',
  'Large (125%)': '较大（125%）',
  'Larger (150%)': '更大（150%）',
  'Largest (200%)': '最大（200%）',
  'Keep at phone size (default)': '保持手机尺寸（默认）',
  'After 1 minute': '1 分钟后',
  'After 5 minutes': '5 分钟后',
  'After 30 minutes': '30 分钟后',
  'After {{seconds}}s': '{{seconds}} 秒后',
  'Restore {{host}}': '恢复 {{host}}',
  "Scale the terminal text. Smaller sizes fit more columns with side margins; larger sizes show fewer columns — drag sideways to pan. You can also pinch to zoom in the terminal itself, which updates this setting. Per-device display only; doesn't change the desktop terminal.":
    '缩放终端文字。较小字号可显示更多列并留出侧边空白；较大字号显示的列更少，可横向拖动查看。也可以在终端中双指缩放，此设置会同步更新。仅影响当前设备，不会改变桌面端终端。',
  'KEYBOARD INPUT': '键盘输入',
  "Enable phone-style autocomplete, autocorrect, and spelling suggestions in the terminal command bar. Off by default so the keyboard never rewrites commands, flags, or paths. Direct keyboard input (when keys go straight to the terminal) always sends raw keystrokes, so suggestions don't apply there.":
    '在终端命令栏中启用手机式自动补全、自动纠错和拼写建议。默认关闭，避免键盘改写命令、参数或路径。直接键盘输入会将按键原样发送到终端，因此不受这些建议影响。',
  'Autocomplete & autocorrect': '自动补全与自动纠错',
  'SHORTCUT BAR': '快捷键栏',
  'Toggle keys to show or hide them, and hold the grip to drag a key into the order you want on the terminal shortcut bar.':
    '切换按键的显示或隐藏；按住拖动手柄，可调整它们在终端快捷键栏中的顺序。',
  'Reset Defaults': '恢复默认',
  'Show every built-in shortcut key in the original order': '按原始顺序显示全部内置快捷键',
  'CUSTOM SHORTCUTS': '自定义快捷键',
  'No custom shortcuts defined yet.': '尚未定义自定义快捷键。',
  'Add Custom Shortcut…': '添加自定义快捷键…',
  'Create key combo or text macro': '创建组合键或文本宏',
  'Add Shortcut': '添加快捷键',
  'Shortcut Combo': '组合键',
  'Pick a key': '选择按键',
  'Text Macro': '文本宏',
  'Build Ctrl, Alt, and Shift key chords': '构建包含 Ctrl、Alt 和 Shift 的组合键',
  'Send custom text command': '发送自定义文本命令',
  'Manage Shortcuts': '管理快捷键',
  'Show, hide, or reorder shortcut keys': '显示、隐藏或重新排序快捷键',
  Modifiers: '修饰键',
  Key: '按键',
  'More keys — Tab, arrows, F1–F12…': '更多按键 — Tab、方向键、F1–F12…',
  Editing: '编辑',
  Navigation: '导航',
  Function: '功能键',
  Label: '标签',
  Command: '命令',
  'Press Enter': '按下回车',
  'e.g. Build': '例如：构建',
  'Connect to a desktop to manage voice settings.': '连接桌面端后即可管理语音设置。',
  'Failed to load voice settings.': '加载语音设置失败。',
  'Failed to load voice settings': '加载语音设置失败',
  'Could not update': '更新失败',
  'Could not select model': '选择模型失败',
  'Download failed': '下载失败',
  'Delete failed': '删除失败',
  DICTATION: '听写',
  'Enable Voice Dictation': '启用语音听写',
  'Dictate text into any focused pane on your desktop.': '向桌面端当前聚焦的任意面板听写文字。',
  'Dictation Mode': '听写模式',
  'Toggle: press once to start, again to stop. Hold: dictate while held.':
    '切换：按一次开始，再按一次停止。按住：按住期间进行听写。',
  Toggle: '切换',
  Hold: '按住',
  'SPEECH MODEL': '语音模型',
  'Speech Model': '语音模型',
  'None selected': '未选择',
  'Pair with this desktop?': '要与此桌面端配对吗？',
  'You opened a pairing link from your desktop. Confirm to add it to your hosts.':
    '你打开了来自桌面端的配对链接。确认后会将其添加到主机列表。',
  Pair: '配对',
  'Connecting…': '正在连接…',
  'Missing pairing code': '缺少配对码',
  'Not a valid pairing code': '配对码无效',
  'Not a valid Botmux QR code': '不是有效的 Botmux 二维码',
  'Not a valid pairing code — copy it from your computer and paste again':
    '配对码无效，请从电脑端重新复制并粘贴。',
  'Pair with desktop': '与桌面端配对',
  'Camera Access Disabled': '摄像头权限已关闭',
  'Scan the QR code from Botmux on your desktop, or paste the pairing code instead.':
    '扫描桌面端 Botmux 中的二维码，或改为粘贴配对码。',
  'Enable camera access in Settings, or paste the pairing code instead.':
    '请在系统设置中启用摄像头权限，或改为粘贴配对码。',
  'Copy the code shown under the QR on your computer.': '复制电脑端二维码下方显示的配对码。',
  'Open Botmux on your computer': '在电脑上打开 Botmux',
  'Go to Settings → Mobile': '进入“设置”→“移动端”',
  'Scan the QR code': '扫描二维码',
  'Pairing log': '配对日志',
  "Couldn't connect within {{seconds}}s — see log below for where it stalled":
    '{{seconds}} 秒内未能连接，请查看下方日志以确认卡住的位置。',
  'Pairing failed: {{error}}': '配对失败：{{error}}',
  'Paste code instead': '改为粘贴配对码',
  'Or paste pairing code': '或粘贴配对码',
  'Paste pairing code': '粘贴配对码',
  'Scan the QR code shown in Botmux Desktop': '扫描 Botmux Desktop 中显示的二维码',
  'Point your camera at the pairing QR code': '将摄像头对准配对二维码',
  'Camera access is needed to scan the pairing QR code.': '需要摄像头权限才能扫描配对二维码。',
  'Allow Camera Access': '允许使用摄像头',
  'Could not connect': '无法连接',
  'Check that Botmux Desktop is open and try again.': '请确认 Botmux Desktop 已打开，然后重试。',
  'Connection log': '连接日志',
  'No paired hosts.': '没有已配对的主机。',
  'Stay updated while away': '离开应用时也能及时获知进展',
  'Enable notifications': '启用通知',
  'Not now': '暂不',
  'You can change this any time in Settings.': '你可以随时在设置中更改。',
  'Notification settings could not be updated. Try again.': '无法更新通知设置，请重试。',
  'Enable agent notifications': '启用 Agent 通知',
  'View connection log': '查看连接日志',
  'Common issues': '常见问题',
  'Run diagnostics': '运行诊断',
  'Running…': '正在运行…',
  'Run again': '再次运行',
  'Paired hosts': '已配对主机',
  '{{count}} paired': '已配对 {{count}} 个',
  'None — scan a QR to pair': '无 — 请扫描二维码进行配对',
  'Could not read host data': '无法读取主机数据',
  Internet: '互联网',
  Connected: '已连接',
  'Unexpected response': '响应异常',
  'No connection': '无网络连接',
  'Reachable at {{endpoint}}': '可通过 {{endpoint}} 访问',
  Hosts: '主机',
  'Could not test': '无法测试',
  Platform: '平台',
  Copied: '已复制',
  'Copy diagnostics': '复制诊断信息',
  'attempt {{count}}': '第 {{count}} 次尝试',
  'No connection events yet this session. Events appear as the app dials this host.':
    '本次会话尚无连接事件。应用尝试连接此主机时，事件会显示在这里。',
  'Different WiFi Networks': '设备位于不同 Wi-Fi 网络',
  'Both devices must be on the same local network (unless connected through Tailscale).':
    '两台设备必须位于同一局域网（通过 Tailscale 连接时除外）。',
  'Ethernet and WiFi must share the same subnet.': '有线网络与 Wi-Fi 必须位于同一子网。',
  'Try reconnecting WiFi on both devices.': '尝试在两台设备上重新连接 Wi-Fi。',
  'Firewall Blocking Port 6768': '防火墙阻止了 6768 端口',
  'macOS: System Settings → Network → Firewall — allow Botmux.':
    'macOS：系统设置 → 网络 → 防火墙，允许 Botmux。',
  'Windows: Defender Firewall → Allow app — enable Botmux for Private networks.':
    'Windows：Defender 防火墙 → 允许应用，为专用网络启用 Botmux。',
  'Corporate/school networks may block P2P — try a personal hotspot.':
    '公司或学校网络可能会阻止点对点连接，可尝试个人热点。',
  'Desktop App Not Running': '桌面应用未运行',
  'Botmux must be open on your desktop to accept connections.':
    '桌面端必须打开 Botmux 才能接受连接。',
  'Try restarting Botmux — the companion server starts on launch.':
    '尝试重启 Botmux，配套服务会在启动时运行。',
  'After an update, you may need to re-pair via QR code.': '更新后可能需要通过二维码重新配对。',
  'Connection Timeout': '连接超时',
  'Check WiFi signal strength on your phone.': '检查手机的 Wi-Fi 信号强度。',
  'Go back to the host list and tap your host to retry.': '返回主机列表并点击主机重试。',
  'Restart both apps if timeouts persist.': '如果持续超时，请重启两端应用。',
  'Tailscale Host Unreachable': '无法访问 Tailscale 主机',
  'Host addresses like 100.x.x.x or *.ts.net connect through Tailscale — keep it ON.':
    '100.x.x.x 或 *.ts.net 等主机地址通过 Tailscale 连接，请保持其开启。',
  'iOS/Android can silently wedge the tunnel: toggle Tailscale off and back on in the Tailscale app.':
    'iOS/Android 的隧道可能会无提示卡住：请在 Tailscale 应用中关闭后重新开启。',
  'Check the desktop is awake and shows as connected in your tailnet.':
    '确认桌面端未休眠，并在 tailnet 中显示为已连接。',
  'Update the Tailscale app — recent releases fix reconnect bugs.':
    '更新 Tailscale 应用，近期版本修复了重连问题。',
  'Other VPN Interference': '其他 VPN 干扰',
  'Non-Tailscale VPNs can route local traffic through a remote server.':
    '非 Tailscale VPN 可能会将本地流量路由到远程服务器。',
  'Disable that VPN or enable split tunneling / "Allow LAN".':
    '请关闭该 VPN，或启用分流 /“允许局域网”。',
  Accounts: '账户',
  Name: '名称',
  Address: '地址',
  'Go back': '返回',
  'Save host': '保存主机',
  'Host name': '主机名称',
  'Missing host.': '缺少主机信息。',
  'This host was removed from this phone.': '此主机已从手机中移除。',
  'Failed to load host.': '加载主机失败。',
  'Enter a name.': '请输入名称。',
  'Failed to save host.': '保存主机失败。',
  'Change the display name or connection address. Address edits only switch where this phone connects — they do not re-pair. Use this when the same desktop is reachable at a different IP (for example home LAN vs Tailscale).':
    '修改显示名称或连接地址。编辑地址只会切换此手机连接的位置，不会重新配对。适用于同一桌面端可通过不同 IP 访问的情况（例如家庭局域网与 Tailscale）。',
  'Accepts IP, host:port, or ws:// / wss://. Missing port defaults to the current port (or 6768).':
    '支持 IP、host:port、ws:// 或 wss://。未填写端口时使用当前端口（或 6768）。',
  'Connects to {{endpoint}}': '将连接到 {{endpoint}}',
  'Could not switch account': '无法切换账户',
  "Use the agent's own login": '使用 Agent 自身的登录信息',
  'Connecting to {{host}}…': '正在连接 {{host}}…',
  'Loading accounts…': '正在加载账户…',
  'Add or re-authenticate accounts from desktop Settings → Accounts.':
    '请在桌面端“设置”→“账户”中添加账户或重新认证。',
  'Could not remove host': '无法移除主机',
  'Please try again.': '请重试。',
  'No tabs in this session': '此会话中没有标签页',
  'Read only': '只读',
  'Changed on desktop': '桌面端已更改',
  Discard: '放弃更改',
  'Add note on line {{line}}': '在第 {{line}} 行添加备注',
  'Delete note on line {{line}}': '删除第 {{line}} 行的备注',
  'Line {{line}}': '第 {{line}} 行',
  'Copy review notes': '复制审查备注',
  'Send review notes to AI': '将审查备注发送给 AI',
  'No review notes': '没有审查备注',
  '{{count}} review note': '{{count}} 条审查备注',
  '{{count}} review notes': '{{count}} 条审查备注',
  Send: '发送',
  'Load earlier messages': '加载更早的消息',
  'Scroll to latest': '滚动到最新消息',
  Collapse: '收起',
  Tools: '工具',
  'Stop the agent': '停止 Agent',
  Stop: '停止',
  'Message not sent — reconnecting…': '消息未发送 — 正在重新连接…',
  'Message not sent': '消息未发送',
  'Reconnecting…': '正在重新连接…',
  'Waiting for terminal…': '正在等待终端…',
  'Message, @files, /commands': '输入消息、@文件或 /命令',
  'Attach image': '附加图片',
  'Stop dictation': '停止听写',
  Dictate: '听写',
  'Send message': '发送消息',
  'Submit selected options': '提交所选项',
  'Or type a reply…': '或输入回复…',
  'Type your reply…': '输入回复…',
  'Send reply': '发送回复',
  'Type your answer': '输入回答',
  Queued: '已排队',
  'Copy message': '复制消息',
  'Scroll this message to top': '将此消息滚动到顶部',
  'Agent is working': 'Agent 正在工作',
  Submit: '提交',
  'Step {{step}}': '第 {{step}} 步',
  'Other…': '其他…',
  'Send answer': '发送回答',
  Next: '下一步',
  'Back to worktrees': '返回 worktree 列表',
  'Open file explorer': '打开文件浏览器',
  'Open source control': '打开源代码管理',
  'More session actions': '更多会话操作',
  'Dismiss workspace creation warning': '关闭工作区创建警告',
  'Dismiss keyboard': '收起键盘',
  'Paste from clipboard': '从剪贴板粘贴',
  'Add custom shortcut': '添加自定义快捷键',
  'Show keyboard for live terminal input': '显示实时终端输入键盘',
  'Terminal name': '终端名称',
  'Not connected to desktop host': '未连接桌面主机',
  'Failed to list Botmux sessions': '获取 Botmux 会话失败',
  'No Botmux endpoints connected on desktop': '桌面端未连接 Botmux endpoint',
  '{{hosts}} host(s) · {{sessions}} session(s)': '{{hosts}} 个主机 · {{sessions}} 个会话',
  'Type a command…': '输入命令…',
  'Send command': '发送命令',
  'New tab': '新建标签页',
  'Quick commands': '快捷命令',
  'Search quick commands...': '搜索快捷命令…',
  'No quick commands yet.': '尚无快捷命令。',
  'No matching quick commands.': '没有匹配的快捷命令。',
  'This project': '当前项目',
  Global: '全局',
  'New quick command': '新建快捷命令',
  'Quick command limit reached': '已达到快捷命令数量上限',
  'Run {{label}}': '运行 {{label}}',
  'Edit {{label}}': '编辑 {{label}}',
  'Delete {{label}}': '删除 {{label}}',
  'Terminal Command': '终端命令',
  'Agent Prompt': 'Agent 提示词',
  Action: '操作',
  'Choose agent': '选择 Agent',
  Prompt: '提示词',
  'Command Text': '命令文本',
  'Ask the agent to investigate this workspace': '让 Agent 调查此工作区',
  'Supports skills, file paths, and built-in commands.': '支持技能、文件路径和内置命令。',
  'Append Enter': '追加回车',
  'Submit immediately instead of only inserting text.': '立即提交，而不是只插入文本。',
  Scope: '作用域',
  Project: '项目',
  'Add Quick Command': '添加快捷命令',
  'Edit Quick Command': '编辑快捷命令',
  'Choose Agent': '选择 Agent',
  'Quick Commands': '快捷命令',
  'Save terminal commands or agent prompts for quick access.':
    '保存终端命令或 Agent 提示词，以便快速使用。',
  Untitled: '未命名',
  'Delete "{{label}}"?': '要删除“{{label}}”吗？',
  'This quick command will be removed from your saved list.': '此快捷命令将从已保存列表中移除。',
  'Add review note': '添加审查备注',
  'Save note': '保存备注',
  'Add a comment': '添加评论',
  Reply: '回复',
  'Create Issue': '创建 Issue',
  'Connect to a host to load tasks': '连接主机后加载任务',
  'No matching tasks': '没有匹配的任务',
  'No GitHub tasks': '没有 GitHub 任务',
  'No GitLab tasks': '没有 GitLab 任务',
  'No Linear tasks': '没有 Linear 任务',
  'Source: {{source}}': '来源：{{source}}',
  'Sort: {{sort}}': '排序：{{sort}}',
  'Fields: {{fields}}': '字段：{{fields}}',
  'Group: {{group}}': '分组：{{group}}',
  'Order: {{order}}': '顺序：{{order}}',
  Display: '显示',
  'Project MRs': '项目 MR',
  'My Todos': '我的待办',
  'Open view in GitHub': '在 GitHub 中打开视图',
  'Search project view...': '搜索项目视图…',
  'Search {{provider}} tasks...': '搜索 {{provider}} 任务…',
  'Preferred issue source upstream is unavailable for {{repo}}. Using origin.':
    '{{repo}} 的首选 issue 上游不可用，已改用 origin。',
  "Couldn't load issues from {{source}}.": '无法从 {{source}} 加载 issue。',
  'Retry loading issues from {{source}}': '重试从 {{source}} 加载 issue',
  'Retrying...': '正在重试…',
  'Sub-issue data is unavailable for your token.': '当前 token 无法访问子 issue 数据。',
  'Update Botmux desktop': '更新 Botmux Desktop',
  'This mobile Tasks view needs a newer desktop runtime.':
    '移动端任务视图需要更新版本的桌面运行时。',
  'Connect your Linear account': '连接 Linear 账户',
  'Browse and start work on your assigned Linear issues directly from Tasks.':
    '直接在任务页中浏览并开始处理分配给你的 Linear issue。',
  'Connect Linear': '连接 Linear',
  'Choose a GitHub project': '选择 GitHub 项目',
  'Browse projects': '浏览项目',
  'No project items': '没有项目条目',
  'Choose which repositories to query.': '选择要查询的仓库。',
  'All repositories': '全部仓库',
  'GitHub Issue Sources': 'GitHub Issue 来源',
  'No alternate issue sources available.': '没有可用的备用 issue 来源。',
  'GitHub Pages': 'GitHub 分页',
  'Jump to a loaded or available result page.': '跳转到已加载或可用的结果页。',
  'GitHub Projects': 'GitHub 项目',
  'Choose a project view for the Tasks page.': '为任务页选择项目视图。',
  'No projects loaded': '尚未加载项目',
  'Tap to retry.': '点击重试。',
  Pinned: '已置顶',
  'Project Fields': '项目字段',
  'This view has no extra fields to show.': '此视图没有可显示的额外字段。',
  'Linear Teams': 'Linear 团队',
  'Choose which teams appear in Tasks.': '选择在任务页中显示的团队。',
  'All teams': '全部团队',
  'Change Status': '更改状态',
  'Loading states...': '正在加载状态…',
  'No states available': '没有可用状态',
  'Display Properties': '显示属性',
  'Issue source': 'Issue 来源',
  Title: '标题',
  Description: '描述',
  'Connect Linear workspace': '连接 Linear 工作区',
  'Personal API key': '个人 API key',
  'SSH Connection': 'SSH 连接',
  'Start From': '起始位置',
  'Pick an existing branch or ref.': '选择现有分支或 ref。',
  "Use this repository's configured base": '使用此仓库配置的基础分支',
  'No branches match.': '没有匹配的分支。',
  'Sparse Checkout': '稀疏检出',
  'Use the whole repository': '使用整个仓库',
  'New preset': '新建预设',
  Directories: '目录',
  'Create Workspace': '创建工作区',
  Agent: 'Agent',
  Advanced: '高级',
  'Start from': '起始位置',
  'Default branch': '默认分支',
  'Full checkout': '完整检出',
  'Workspace Name': '工作区名称',
  '[Optional]': '[可选]',
  'Run Setup Script?': '运行初始化脚本？',
  'Skip setup and create': '跳过初始化并创建',
  'Run hooks': '运行 hooks',
  "Don't run": '不运行',
  'Always trust and run': '始终信任并运行'
}

export function detectDeviceLanguageTag(): string {
  try {
    if (Platform.OS === 'ios') {
      const settings = NativeModules.SettingsManager?.settings
      const raw =
        settings?.AppleLocale ??
        (Array.isArray(settings?.AppleLanguages) ? settings.AppleLanguages[0] : null)
      if (typeof raw === 'string' && raw.trim()) {
        return raw
      }
    }
    const locale =
      NativeModules.I18nManager?.localeIdentifier ??
      NativeModules.I18nManager?.locale ??
      (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().locale : 'en')
    return String(locale || 'en')
  } catch {
    return 'en'
  }
}

export function resolveMobileLocale(
  preference: MobileLanguagePreference,
  deviceLanguageTag = detectDeviceLanguageTag()
): MobileLocale {
  if (preference !== 'system') {
    return preference
  }
  return /^zh(?:[-_]|$)/i.test(deviceLanguageTag) ? 'zh-CN' : 'en'
}

export function isMobileLanguagePreference(value: unknown): value is MobileLanguagePreference {
  return value === 'system' || value === 'en' || value === 'zh-CN'
}

export function translateMobile(
  locale: MobileLocale,
  message: string,
  values?: MobileTranslationValues
): string {
  const template = locale === 'zh-CN' ? (ZH_CN[message] ?? message) : message
  if (!values) {
    return template
  }
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  )
}

export async function loadMobileLanguagePreference(): Promise<MobileLanguagePreference> {
  try {
    const stored = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)
    return isMobileLanguagePreference(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

export async function saveMobileLanguagePreference(
  preference: MobileLanguagePreference
): Promise<void> {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, preference)
}

type MobileI18nContextValue = {
  locale: MobileLocale
  languagePreference: MobileLanguagePreference
  setLanguagePreference: (preference: MobileLanguagePreference) => void
  t: (message: string, values?: MobileTranslationValues) => string
}

// English is also the safe fallback for isolated component renders (tests,
// previews, and future embedded surfaces) that do not mount the app root.
const FALLBACK_I18N: MobileI18nContextValue = {
  locale: 'en',
  languagePreference: 'system',
  setLanguagePreference: () => {},
  t: (message, values) => translateMobile('en', message, values)
}

const MobileI18nContext = createContext<MobileI18nContextValue>(FALLBACK_I18N)

export function MobileI18nProvider({ children }: { children: ReactNode }) {
  const [languagePreference, setLanguagePreferenceState] =
    useState<MobileLanguagePreference>('system')
  const [deviceLanguageTag] = useState(detectDeviceLanguageTag)

  useEffect(() => {
    let active = true
    void loadMobileLanguagePreference().then((stored) => {
      if (active) {
        setLanguagePreferenceState(stored)
      }
    })
    return () => {
      active = false
    }
  }, [])

  const locale = resolveMobileLocale(languagePreference, deviceLanguageTag)
  const setLanguagePreference = useCallback((preference: MobileLanguagePreference) => {
    setLanguagePreferenceState(preference)
    void saveMobileLanguagePreference(preference).catch(() => {})
  }, [])
  const t = useCallback(
    (message: string, values?: MobileTranslationValues) => translateMobile(locale, message, values),
    [locale]
  )
  const value = useMemo(
    () => ({ locale, languagePreference, setLanguagePreference, t }),
    [languagePreference, locale, setLanguagePreference, t]
  )

  return <MobileI18nContext.Provider value={value}>{children}</MobileI18nContext.Provider>
}

export function useMobileI18n(): MobileI18nContextValue {
  return useContext(MobileI18nContext)
}

export function mobileLocaleDisplayName(locale: MobileLocale, uiLocale: MobileLocale): string {
  return translateMobile(uiLocale, locale === 'zh-CN' ? 'Simplified Chinese' : 'English')
}
