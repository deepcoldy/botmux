# Codex 配置 profile 选择

Dashboard 在目标 Bot 的 daemon 上扫描候选，提供可搜索下拉、刷新和“不指定”。不创建、编辑配置文件，不接收任意参数或路径。普通保存省略 `codexProfile`，保留锁内当前值；只有显式选择/清空才写入名称/删除字段。切换到不兼容的启动方式时必须显式清空，不能自动丢弃。

## 配置来源与版本

读取目标 daemon 的有效环境策略；启用固定默认实例时读取该实例目录，其他支持场景读取有效 `CODEX_HOME`，未设置则使用目标账号的 `~/.codex`。Dashboard 本身不扫描目录。刷新或 Bot 配置行变化会发起新请求，旧上下文响应被丢弃；保存重新从锁内条目解析来源。

只对目标原生二进制执行有超时/输出上限的 `--version` 和 `--help`。未知/定制版本标识无法确认时拒绝；帮助中须明确存在 `--profile`。不运行 wrapper、登录或 hooks 来探测。

- 0.134.0 及之后：非递归读取 `<名称>.config.toml`。
- 已确认参数支持的更早正式版本：用 TOML 解析器读取基础 `config.toml` 的 `[profiles.<名称>]`，不合并新格式来源。
- 0.134.0 是配置格式分界，不是参数首次引入版本。

依据：[官方 Profiles 说明](https://learn.chatgpt.com/docs/config-file/config-advanced)、[CLI 参数说明](https://learn.chatgpt.com/docs/cli/reference)。实现时于 2026-10-19 复核。

名称限制为 1–128 个 ASCII 字母、数字、连字符、下划线；文件上限 256 KiB，最多检查 1024 个目录项、返回 128 个候选。拒绝非普通文件、符号链接和多硬链接；读取前后检查文件及目录身份。解析异常仅返回错误码，不返回配置正文、凭据或解析片段。整个文件仍可在验证后被用户改变，因此不能保证之后启动一定成功；每次启动再次校验，不退回默认 profile。

## 生效与优先级

新会话创建时冻结 profile 名称（包括“不指定”）和配置目录，保存于会话存储；恢复、fork、冷启动、daemon 重启沿用该选择，旧版本已创建会话不补入当前 Bot 的 profile。冻结选择，不冻结文件内容。profile 的更改不会主动关闭已有会话。

门控分两层：**配置层**断言只依据 bots.json 条目自身字段（cliId/wrapper/隔离/sandbox 配置值/backend/serviceTier 等），不读任何进程环境——配置解析（`parseBotConfigsFromText`）与每个 bots.json 持久化写入面共用它，同一份配置在任何启动 env 下结论一致；**运行时**门控在扫描、保存探测与 worker 启动时再叠加机器事实（平台、`BOTMUX_SANDBOX` 的 1/oncall/scratch 三个激活值，非法值 fail-closed）。所有 bots.json 写入面（Dashboard、/config 与配置卡片、setup/onboarding、各 store）在落盘前都会对「被改动的条目」跑同一配置层解析，未改动的历史遗留条目不阻断修别的 Bot。worker 一次启动只做一轮 `--version`/`--help` 能力探测，后续复检复用探测结果但仍重读 profile 文件。

安全策略保持现状。显式模型、思考强度等 CLI 覆盖值优先于 profile；未指定值交由 Codex 配置层解析。“不指定”只是不传 `--profile`，基础配置仍然有效。TOML 语法正确不等于所有配置键、hooks 或模型都可用。

## 首版支持矩阵

| 组合 | 行为与验证 |
| --- | --- |
| Linux 原生 Codex + PTY | 支持；真实 worker + CLI 夹具验证 argv、目录和显式模型 |
| Linux 原生 Codex + tmux，RPC 关闭 | 支持；独立 tmux server 中运行真实 worker 验证；测试显式使用 bash |
| resume / fork / 冷启动 | 支持；适配器参数、真实 API 会话存储重载和 fork 继承验证；未调用真实模型恢复对话 |
| 固定默认实例（实例池 enabled=false） | 支持；扫描该实例，不合并其他实例；两 Bot 目录隔离和实例既有回归验证 |
| 兼容 runtime | 只接受可确认的正式 `codex-cli X.Y.Z` 版本及参数支持；legacy 路径、未知/定制版本明确拒绝 |
| RPC app-server / viewer | 拒绝，不自动关闭 RPC 或降级后端。实测 Codex 0.163.0 拒绝 `--profile … app-server`；不能以 TUI 参数代表 RPC 支持 |
| wrapper / 网关 / startupCommands / 自定义 PATH | 拒绝，不执行启动前缀来猜测配置来源；#2027 的普通 wrapper 保存契约不变 |
| sandbox / readIsolation / codexAuthSync=isolated | 拒绝，不扫描全局目录冒充隔离目录，不复制 profile，也不关闭隔离 |
| 随机实例池 | 拒绝，不能保证每次随机实例使用同一候选来源 |
| adopt / 外部 App Server / v3 workflow / per-session CLI selection | 不应用 Bot profile；若带有显式 profile 的启动/快照请求进入这些组合，明确拒绝 |
| 非默认 service tier | 拒绝，不能用裸 Codex 模型目录代替 profile 所选 provider 的能力验证 |
| herdr / zellij / 其他后端、Windows | 首版拒绝 |
| macOS | 文件/参数逻辑共用；未做 macOS 实机运行验证，不声称已验证 |

## 实际验证记录

- Bun 1.4.3、Node 22.23.2，Linux；`bun install --frozen-lockfile` 在独立依赖 checkout 通过，未在 worktree 安装。
- 真实浏览器选择、保存、回读、候选删除/刷新、显式清空，截图见 [验证说明](screenshots/codex-profile/README.md)。
- 本机 Codex 0.163.0，临时 `CODEX_HOME` 的 `debug prompt-input`：基础 `developer_instructions="BASE_FIXTURE"`，profile `developer_instructions="PROFILE_FIXTURE"`，输出包含 profile 标记；加显式 `-c developer_instructions="EXPLICIT_FIXTURE"` 后只包含显式标记。未调用模型或配置真实 hooks。
- 同版本尝试 `codex --profile selected app-server` 得到明确拒绝（参数仅适用于列出的 runtime commands 和 `codex mcp`）；据此拒绝 RPC 组合。
- 初始基线 `5f8175ab5`，随后同步 `ba2ad453f` 的配置一致性更新；`bun run build` 通过。同步后 18 个定向测试文件合计 1029 项通过、2 项条件跳过（含真实浏览器和配置协调器回归）。覆盖保存过程中删除文件的原子拒绝。
- `bun run daemon:restart` / `daemon:status` / `daemon:stop` 在独立网络/PID 空间、临时配置目录运行真实构建产物；带 profile 的测试 Bot、Dashboard online，IPC 就绪，之后正常停止。
- 不修改生产配置、不合并、不发版。未跑完整全量测试，不将单测夹具等同真实模型全模式验证。
