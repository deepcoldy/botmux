# 所有 coding agent 共用 OpenViking 记忆

## 问题

记忆的所有者是用户和项目。原示例把读取入口放进 Codex 启动器，其他 Agent 无法复用。用户要求所有 coding agent 可用、默认关闭、主动搜索；现有 Codex 自动采集试点需要保留。

## 使用面

任何能执行 shell 的 Agent 使用同一公共命令 `memory.mjs search/read/remember/status`。支持 Skill 的本地宿主显式安装同一份 Skill；Botmux 使用标准 `openviking` 插件分发 Skill，并提供 `botmux openviking` 命令。配置和安装不会给其他 Bot 自动启用。

## 结构

```text
各 coding agent / Botmux Skill -> memory.mjs -> client.mjs -> OpenViking HTTP
可选 Codex 自动采集启动器      -> client.mjs 解析身份 -> 上游 capture Hook
```

`loadConnection(configPath)` 固定 account/user/endpoint；`resolveIdentity(connection,cwd)` 根据项目配置或 Git 推导 peer；`MemoryClient` 隐藏服务路由、检索范围和项目写入协议。公共层无需 Codex 可执行文件、登录配置或插件。

`search` 固定 context/coding/actor；无 peer 时只查用户记忆。`find` 明确用户和当前项目目录；`read` 验证目录范围。项目 `remember` 禁用 self 提取，逐条发送 peer_id；用户 `remember` 禁用 peer 提取。commit 返回 task_id，实际完成通过 task 状态和索引查询验证。失败的写请求不会自动重试。

用户 ID 显式配置，所有宿主复用现有用户可保留旧记忆。peer 不含 Agent/Bot/session ID；Git remote 去除凭据并统一 SSH/HTTPS，子目录和 worktree 收敛到同一项目。旧非 Git 试点的 cwd 模板继续兼容。

## 综合选择

比较两个结构：A 在 Botmux 公共插件和完成事件层统一读写及自动采集；B 使用独立公共 CLI/Skill，宿主仅适配自动采集。选择 B，加入 A 的现有插件分发方式。交叉评审评分 A 24/30、B 27/30，依据跨宿主独立性、关闭行为、主动查询、身份一致、接口规模和可验证性。

共享客户端统一配置、身份和 HTTP 行为，CLI 与插件只有一份实现。未新增 Botmux core 捕获/outbox、MCP 代理或各宿主启动参数矩阵。自动采集仍由已验证的 Codex 适配负责，公共入口允许所有 Agent 主动写记忆。

## 开关与代价

- 新安装的共享入口和自动采集均未启用。`setup-shared.mjs` 管理共享 Skill/插件开关；`pilot.py` 管理可选 Codex 采集启动器。关闭前者不会撤回独立启用的后者，完整关闭需分别撤回两个绑定并启动新会话。
- CLI 使用宿主的 shell 能力，适用于同一操作系统用户的个人开发环境；多用户 Bot 和无法读取私有配置的沙箱需要另行建立可信用户映射与主机桥接。
- Agent 的搜索选择受提示规则指导，可能漏查；服务中的记忆仅为参考。
- 旧 Botmux 2.71.3 没有当前源码的公共插件 API，可使用独立 Skill/CLI 和原试点启动器。插件分发需部署带该 API 的版本。

## 验收

共用客户端行为测试覆盖项目身份、写入归属、用户记忆、读范围和显式绑定；Botmux 集成测试覆盖各 CLI 的插件目录投递与默认关闭。真实服务测试等待提取完成、查到项目 URI，再让 Codex 和 OpenCode 主动搜索并采用事先未知的标记。原 Codex 自动采集另跑原生 TUI 验证。飞书消息进入与回复交付独立记录。
