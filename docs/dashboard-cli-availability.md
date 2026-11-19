# Dashboard 的 CLI 可用性检测

Dashboard 或后台服务的 PATH 可能不包含 CLI 安装目录，而用户的 `.zprofile`、`.zshrc` 或 `.bashrc` 可以找到该 CLI。选项列表只检查服务进程 PATH 时，查不到并不代表未安装。

选项列表保持快速、无 Shell 的检查。`availabilityStatus` 区分 `available`、`unknown` 与 `unavailable`：快速检查失败时返回 `unknown`，Forge 尚未运行 doctor 时也返回 `unknown`。原有 `available` 字段保留以兼容旧客户端。

Bot 配置、添加 Bot 和 Agent 编辑表单异步请求 `/api/cli-options/availability?key=<选择键>`。Bot 配置页附带 `bot=<appId>`，服务端仅在已保存的启动身份与请求选择键一致时应用该 Bot 的运行时、可执行文件路径和环境。网关检测实际 wrapper 命令；Forge 检测 TraeX、Forge 和 doctor。

完整检测按登录/交互 Shell 逐项执行字面 argv 查询，并保留 macOS Codex 应用回退。Wrapper 同样只查询首个可执行 token，不执行网关本身或 hooks；Forge 仍运行 doctor。当前解析支持 $SHELL、Zsh、Bash，fish 的语法与 rc 安装不在支持范围内，检测可能返回 unknown。Shell 检测不会阻塞 Dashboard 事件循环，每个子进程受超时和输出上限约束。超时或异常 Shell 返回 `unknown`，不会显示“不可用”结论；HTTP 失败也不改写为 CLI 缺失。切换选择、更新影响启动的 Bot 配置或卸载表单会取消旧请求，旧结果不能覆盖当前选择。名册刷新但启动内容没变时保留上次结论。Bot env 保存后重拉服务端指纹；可见表单每 30 秒重新确认，以覆盖全局 env 层修改。服务端缓存 15 秒并复用进行中的探测，完整探测最多 4 个并发。任一 Shell 异常会把未找到命令的结论保守地降级为 unknown。该接口沿用管理权限门禁。

以下截图来自隔离的 Dashboard 和真实 Chrome 操作。服务 PATH 不含安装目录，TraeX 仅通过 Zsh rc 中的 PATH 可达；选择真正缺失的 Reasonix 后才出现警告。

![Shell 可找到 TraeX，页面不再误报缺失](assets/cli-availability/found.png)

![完整检测确认 Reasonix 不可用](assets/cli-availability/missing.png)

这是显示与探测层的修复，不改变 Worker 启动方式、模型切换或会话恢复逻辑。


保存 Agent 配置时，完整 Shell 检测、runtime `--version` 与能力目录查询先在 bots.json 锁外执行；锁内重新解析当前磁盘条目的启动形态、有效路径、环境指纹与能力输入。内容一致才使用探测结果，否则返回 409 要求重试。缺失 runtime 仍在写盘前拒绝，普通 CLI / dsh-tui 只在明确 unavailable 时给保存警告，unknown 不告警。

Bot env 指纹来自 `botOneShotProbeEnv` 同一次解析，payload 的 envRevision、端点探测环境与缓存键同源，不回传环境变量值。端点不返回 resolvedPath；command 是配置的命令，因此可能包含管理员设置的绝对私有路径，该端点始终沿用管理门禁。
