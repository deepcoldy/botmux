# Riff 机器人接入指南

> Riff 后端：消息发给飞书机器人 → riff 云端沙箱运行 codex agent → 结果自动回到飞书。agent 跑在远端沙箱里，本机无需安装任何 CLI；botmux 自动把仓库、环境变量、回投凭证带进沙箱。要求 botmux ≥ 2.109.0。

## 快速接入（约 5 分钟）

1. 前提：botmux daemon 正常运行；有一个飞书机器人（dashboard「添加机器人」可创建）；daemon 机器内网可访问 riff 服务。
2. 打开 dashboard → 选中机器人 → 「Agent 配置」板块 → CLI 下拉选择 **Riff**。
3. 下方出现「Riff 后端配置」面板：

   | 字段 | 怎么填 |
   |------|--------|
   | Base URL | **必填**。填你所在环境的 riff 服务地址（线上 / BOE 测试环境各一个域名，向 riff 团队或内部文档获取；形如 `https://riff.example.internal`） |
   | 运行环境 | 新任务使用的沙箱资源池：`BOE`（配置值 `boe`）或 `CN`（配置值 `cn`）；不配置时 Riff 默认 `boe`。该选择与 Base URL 所指向的 Riff 服务环境相互独立 |
   | 模型 | **留空**（默认 `gpt-5.5`）；推荐可选：`gpt-5.5` / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.4` / `gpt-5.4-pro`（输入框有下拉建议） |
   | 思考等级 | codex 推理强度（low / medium / high / xhigh），留空跟随默认 medium |
   | JWT 环境变量 | 一般**留空**，见「认证（JWT）」 |
   | System Prompt / 额外初始化命令 | 可选。自定义 System Prompt 是**追加**在内置路由规则之后，不会替换它 |

4. 点「保存 Riff 配置」——CLI 与会话后端自动配对切换到 riff（该机器人现存旧会话会被关闭）。
5. 群里 @机器人 发消息即可。首轮任务约 2-5 分钟（沙箱冷启动）；继续对话秒级接续同一沙箱与上下文。

保存后会在 `bots.json` 写入如下配置；创建首轮任务时，botmux 把 `sandboxCluster` 作为 `POST /api/task-execute` 的顶层字段发送。后续追问沿用父任务的沙箱与运行环境。

```json
{
  "riff": {
    "baseUrl": "https://riff.example.internal",
    "sandboxCluster": "cn"
  }
}
```

## 认证（JWT）

riff API 使用 ByteCloud JWT 鉴权。botmux 每次调用 riff 时按以下优先级取 token：

1. `bots.json` 中 `riff.jwt` 直填——不推荐（明文存储、时效短需手动更换）
2. 「JWT 环境变量」字段指定的环境变量（默认变量名 `RIFF_JWT`）——需在 daemon 启动环境中 export 并自行刷新
3. **全部留空（推荐）→ 自动读取本机 ByteCloud keychain**

### 留空（推荐）该怎么做

在**运行 botmux daemon 的机器**上，安装并登录任意一个 ByteCloud 系 CLI（`kaboo-cli` / `aiden-cli` / `cjadk` / `bytedcli`），登录一次即可：

```bash
# 任选其一，首次运行会拉起 SSO 浏览器授权
kaboo-cli            # 或 cjadk / aiden-cli
bytedcli auth login  # bytedcli 用 auth login 子命令
```

登录态（含 `bytecloud_jwt`）写入本机 keychain。botmux 会跨平台、跨工具自动探测这些位置（命中即用，无需配置任何字段、无需重启 daemon）：

- **Linux**：`~/.config/<cli>/…`（kaboo-cli / aiden-cli / cjadk）、`~/.cjadk/…`、`~/.aipaas/…`，以及 bytedcli 的 `~/.local/share/bytedcli/data/…`
- **macOS**：`~/Library/Application Support/<cli>/…`（kaboo-cli / aiden-cli / cjadk）；⚠️ 注意 **bytedcli 在 macOS 上仍走 `~/.local/share/bytedcli/data/…`**（不落 Application Support）
- **Windows**：`%AppData%\<cli>\…`（kaboo-cli / aiden-cli / cjadk）；bytedcli 无平台分支、Windows 仍走 `~/.local/share/bytedcli/data/…`
- config 系（kaboo-cli / aiden-cli / cjadk）按**当前平台**解析 config 根（对齐 Go `os.UserConfigDir`）:Linux 用 `$XDG_CONFIG_HOME`（未设则 `~/.config`）、macOS 用 `~/Library/Application Support`、Windows 用 `%AppData%`（未设则该组不探测,不虚构路径）——只探测当前平台的那一个,不会跨平台混用;**bytedcli 不读 `$XDG_DATA_HOME`**（三平台都固定 `~/.local/share`,已核 bytedcli 源码 `bytedcliBaseDir` 无平台分支）
- **AIME 工作区**：bytedcli 在设置了 `AIME_WORKSPACE_PATH` + `AIME_CURRENT_USER` 时，会把存储根切到 `<AIME_WORKSPACE_PATH>/<用户名>/.local/share/bytedcli/data/…`，botmux 也会自动探测该位置。⚠️ 为避免跨 AIME 用户身份误读他人 token：**两个变量都齐全时（完整 AIME 运行时），只认 AIME 身份域下的 keychain，宿主 HOME 派生的所有位置（`~/.config/*`、`~/.cjadk`、`~/.aipaas`、`~/.local/share`、Application Support 等）一律不探测**——此时 `os.homedir()` 仍是宿主 home、属于另一身份。若 AIME keychain 无有效 token，宁可返回空（请在 AIME 内重新登录），也不会退回宿主取到别人的 token。只设其一则按普通环境处理。

多个位置同时命中时，botmux 会解析各 token 的过期时间（JWT `exp`），跳过已过期（或将在 ~30s 内到期）者、优先选用有效期最新的一个，避免旧工具残留的过期 token 遮住另一工具的有效 token，也避免选中一个在建任务请求途中就到期的 token。

keychain 文件的完整叶路径形如 `<root>/bytecloud-auth/keychain/auth/cn/default`，其 JSON 含 `bytecloud_jwt` 字段。（同级的 `bytecloud-auth/auth/cn/credentials.json` 只有元数据、**不含** `bytecloud_jwt`，botmux 不会误读。）

### 手动获取 JWT（只有走方式 ①/② 才需要）

装了 `bytedcli` 时，最简单的方式是让它直接吐 token：

```bash
bytedcli auth get-bytecloud-jwt-token --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["jwt"])'
```

或从 kaboo/cjadk 的 keychain 直接取（Linux 示例）：

```bash
python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.config/kaboo-cli/bytecloud-auth/keychain/auth/cn/default')))['bytecloud_jwt'])"
```

⚠️ ByteCloud JWT 时效很短（约 1~2 小时）。直填 / 环境变量方式必须自己保证定期刷新，否则任务会开始报 401——这是推荐留空走 keychain 的原因。

### Token 过期了怎么办

- 表现：卡片报「创建 riff 任务失败 … 401」或日志提示 `JWT not found`。
- 自救：在 daemon 机器重新运行一次 `kaboo-cli` / `cjadk` 刷新登录态即可，botmux 无需重启。

## 仓库怎么进入沙箱

- **自动复用**：会话工作目录是内部 Git 仓库 checkout 时，任务自动带上「该仓库 + 当前分支」。分支须已推送；本地未提交/未推送内容沙箱看不到（卡片状态行会提示）。
- **仓库选择卡**：未配置默认工作目录时新会话弹卡选仓；「🔀 多仓库」可多选——批量建 worktree 全部带入，首仓为主仓（沙箱工作目录）。
- **新建 worktree**：riff 机器人先自动把新分支 push 到远端再启动任务。
- **限制**：只有 riff 服务端内部 registry 里的仓库能被 clone；GitHub 等外部仓无法进入沙箱。

## 卡片按钮说明

### 宿主机工具通道

普通飞书 Riff 会话的 `botmux` 操作由所属 worker 的宿主机执行。沙箱只传递命令、正文和附件；发卡回执、反馈快照、完成事件、出站 Hook、定时任务、授权申请、问答等待和举手状态均保存在宿主机。每轮（包括追问）自动注入 `BOTMUX_RIFF_HOST_TOOLS=1 botmux riff-host-bind …` 引导，必须先执行再调用工具；绑定包含私密的当前轮次凭据，不要转发或粘贴到群里。后续工具调用同样使用 `BOTMUX_RIFF_HOST_TOOLS=1 botmux …`，兼容创建时尚未启用该环境变量的旧任务。仅有旧绑定文件不会接管普通 CLI 命令。

支持 `send`（含图片/文件/自定义卡片和举手）、`ask`、`auth`、`schedule`、`history`、`quoted`、`bots list`、`project`、`board`（含附件）、`card patch`、`card stream open/write/snapshot/reanchor/finish`、`whiteboard status`、`tabs`、`top-notice`，以及已有 workflow 的查询/运行/启动/重试/取消/授权。`--content-file -` 支持从沙箱 stdin 上传内容；`send --voice/--card/--text` 保持原 CLI 的布尔参数语义，`--image/--file` 单数别名也可使用。其它白板操作及 `send --into/--chat-id` 等改投递目标的参数未开放。各命令原有的权限、功能开关及群/话题约束仍然生效；沙箱不能通过参数选择其它会话、应用、群聊或宿主机文件。`card patch` 必须核验消息属于当前群，查不到归属时拒绝修改；定时任务使用 worker 冻结的宿主工作目录，缺失时拒绝创建。`auth` 管理宿主机的授权申请与等待；沙箱里其它 CLI 如何使用用户授权仍由对应工具的凭证桥接负责，不会把用户 token 自动下发给沙箱。

入口优先复用现有平台或 `BOTMUX_PUBLIC_URL` 的 `/s/<sessionId>/api/riff-host-tools` 转发；未配置公网入口时使用 worker 的 advertised 地址。若沙箱无法访问该地址，可在 `riff.hostToolsUrl` 配置转发到此 worker 的完整 HTTP(S) 地址（路径必须以 `/api/riff-host-tools` 结尾，支持 `{sessionId}` 占位符）。配置不能包含用户名/密码、查询参数、片段、引号、反斜杠、空白或控制字符；非法配置在 worker 启动时明确报错，不会先接受消息再静默失败。该入口使用独立的每轮凭据，通过 `x-riff-host-token` 请求头传递，终端的只读链接或操作 token 均不能调用它。客户端直接连接配置的入口，不跟随重定向，也不把凭据交给沙箱 HTTP 代理，因此转发地址须能从沙箱直达（可使用 IPv6）。

POST 受理后以操作 ID 查询结果；相同 ID 和内容的重复请求不会再次执行。响应丢失只查询原操作，不能自动改为直连飞书重发；进程崩溃后没有确定回执的操作返回 unknown，由调用者核验。历史轮次回执在绑定和新操作时按 7 天及 1000 条上限清理；当前轮次与正在执行的回执不被淘汰，达到容量上限时拒绝新操作。会话关闭后，daemon 的启动/周期清理会回收无活跃引用的回执目录；保护集合或进程存活情况不明确时跳过回收。

回执维护失败不会中断消息投递；目录无法枚举时按满额处理，拒绝新操作，已有回执继续用于幂等查询。绑定签发的其它异常会留下不含凭据的告警，任务仍会创建或追问，但本轮不注入宿主工具绑定，并在任务输出中报告工具不可用。不会恢复原始应用密钥、复用旧绑定或自动直连飞书重发。

沙箱必须安装支持 `riff_host_tools_v1` 的同版本 botmux，可用 `botmux capabilities --json` 核对。Linux x64 编译版宿主机会提供受当前轮次凭据保护的同构建 CLI 下载，自动引导安装前校验 SHA-256；源码及其它平台部署仍需通过 npm 等方式提供兼容的 Linux CLI。升级后已有 Riff 会话在下一次追问时重新绑定。

通道不开放宿主机管理员命令、任意 shell、跨会话投递、`preview` 或原始终端控制。Completion Proposal 的后端可恢复性检查维持原有规则，仍可能降级为文字；不会因工具桥接而自动开放。已有但从未在宿主机登记的历史反馈卡片需要另行核验并补登记，本改动不会按当前权限策略自动认领旧卡。

| 按钮 | 作用 |
|------|------|
| 📖 显示输出 / 打开 Web 终端 | 任务日志页（状态行、进度、任务完成报告） |
| 🔑 获取操作链接 | AIO Sandbox 网页终端（可操作沙箱），私密发送给点击者 |
| ❌ 关闭会话 | 结束会话并取消远端正在运行的任务 |

## 常见问题

| 现象 | 原因与处理 |
|------|-----------|
| 发消息后没回复 | ① JWT 过期（见上）② 模型名不在支持清单（非法值会 400 并回显完整清单）③ 打开「Web 终端」日志页看 `[riff] 错误` 行 |
| 报「仓库 xxx 不存在」 | Base URL 环境与仓库不匹配，或填了外部仓库；确认是内部 Git 仓库上的 `group/repo` |
| 保存配置报 invalid_base_url | Base URL 必填且必须以 http(s) 开头 |
| 继续对话每轮都要几分钟 | 正常应为秒级（follow-up 复用暖沙箱）；若每轮冷启动，检查是否每次 /close 后重开、或配置中途被改 |
| 状态行里看不到沙箱链接 | 沙箱链接是可写能力，只经「获取操作链接」私密下发，群内状态行/日志不展示 |
