# Agent Workbench 集成实现与验收

> 状态：Preview backend、H5 auth/control 与 Workbench UI 已在 `feat/agent-workbench` 完成集成、构建和本地浏览器验证。
> 日期：2026-08-11。
> 边界：本次没有启动或重启 live daemon，没有使用真实飞书凭据，没有修改开放平台配置，没有部署、push、建 PR 或访问真实飞书后端。

## 1. 交付结论

Agent Workbench v1 是 Dashboard 内的单会话操作工作区，已经提供两个懒加载入口：

| Surface | Hash route | 用途 |
|---|---|---|
| Full Workbench | #/agent-workbench[/<encoded-session-id>] | appCenter 主界面，含 Sessions、Terminal、Web、Info 与原生 Chat 控制。 |
| Quick Dock | #/agent-workbench-dock[/<encoded-session-id>] | PC 侧边栏辅助入口，只提供会话摘要、跳转和 fallback，不渲染 Terminal/Web pane。 |

实现继续复用现有 /api/sessions 快照、/events SSE、/s/<sessionId> Terminal 代理、daemon registry 和 session store。没有新增 Agent CLI adapter、终端协议、会话状态机或第二套聊天 UI；现有 Dashboard、Sessions、Groups/session-group-mode、Monitor Room、Settings 与 v3 路由保持注册。

最重要的产品边界：

- Chat 始终由飞书客户端控制，通过 toggleChat、enterChat 或 AppLink 打开；H5 里没有自绘聊天面板。
- Terminal 默认只读，写控制由服务端短租约决定，浏览器拿不到 write grant。
- Web 默认是带可见标签的 Preview；交互必须显式解锁，15 分钟无操作后回锁。
- Preview 蒙层只防误触，不是应用级强只读、安全沙箱或不可信代码隔离边界。

## 2. 使用方式

### 2.1 打开 Workbench

完成 Dashboard 登录后，可以直接进入：

~~~text
https://<dashboard-host>/#/agent-workbench
https://<dashboard-host>/#/agent-workbench/<encoded-session-id>
https://<dashboard-host>/#/agent-workbench-dock/<encoded-session-id>
~~~

H5 入口只接受同站 Workbench returnTo，其他路径、控制字符、超长或损坏编码都会回退到根路径：

~~~text
https://<dashboard-host>/auth/feishu?returnTo=/#/agent-workbench/<encoded-session-id>
~~~

Full Workbench 的基本流程：

1. 在 Sessions rail 搜索并选择会话。
2. Terminal 先以 READ ONLY 打开；需要输入时点击 Take control。
3. Agent 在自己的 Botmux 会话内注册 Web 开发服务器后，Web pane 才出现。
4. Web pane 初始显示 PREVIEW；点击 Unlock interaction 后进入 INTERACTIVE。
5. Chat 按能力依次走 toggleChat、enterChat、AppLink，不进入 pane tree。

### 2.2 注册会话 Web 预览

在目标 Botmux 会话内运行：

~~~bash
botmux preview <port>
~~~

命令只允许当前会话和一个合法 TCP 端口；没有 --session、--host 或任意 URL 参数。成功只打印同源路径：

~~~text
/preview/<encoded-session-id>/
~~~

无效端口在联系 daemon 前被拒绝；未注册端口、不可达端口和失活会话返回稳定错误，不打印 loopback target、capability 或 daemon credential。

### 2.3 响应式布局

- 桌面 rail 默认 200px，可在 176–280px 内调整，折叠宽度 40px。
- L1 为单个 Terminal 或 Web；L2 为一个自有 pane 加原生 Chat；L3 为 Terminal/Web 分屏加可选原生 Chat。
- pane splitter 限制为 28–72%，支持指针和键盘方向键。
- 小于 1280px 折叠 rail；小于 1120px 强制 Focus；小于 960px 将 Chat 降级成跳转；小于 768px 固定为 Sessions、Workspace、Info 单页栈。
- 移动端 Sessions 页始终渲染完整列表，不继承桌面折叠 rail。
- 每个 session 只持久化布局原语；URL、cookie、grant、iframe 状态和身份信息不进入 localStorage。

## 3. 配置

功能默认关闭，配置不完整时 fail closed。示例值必须替换为非生产测试应用的真实值，且 App Secret 只放服务端环境：

~~~dotenv
BOTMUX_DASHBOARD_FEISHU_H5_ENABLED=true
BOTMUX_DASHBOARD_FEISHU_H5_BRAND=feishu
BOTMUX_DASHBOARD_FEISHU_H5_APP_ID=cli_example
BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET=replace-on-server
BOTMUX_DASHBOARD_FEISHU_H5_ALLOWED_OPEN_IDS=ou_allowed_a,ou_allowed_b
BOTMUX_DASHBOARD_FEISHU_H5_ENTRY_PATH=/auth/feishu
BOTMUX_DASHBOARD_FEISHU_H5_SESSION_TTL_MS=1800000
BOTMUX_DASHBOARD_FEISHU_H5_SECURE_COOKIE=true
BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS=300000
BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH=/var/lib/botmux/audit/dashboard-control.ndjson
BOTMUX_PUBLIC_URL=https://<dashboard-host>
~~~

| 变量 | 默认值或约束 | 说明 |
|---|---|---|
| BOTMUX_DASHBOARD_FEISHU_H5_ENABLED | false | 显式启用 H5 登录入口。 |
| BOTMUX_DASHBOARD_FEISHU_H5_BRAND | feishu；可选 lark | 选择开放平台 API host。 |
| BOTMUX_DASHBOARD_FEISHU_H5_APP_ID / APP_SECRET | 空 | 服务端换码凭据；缺一即 503。 |
| BOTMUX_DASHBOARD_FEISHU_H5_ALLOWED_OPEN_IDS | 空；逗号分隔、精确匹配 | 唯一登录 allowlist；空列表拒绝所有人。 |
| BOTMUX_DASHBOARD_FEISHU_H5_ENTRY_PATH | /auth/feishu | 仅允许安全的绝对 path，不接受 query token。 |
| BOTMUX_DASHBOARD_FEISHU_H5_SESSION_TTL_MS | 30 分钟；1 分钟至 24 小时 | 固定有效期，不滑动续期。 |
| BOTMUX_DASHBOARD_FEISHU_H5_SECURE_COOKIE | HTTPS public URL 时自动 true | TLS 在外层终止时应显式设为 true。 |
| BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS | 5 分钟；10 秒至 15 分钟 | 单次控制租约，受 H5 session 更早到期时间约束。 |
| BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH | ~/.botmux/audit/dashboard-control.ndjson | 0700 目录、0600 append-only NDJSON。 |

本次只验证配置解析与模拟链路，没有把这些值写入运行中的服务。

## 4. 接口契约

### 4.1 H5 登录

| Method/path | 成功行为 | 主要失败 |
|---|---|---|
| GET <entryPath> | 返回 no-store 登录页，动态加载 SDK，等待 h5sdk.ready；优先 requestAccess，errno 103 或缺少方法时回退 requestAuthCode。 | 404 h5_auth_disabled；503 h5_auth_not_configured。 |
| POST <entryPath>/exchange | 接收 JSON code，服务端换 open_id，精确 allowlist 后设置短会话 cookie。 | 400 invalid_authorization_code；403 open_id_not_allowed；502 feishu_exchange_failed。 |
| GET <entryPath>/session | 返回 openId 与固定 expiresAt。 | 401 authentication_required。 |
| POST <entryPath>/logout | 注销 cookie，并回收该 auth session 的 Terminal 租约和 Preview 解锁。 | 401 authentication_required。 |
| GET /api/workbench/h5-context | 仅向已认证页面返回 enabled、appId、brand、entryPath。 | 未认证按 Dashboard auth gate 拒绝。 |

客户端 SDK、ready、JSAPI 和换码合用 8 秒有界等待；Retry 会中止旧 fetch、移除旧 script，并用 generation 忽略迟到 callback。没有 SDK、SDK 加载失败、ready 超时或 JSAPI 失败都会显示可重试错误，不会留在无限 spinner。

短会话 cookie 为 32 字节随机 opaque 值，属性为 HttpOnly、SameSite=Lax、Path=/，按配置增加 Secure。服务端只保留带 domain separator 的 SHA-256 digest；Dashboard 重启会有意注销内存会话。

客户端把本地 Dashboard owner 权限与窄 Workbench 权限分开：有效 H5/platform 身份可以使用 Workbench 的 Terminal/Preview 租约，但不会因此获得 Dashboard 管理权限。服务端用 `x-botmux-auth-scope: workbench` 标记预期的管理接口拒绝，SPA 不会把它误报成登录过期；真正过期、没有该标记的 401 仍打开登录提示。

`/api/sessions/:id/preview` 使用独立的 `preview.view` capability，不再借用 `terminal.view`：只观察网页预览的身份不会顺带拿到终端读权限。

### 4.2 Terminal 控制

| Method/path | 响应与语义 |
|---|---|
| GET /api/sessions/:id/control | readonly/controlled、owned、可选 expiresAt。 |
| POST /api/sessions/:id/control/takeover | 当前 auth session 获取固定期限租约；同一持有者复用但不续期；其他持有者得到 409 control_busy。 |
| POST /api/sessions/:id/control/release | 仅持有者释放；成功明确返回 owned:false。 |

常见失败为 400 invalid_session_id、401 authentication_required、404 unknown_session、409 session_not_active / terminal_external_only / terminal_unavailable、503 daemon_offline。

central proxy 只在 loopback hop 注入签名 read/write grant。租约释放、到期、写 WebSocket 断开、H5 logout/expiry 或 legacy Dashboard token rotation 都会删除租约并关闭登记的写 socket；后续连接回到只读。H5 用户不能通过 legacy write-link 绕过接管。

### 4.3 Preview 注册、代理与交互

| Method/path | 响应与语义 |
|---|---|
| POST /api/sessions/:id/preview | daemon 内部注册当前会话 literal loopback port；成功只返回 browser-safe path 与 registeredAt。 |
| GET /api/sessions/:id/preview | private metadata，只返回同一 browser-safe descriptor。 |
| /preview/:sessionId/* | 已认证同源 HTTP/WS 反向代理；exact owner/session/target 校验。 |
| GET /api/sessions/:id/preview-interaction | 返回 preview 或 interactive、可见 label、securityNotice 与可选 idleExpiresAt。 |
| POST .../unlock | 显式进入 interactive，启动 15 分钟 idle deadline。 |
| POST .../activity | 仅对仍有效的 interactive lease 延长 idle deadline。 |
| POST .../lock | 显式回到 preview。 |

交互状态按 authSessionId + sessionId 隔离。UI 为每个 session 建立新的 generation，旧 refresh/activity 响应不能覆盖新选择或显式 Lock；切换 session 会卸载旧 pane。titlebar 内的 Lock/Unlock 点击不会冒泡成 activity。

注册与代理的稳定失败包括 invalid_port、origin_unproven、managed_action_required、remote_host_forbidden、session_not_active、preview_not_registered、preview_unreachable、invalid_preview_target 与 method_not_allowed。损坏 descriptor 或跨 session path 在浏览器 adapter 处也会 fail closed。

## 5. 安全边界

### 5.1 身份与秘密

- App Secret、飞书 app/user access token、authorization code、Dashboard cookie、daemon HMAC、Terminal grant 和 preview target 不进入浏览器 DTO、URL hash、localStorage、SSE、审计或日志。
- H5 allowlist 使用 open_id 精确匹配；空列表不是“允许所有人”。
- control、preview interaction、preview proxy 与 H5 context 都不在 publicReadOnly allowlist。
- Browser API adapter 对 response shape 做运行时校验；非法 mode、deadline、owned、securityNotice 或 H5 context 以 502 型客户端错误 fail closed。
- 审计只记录时间、open_id、session、窄 action 与 Terminal 输入 UTF-8 字节数，不记录输入正文。

### 5.2 Preview SSRF 与浏览器边界

- target 只允许 literal 127.0.0.1 或 ::1 加合法端口，不能注册 DNS 名称、remote URL 或任意 host。
- HTTP 与 WebSocket 使用相同认证、owner resolution、runtime revalidation 和 2 秒连接/响应头上限。
- 转发前删除 Cookie、Authorization、Proxy-Authorization、Referer、Forwarded、全部 X-Forwarded-* 与 X-Botmux-*；Host/Origin 重写为验证后的 loopback target。
- upstream Set-Cookie 与 Clear-Site-Data 被删除，响应统一 no-store、no-referrer。
- 代理不改写应用 body；应用必须支持 /preview/<sessionId>/ base path或相对资源。

Preview guard 的覆盖层不是安全沙箱。同源应用脚本仍可能主动发网络请求或产生副作用。若要运行不可信应用，必须设计独立 origin、容器和应用级授权，不能依赖蒙层或把它表述为强只读。

### 5.3 Chat 边界

openWorkbenchChat 的顺序为：

1. 适合 PC 分栏且 capability 存在时调用 toggleChat({ openChatId })。
2. 不支持或失败时调用 enterChat({ openChatId })。
3. 再失败时打开 /client/chat/open?openChatId=… AppLink。

每个 JSAPI 有 throw、fail callback 和 timeout 处理。普通浏览器不主动加载飞书 SDK，并安全降级到 AppLink。sidebar AppLink 使用 mode=sidebar、min_width=350、max_width=520；主界面使用 mode=appCenter。Chat 不作为 iframe 或自定义 H5 pane 渲染。

## 6. 集成收口修复

集成审计中额外修复了以下真实契约、竞态和兼容问题：

- Terminal takeover/release 响应补齐 owned:true/false，UI 同时兼容旧响应并严格验证新响应。
- Terminal 写 WebSocket 使用租约 generation 标记封闭 takeover/握手竞态；UI 每 15 秒及租约精确截止点刷新，断连、释放或到期立即回到只读。
- Preview interaction 统一使用服务端 securityNotice，移除 UI 的 warning 字段错配。
- Preview descriptor 必须精确等于所选 session 的 /preview/<encoded-id>/，防止损坏或跨会话 metadata 被渲染。
- 所有 control/preview/H5 browser response 增加运行时 shape 校验。
- Workbench pane 以 sessionId 作为 React key，阻断切换会话后的异步状态串线。
- Workbench 选中态不再被旧 initialSessionId 拉回；搜索会重置虚拟列表，锁定的响应式 rail/split 控件也不再暴露误导 affordance。
- Preview refresh、activity、unlock、lock 使用单调 request generation；外层标签与 iframe guard 同步，轮询和 listener 去重，并在精确 idle deadline 回锁。
- H5 SDK 改为动态有界加载，并修复在 h5sdk.ready callback 前过早清除 timeout 的问题。
- H5 exchange 只接受 JSON；登录页、guard 与 Workbench 使用扁平语义样式，不依赖 `:has()`，CSP 仅允许官方飞书/Lark ancestor。
- Preview HTTP/WS 代理删除 hop-by-hop、认证、cookie 与转发身份头；SSE 丢弃没有内部 target 的注入或过期 preview descriptor。
- legacy Dashboard write-link 仅保留精确旧身份兼容，显式校验 token/viewToken，并从 worker query 与代理请求中剥离管理 cookie。
- Chat 与 Dock AppLink 只接受安全 host/path 和精确 openChatId；响应式降级使用实际 Chat 状态，窄屏明确显示 `CHAT · NATIVE JUMP`。
- Riff external-terminal 与 preview descriptor 均 fail closed；teardown 即使审计 sink 失败也会完成能力回收。
- WebPane 使用可清理 interval 和 document guard，兼容测试/SSR。
- 移动端不再继承桌面 collapsed rail，Sessions tab 恢复完整列表。
- Web UI 持续显示 securityNotice；测试锁定蒙层弱边界文案。
- 截图和浏览器 fixture 的 H5 entryPath 统一为 /auth/feishu。
- 全量测试中加固了两个既有基础设施用例：PID namespace 回归测试用唯一 argv marker 定位宿主 helper，重载 group-routing suite 的导入 hook 使用独立 30 秒上限。

## 7. 影响面与兼容性

| 区域 | 影响 | 兼容性 |
|---|---|---|
| Dashboard SPA | 新增 Full/Dock lazy routes、组件、样式与导航。 | 原有 route 保留；两个入口有独立 chunk。 |
| central Dashboard | 新增 H5、control、preview interaction、H5 context 接口和 Terminal/Preview proxy 接线。 | 默认 H5 关闭；public-read 不扩大。 |
| daemon / CLI | 增加当前会话 botmux preview <port> 与 preview descriptor 传播。 | 无 --session/--host；旧会话无 preview 时正常降级。 |
| worker Terminal | 验证 central 注入的短期 read/write grant，并在断连/到期回收写连接。 | PTY、tmux、zellij、Herdr、Riff 共用 gate；Riff 仍 external-only。 |
| Session store / SSE | 内部保存 preview target，浏览器只看安全 descriptor。 | REST/SSE 使用同一投影；匿名投影移除 preview。 |
| Feishu/Lark | 原生 Chat 能力与 AppLink；H5 免登入口。 | 未修改任何真实开放平台或客户端配置。 |
| 审计 | 新增 dashboard-control NDJSON。 | 输入只记字节数；默认 sink I/O 策略需生产运维确认。 |

## 8. 验证结果

### 8.1 静态、构建与单元/集成测试

| 检查 | 结果 |
|---|---|
| pnpm build | 通过；domain audit、TypeScript、runtime build id、Dashboard bundle、dist audit 全绿。最终 build id：20eef27b5357。 |
| pnpm exec tsc --noEmit / git diff --check | 通过。 |
| Workbench 直接边界 | 22 files、203 tests 通过，覆盖 UI、auth、control、Preview、Terminal、CLI、IPC、REST/SSE 与代理。 |
| 纯模型 runner | 通过：320 sessions、19 virtual items；覆盖 rail-collapsed、focus、chat-jump、mobile-stack。 |
| 组件 runner | 通过：9 component checks、12 rendered session options。 |
| pnpm test 全量 unit project | 742 files / 11,216 tests 通过，1 file / 5 tests 按仓库既有条件跳过；0 failed。串行耗时 326.86 秒。 |

全量命令为 `pnpm test -- --maxWorkers=1 --no-file-parallelism`。由于验证本身运行在活跃 Botmux workflow 内，进程发现类测试使用清空 BOTMUX 上下文的环境、私有 PID `/proc` 和独立 `TMUX_TMPDIR`，避免把外层同 UID worker 误当成 fixture；串行执行也消除了 `/proc` 瞬态并发噪声。这是测试进程隔离，不会修改或重启 live daemon。

### 8.2 本地真实浏览器场景

浏览器脚本使用本机 Chromium headless shell、真实 React Workbench、真实 H5 controller、TerminalControlManager、PreviewInteractionManager、Preview guard/proxy，以及本地 loopback HTTP/WS fixture。没有连接真实飞书后端。

| 场景 | 结果 |
|---|---|
| H5 成功 | 通过 |
| H5 provider/allowlist 失败 | 通过 |
| H5 超时 | 通过 |
| 无飞书 SDK | 通过 |
| Workbench 成功、Terminal/Web、Chat fallback | 通过 |
| Workbench API/preview 失败 | 通过 |
| 未授权 | 通过 |
| 1280 桌面、390×844 与 375×800 移动、sidebar | 通过 |
| Preview 注册、无效/未注册端口、不可达与代理边界 | 通过 |
| Preview WebSocket | 通过 |
| Terminal 写 WebSocket 断连后回只读 | 通过 |
| Preview interaction idle timeout 回锁 | 通过 |

机器可读结果见 assets/agent-workbench-browser-results.json。

### 8.3 截图

![Agent Workbench 1440×900 dark screenshot](assets/agent-workbench-dark.png)

截图使用 320 条合成 session metadata、本地 mock Terminal/Web 和 1440×900 viewport；可见 15 条虚拟列表行，pane mode 为 split，responsive state 为 full。它不含真实 session、用户、token 或凭据。

## 9. 未验证项与五类人工飞书 Spike

以下项目必须在非生产飞书/Lark 应用、HTTPS 测试域名和专用测试账号上执行。本次没有真实 App ID/Secret、租户、客户端或 platform tunnel，因此全部明确标记为未验证。每个 Spike 都应记录客户端版本、操作系统、时间、screen recording、网络请求状态、JSAPI errno 和最终 UI 状态；证据中不得包含 code、cookie、App Secret 或 access token。

### Spike 1 — PC toggleChat

前置：发布测试 H5 应用，可信域名指向测试 Dashboard；准备一个有 openChatId 的测试会话，窗口宽度至少 1280px。

1. 从飞书 PC appCenter 打开 Full Workbench 并选择该会话。
2. 在客户端调试工具确认 window.tt.toggleChat 存在，但不要输出任何身份 token。
3. 点击 Chat，观察原生聊天是否进入客户端右侧 slot，Workbench 自有区域是否仍只含 Terminal/Web。
4. 连续执行打开、关闭、再次打开，并切换 session 验证 openChatId 跟随当前会话。
5. 将窗口缩到 959px 以下，确认 UI 改为 Chat jump，不再请求 split。

通过条件：toggleChat success callback 到达；右侧是飞书原生 Chat；页面没有自绘 H5 Chat；失败/超时有可见 fallback，不阻塞 Workbench。

### Spike 2 — enterChat 与 AppLink fallback

准备三种客户端/能力条件：不支持 toggleChat、toggleChat fail callback、toggleChat 与 enterChat 都失败。

1. 在不支持 toggleChat 的版本点击 Chat，确认直接调用 enterChat({ openChatId })。
2. 在可注入测试错误的客户端调试环境让 toggleChat 返回 fail，确认随后调用 enterChat。
3. 再让 enterChat fail 或超时，确认打开 /client/chat/open?openChatId=… AppLink。
4. 使用损坏或缺失 openChatId 的合成测试会话，确认显示稳定错误且不拼接任意 URL。
5. 检查新窗口/跳转使用 noopener 语义，URL 中没有 H5 code、cookie 或 Dashboard token。

通过条件：顺序严格为 toggleChat → enterChat → AppLink；每步只有一次有效完成；迟到 callback 不重复跳转；Chat 仍由客户端原生 surface 承载。

### Spike 3 — PC sidebar 宽度与 Dock

前置：在开放平台测试版本配置 sidebar AppLink，mode=sidebar、min_width=350、max_width=520，目标为 Dock route。

1. 从 PC 客户端侧边栏打开 #/agent-workbench-dock/<sessionId>。
2. 分别在 350px、400px、520px 观察布局；尝试缩到 350px 以下和扩到 520px 以上，记录客户端实际限制。
3. 验证 Dock 只显示摘要、Chat、Terminal/Web fallback 与 Open in appCenter，不渲染 pane tree 或 iframe。
4. 点击 Open in appCenter，确认目标是 Full Workbench 且 sessionId 编码保持一致。
5. 分别验证 session missing、Terminal unavailable、preview unregistered 的可恢复提示。

通过条件：350–520px 内无横向溢出；Dock 不偷偷渲染 Terminal/Web/Chat；appCenter handoff 正确；真实客户端宽度行为有截图和版本记录。

### Spike 4 — iOS/Android 免登与移动布局

前置：一台 iOS、一台 Android，至少一个支持 requestAccess 的当前版本；如可获得旧版本，再覆盖 requestAuthCode fallback。

1. 在飞书内打开 /auth/feishu?returnTo=/#/agent-workbench/<sessionId>，确认 requestAccess 成功后回到目标 session。
2. 在缺少 requestAccess 或返回 errno 103 的客户端确认 requestAuthCode fallback。
3. 用系统浏览器打开同一 H5 URL，确认无 SDK 时 8 秒内进入可重试错误，而不是无限等待。
4. 在约 390×844 与 375×800 竖屏检查 Sessions、Workspace、Info 三个固定页面；Sessions 必须显示完整列表。
5. 覆盖 allowlist 拒绝、provider 失败、网络超时、Retry、前后台切换和 logout；确认迟到 callback 不会越过最新 attempt。

通过条件：成功、失败、超时、无 SDK 都有确定终态；移动页面无不可达控件或横向滚动；失败不设置 session cookie。

### Spike 5 — 真实应用白名单、allowlist 与 SSO 免登

前置：只使用非生产应用；准备 allowlisted 用户 A、未 allowlisted 用户 B 和管理员可查看的服务端审计目录。App Secret 通过 secret manager 注入，不写入仓库、截图或命令历史。

1. A 从飞书入口登录，确认 exchange 返回 200、cookie 为 HttpOnly/SameSite=Lax/Secure、session endpoint 返回 A 的 open_id 和固定 expiresAt。
2. B 登录，确认 403 open_id_not_allowed、没有 Set-Cookie，审计只有 login_denied。
3. 将 A 从 allowlist 移除后重新登录，确认新登录被拒绝；记录现有内存 session 是否按既定运营策略等待到期或主动 logout。
4. A 获取 Terminal control 后执行 logout，确认写 WS 被关闭、control 回 readonly、preview 回锁。
5. 用缩短但仍合法的 H5/Terminal TTL 验证固定到期，不允许 takeover 续期；Dashboard 重启后旧 H5 cookie 应失效。
6. 在反向代理层确认真实 HTTPS Host、Secure cookie 和 WebSocket upgrade；检查日志、审计、浏览器 URL、SSE 与 screenshot 均无 secret/code/token。

通过条件：A 成功、B 精确拒绝；cookie 与到期符合配置；logout/expiry/restart 都回收能力；服务端和浏览器证据无秘密泄漏。

## 10. 仍需运营决策

- 审计文件保留期、轮转、采集失败告警，以及是否从默认 best effort 提升为输入路径 fail closed。
- 真实飞书/Lark 客户端最低版本与 requestAccess/requestAuthCode 支持矩阵。
- 同源 Preview 只承载受信本机开发应用；若需求扩展到不可信应用，先设计独立 origin 和隔离容器。
- 生产部署、真实凭据、开放平台发布与 live daemon 操作必须走独立变更审批，不属于本交付。
