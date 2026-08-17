# Agent Workbench 集成实现与验收

> 状态：Preview backend、H5 auth/control 与 Workbench UI 已在 `feat/agent-workbench` 完成集成、构建和本地浏览器验证。
> 日期：2026-08-17（合并 origin/master 后复跑 workbench / components / browser / capture 四套验收脚本，全部通过）。
> 边界：本次没有启动或重启 live daemon，没有使用真实飞书凭据，没有修改开放平台配置，没有部署、push、建 PR 或访问真实飞书后端。

## 1. 交付结论

Agent Workbench v1 是 Dashboard 内的单会话操作工作区，已经提供两个懒加载入口：

| Surface | Hash route | 用途 |
|---|---|---|
| Full Workbench | #/agent-workbench[/<encoded-session-id>] | appCenter 主界面：分组会话列表 + 单终端工作区；窄屏为 终端/网页/信息 下钻。 |
| Quick Dock | #/agent-workbench-dock[/<encoded-session-id>] | PC 侧边栏辅助入口：会话列表、所选会话摘要与 聊天/终端/网页 链接及 appCenter 跳转，不渲染任何 pane iframe。 |

实现继续复用现有 /api/sessions 快照、/events SSE、/s/<sessionId> Terminal 代理、daemon registry 和 session store。没有新增 Agent CLI adapter、终端协议、会话状态机或第二套聊天 UI；现有 Dashboard、Sessions、Groups/session-group-mode、Monitor Room、Settings 与 v3 路由保持注册。

最重要的产品边界：

- Chat 始终由飞书客户端承载：入口是行内真实 AppLink 锚点（target=_blank rel=noopener），H5 里没有自绘聊天面板，也不调用 toggleChat/enterChat JSAPI。
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

1. 在会话列表搜索并选择会话；支持六个分组维度（状态/机器人/会话位置/类型/CLI/活跃时间）、组折叠与未读标记。
2. 行内操作：「聊天」是真实锚点，交给飞书客户端原生打开；「定位」（仅话题会话）让 bot 在话题里 @ 你，按钮与服务端限流对齐、30 秒冷却；「终端」以只读打开工作区终端；「接管」打开终端并自动请求写权限。
3. 工作区一次只有一个终端面板：释放、到期或断连回到只读，「关闭终端」后列表重新铺满。触屏与未登录浏览器走只读 viewToken 通道，不提供接管。
4. Agent 在自己的 Botmux 会话内注册 Web 开发服务器后，窄屏详情才出现「网页」页；网页预览默认「预览」蒙层，「开启交互」显式解锁，15 分钟无操作回锁。桌面工作区只承载终端，网页预览经会话坞的「网页链接」或直接访问 /preview/<encoded-session-id>/ 打开，由同源 guard shell 维持蒙层与解锁。

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

- 桌面 rail 默认 300px，可在 176–460px 内拖拽或键盘调整，折叠宽度 40px；是否折叠是用户自己的选择（≥1280px 的 full 档提供开关），窗口变窄不再自动折叠列表。
- 工作区最多一个终端面板；分屏、布局级别徽标、信息抽屉与页内聊天挂件均已按验收结论移除，面板关闭时会话列表铺满整页。
- 模型仍按 1280/1120/960px 导出 full / rail-collapsed / focus / chat-jump 四个桌面档位（暴露为 data-responsive-step 供验收脚本使用），在单终端工作区 + 锚点聊天下它们不再改变页面结构。
- 小于 620px 进入移动下钻栈：会话列表是主页并始终完整渲染；点行进入详情（终端/网页/信息 分段，仅注册过预览的会话显示「网页」），「‹ 会话列表」返回。触屏行高 84px，保证 44px 以上点击目标。
- localStorage 只保存本地原语：每会话布局（v1）、共享 rail 宽度/折叠、未读 ledger（上限 500 条）、分组维度与组折叠（上限 200 组）；URL、cookie、grant、iframe 状态和身份信息不进入 localStorage。

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
| GET /api/sessions/:id/control | readonly/controlled、owned、可选 expiresAt；受信平台所有者返回 fixed:true（固定可写，非可释放租约）。 |
| POST /api/sessions/:id/control/takeover | 当前 auth session 获取固定期限租约；同一持有者复用但不续期；其他持有者得到 409 control_busy。 |
| POST /api/sessions/:id/control/release | 仅持有者释放；成功明确返回 owned:false。 |

常见失败为 400 invalid_session_id、401 authentication_required、404 unknown_session、409 session_not_active / terminal_external_only / terminal_unavailable、503 daemon_offline。

另有两个配套接口：GET /api/sessions/:id/view-link 为触屏或未登录浏览器换取只读 viewToken 终端链接（iOS WebView 的 WebSocket 升级不带 Cookie，同源地址必然握手失败）；POST /api/sessions/:id/locate 让 bot 在话题内 @ 用户定位会话，服务端限流，UI 侧 30 秒冷却。

GET /api/workbench/capabilities 向已认证身份投影最小操作能力集 `{ canLocate, canControl, canInteract }`：三布尔由服务端复算真实路由门禁得出（路由级 auth 决策 + terminalCapability/previewCapability 角色检查），前端只据此渲染定位、终端接管与 Preview 解锁入口——workbenchAuthed 只证明可进工作台，不再被当作操作权限。legacy owner 三项全 true；H5 与平台 owner 为 `{false, true, true}`（capability 表没有 /locate）；平台 teammate/guest 与匿名全 false。该路径不在 publicReadOnly 白名单，匿名恒 401，前端把任何非 200 或缺字段严格回落为全 false。canControl 只描述无显式 token 时的默认能力：显式 write token 走终端前置代理的独立授权，不经过也不受本投影影响。

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
- 长期 Dashboard 管理 token 不进持久化飞书卡片：`/dashboard` 卡片「打开工作台」按钮改带 30 分钟 TTL 的兑换票据（`/workbench-ticket/<ticket>`，构建卡片时现 mint、非一次性、到期即死）；dashboard 验票通过后按既有 `?t=` 流程同款种 legacy cookie 再 302 进工作台，无效/过期只回无凭据提示页。票据落盘（`~/.botmux/.workbench-tickets.json`，0600）只存 hash + 过期时间，重启不废刚发的卡；`?t=<长期 token>` 直链形态仅保留给 `botmux dashboard` 终端输出。
- H5 allowlist 使用 open_id 精确匹配；空列表不是“允许所有人”。
- control、preview interaction、preview proxy、H5 context 与 workbench capabilities 投影都不在 publicReadOnly allowlist。
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

Chat 不在 Workbench 页面内渲染，也不再脚本化调用 toggleChat/enterChat JSAPI。所有 surface 的聊天入口都是真实锚点（`target="_blank" rel="noopener"`）：href 优先取会话自带的 feishuChatLink，否则由 chatId 构造标准 `/client/chat/open?openChatId=…` AppLink。真实用户点击是飞书客户端唯一按标准聊天面板处理的派发；脚本化打开（window.open、合成 click、enterChat）会被客户端降级到窄容器——这正是当初「聊天开成窄窗」的问题根源。没有 chatId 的会话不渲染聊天入口（会话坞显示「无聊天」），不会拼接损坏链接。

chat/open 链接不携带 sidebar/width 参数：那是 web_app 容器契约，chat/open 带上会让客户端放弃就地放置而整页跳转。会话坞的「打开完整工作台」走 /client/web_app/open，mode=appCenter；侧边栏 AppLink 使用 mode=sidebar、min_width=350、max_width=520。普通浏览器不主动加载飞书 SDK。openWorkbenchChat（toggleChat → enterChat → AppLink 能力链）与 ensureFeishuJsApi 仍作为带测试的工具函数保留，但当前没有任何 surface 调用；浏览器验收断言 sdkCalls 为空。

## 6. 集成收口修复

集成审计中额外修复了以下真实契约、竞态和兼容问题：

- Terminal takeover/release 响应补齐 owned:true/false，UI 同时兼容旧响应并严格验证新响应。
- Terminal 写 WebSocket 使用租约 generation 标记封闭 takeover/握手竞态；UI 每 15 秒及租约精确截止点刷新，断连、释放或到期立即回到只读。
- Preview interaction 统一使用服务端 securityNotice，移除 UI 的 warning 字段错配。
- Preview descriptor 必须精确等于所选 session 的 /preview/<encoded-id>/，防止损坏或跨会话 metadata 被渲染。
- 所有 control/preview/H5 browser response 增加运行时 shape 校验。
- Workbench pane 以 sessionId 作为 React key，阻断切换会话后的异步状态串线。
- Workbench 选中态不再被旧 initialSessionId 拉回；搜索会重置虚拟列表。分屏/信息抽屉/页内聊天挂件等旧工作区控件已整体移除，工作区仅保留标题行与单终端面板。
- Preview refresh、activity、unlock、lock 使用单调 request generation；外层标签与 iframe guard 同步，轮询和 listener 去重，并在精确 idle deadline 回锁。
- H5 SDK 改为动态有界加载，并修复在 h5sdk.ready callback 前过早清除 timeout 的问题。
- H5 exchange 只接受 JSON；登录页、guard 与 Workbench 使用扁平语义样式，不依赖 `:has()`，CSP 仅允许官方飞书/Lark ancestor。
- Preview HTTP/WS 代理删除 hop-by-hop、认证、cookie 与转发身份头；SSE 丢弃没有内部 target 的注入或过期 preview descriptor。
- legacy Dashboard write-link 仅保留精确旧身份兼容，显式校验 token/viewToken，并从 worker query 与代理请求中剥离管理 cookie。
- Chat 与 Dock 的聊天入口统一为真实锚点（target=_blank rel=noopener）；链接优先取会话自带 feishuChatLink，否则按 chatId 构造标准 chat/open AppLink，不携带 sidebar/width 参数。
- Riff external-terminal 与 preview descriptor 均 fail closed；teardown 即使审计 sink 失败也会完成能力回收。
- WebPane 使用可清理 interval 和 document guard，兼容测试/SSR。
- 移动端不再继承桌面 collapsed rail，会话列表主页始终渲染完整列表。
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
| Feishu/Lark | AppLink 锚点（chat/open、web_app/open）与 H5 免登入口。 | 未修改任何真实开放平台或客户端配置。 |
| 审计 | 新增 dashboard-control NDJSON。 | 输入只记字节数；默认 sink I/O 策略需生产运维确认。 |

## 8. 验证结果

### 8.1 静态、构建与单元/集成测试

| 检查 | 结果 |
|---|---|
| pnpm build | 通过；domain audit、TypeScript、runtime build id、Dashboard bundle、dist audit 全绿。最终 build id：5f17015159ac（合并 origin/master 前的验收构建）。 |
| pnpm exec tsc --noEmit / git diff --check | 通过。 |
| Workbench 直接边界 | 16 files、262 tests 通过，覆盖 Workbench UI/模型/存储/路由、H5 auth、登录 UI、terminal control、preview 注册/代理与公开投影脱敏。 |
| 纯模型 runner | 通过：320 sessions、22 virtual items；覆盖 rail-collapsed、focus、chat-jump、mobile-stack。 |
| 组件 runner | 通过：21 component checks、14 rendered session options。 |
| pnpm test 全量 unit project | 963 files / 15,668 tests 通过，1 file / 16 tests 按仓库既有条件跳过；0 failed（合并 origin/master 前的验收轮记录）。 |

全量命令为 `pnpm test -- --maxWorkers=1 --no-file-parallelism`。由于验证本身运行在活跃 Botmux workflow 内，进程发现类测试使用清空 BOTMUX 上下文的环境、私有 PID `/proc` 和独立 `TMUX_TMPDIR`，避免把外层同 UID worker 误当成 fixture；串行执行也消除了 `/proc` 瞬态并发噪声。这是测试进程隔离，不会修改或重启 live daemon。

### 8.2 本地真实浏览器场景

浏览器脚本使用本机 Chromium headless shell、真实 React Workbench、真实 H5 controller、TerminalControlManager、PreviewInteractionManager、Preview guard/proxy，以及本地 loopback HTTP/WS fixture。没有连接真实飞书后端。

| 场景 | 结果 |
|---|---|
| h5_success — SDK 免登成功并回跳目标 Workbench 路由 | 通过 |
| h5_failure — provider 失败显示可重试错误 | 通过 |
| h5_timeout — SDK 有界超时进入可重试错误 | 通过 |
| h5_without_sdk — 普通浏览器无 SDK 安全降级 | 通过 |
| workbench_route_switch_and_terminal_control — 行内终端/接管、路由与会话切换、释放与关闭终端；聊天为真实锚点且 sdkCalls 为空 | 通过 |
| workbench_failure — 控制接口 503 daemon_offline 报错并停在只读 | 通过 |
| unauthorized — 未登录只读、不渲染接管按钮，preview 与 h5-context 均 401 | 通过 |
| mobile_and_sidebar_layout — 390×844 下钻栈（无页内 tab 栏、无分屏）与 375×800 会话坞（minWidth 350、零 pane） | 通过 |
| mobile_preview_interaction — 移动「网页」页蒙层、开启交互/立即锁定与 guard 同步 | 通过 |
| preview_registration_and_proxy_boundaries — 注册、无效/未注册端口、不可达与代理边界不泄漏内部 target | 通过 |
| preview_websocket — 同源 WebSocket 代理往返 | 通过 |
| terminal_disconnect_returns_readonly — 写 WebSocket 断开后回只读 | 通过 |
| preview_idle_timeout_relocks — 15 分钟 idle 到点回锁并落审计 | 通过 |

机器可读结果见 assets/agent-workbench-browser-results.json。

### 8.3 截图

![Agent Workbench 1440×900 dark screenshot](assets/agent-workbench-dark.png)

截图使用 320 条合成 session metadata、本地 mock 终端和 1440×900 viewport；sidecar metrics 记录 18 条虚拟列表行（行高 54px）、2 个分组头，终端徽标为「◆可输入」，responsive step 为 full。它不含真实 session、用户、token 或凭据。

## 9. 未验证项与五类人工飞书 Spike

以下项目必须在非生产飞书/Lark 应用、HTTPS 测试域名和专用测试账号上执行。本次没有真实 App ID/Secret、租户、客户端或 platform tunnel，因此全部明确标记为未验证。每个 Spike 都应记录客户端版本、操作系统、时间、screen recording、网络请求状态、JSAPI errno 和最终 UI 状态；证据中不得包含 code、cookie、App Secret 或 access token。

### Spike 1 — PC 行内聊天锚点

前置：发布测试 H5 应用，可信域名指向测试 Dashboard；准备一个有 chatId 的测试会话，窗口宽度至少 1280px。

1. 从飞书 PC appCenter 打开 Full Workbench 并选择该会话。
2. 在客户端调试工具确认行内「聊天」是 target=_blank rel=noopener 的真实锚点，href 指向 applink 域名的 /client/chat/open 且 openChatId 属于当前会话；确认页面没有加载飞书 JS SDK、没有任何 toggleChat/enterChat 调用（不要输出任何身份 token）。
3. 点击「聊天」，观察客户端是否以标准聊天面板打开对应会话（而不是降级的窄容器），Workbench 页面自身不跳转、自有区域仍只含会话列表与终端。
4. 切换 session 后再点聊天，验证 openChatId 跟随当前会话；连续多次打开无重复跳转。

通过条件：客户端以原生方式接管链接并按标准面板放置；页面没有自绘 H5 Chat；工作台不被顶掉；客户端不认 AppLink 时按普通链接打开 applink 页面，不阻塞 Workbench。

### Spike 2 — 普通浏览器与缺失 chatId 降级

1. 在系统浏览器（无飞书客户端）打开同一 Workbench，点「聊天」锚点，确认按普通链接打开 applink 页或唤起客户端，Workbench 页面不受影响，且全程零 JSAPI 调用。
2. 使用没有 chatId 的合成测试会话，确认行内不渲染聊天入口、会话坞显示「无聊天」，不拼接任意 URL。
3. 检查新窗口使用 noopener 语义，URL 中没有 H5 code、cookie 或 Dashboard token。

通过条件：无 SDK 环境安全降级为普通链接；缺 chatId 不出损坏链接；无凭据泄漏。

### Spike 3 — PC sidebar 宽度与 Dock

前置：在开放平台测试版本配置 sidebar AppLink，mode=sidebar、min_width=350、max_width=520，目标为 Dock route。

1. 从 PC 客户端侧边栏打开 #/agent-workbench-dock/<sessionId>。
2. 分别在 350px、400px、520px 观察布局；尝试缩到 350px 以下和扩到 520px 以上，记录客户端实际限制。
3. 验证 Dock 只渲染会话列表、所选会话摘要与「打开聊天 / 终端链接 / 网页链接 / 打开完整工作台」，不渲染任何 pane iframe。
4. 点击「打开完整工作台」，确认目标是 Full Workbench 且 sessionId 编码保持一致。
5. 分别验证 未选择会话（「请选择一个会话」）、无终端（「无终端」）、无网页预览（「无网页预览」）、无聊天（「无聊天」）的占位提示。

通过条件：350–520px 内无横向溢出；Dock 不偷偷渲染 Terminal/Web/Chat pane；appCenter handoff 正确；真实客户端宽度行为有截图和版本记录。

### Spike 4 — iOS/Android 免登与移动布局

前置：一台 iOS、一台 Android，至少一个支持 requestAccess 的当前版本；如可获得旧版本，再覆盖 requestAuthCode fallback。

1. 在飞书内打开 /auth/feishu?returnTo=/#/agent-workbench/<sessionId>，确认 requestAccess 成功后回到目标 session。
2. 在缺少 requestAccess 或返回 errno 103 的客户端确认 requestAuthCode fallback。
3. 用系统浏览器打开同一 H5 URL，确认无 SDK 时 8 秒内进入可重试错误，而不是无限等待。
4. 在约 390×844 与 375×800 竖屏检查下钻栈：会话列表为主页且完整渲染；点行进入详情后「终端 / 网页 / 信息」分段可切换（「网页」仅在会话注册预览后出现），「‹ 会话列表」可返回；触屏终端为只读 viewToken 通道，不显示接管按钮。
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
