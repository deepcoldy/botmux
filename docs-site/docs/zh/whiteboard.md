# 本地白板（Whiteboard）

同一个飞书群里的多个机器人 / 会话共享一块**本地 markdown 白板**，用来沉淀跨会话、跨 bot 的「当前项目状态」（目标 / 组织方式 / 核心方案 / 关键进展 / 下一步）。

白板是一份**最新状态快照**：`update` 整体覆盖、不堆历史，让后来的 agent 一读就拿到最新共识，而不必翻聊天记录。适合多 agent 协作、长任务断点、跨话题交接。

> 默认关闭。它是可选增强 —— 不开启时不会创建白板、不绑定会话、不注入 prompt，agent 的读写命令也会被拒绝。

## 开启 / 关闭

```bash
botmux whiteboard enable      # 打开能力（不会立即建板）
botmux whiteboard disable     # 关闭（已有白板保留在磁盘，Dashboard 仍可只读查看）
botmux whiteboard status      # 查看开关状态与白板数量
```

也可以在 **Dashboard → 设置** 里切换开关。

**enable 只打开能力，不会自动建板**；白板在某个群第一次需要时才**懒创建**。

## 共享粒度：按群

同一个群里的不同机器人、不同工作目录，默认共享**同一块**白板（绑定键 `chat:<chatId>:default`）。这样一个群就是一块共享上下文板，谁更新所有人下一轮都看得到。

## agent 怎么用

启用后，daemon 会在每轮注入一个 `<whiteboard>` 提示块，告诉 agent 当前白板 id 和读写方式（**只暴露白板 id 与命令，不暴露本地文件路径**，并提示不要写入密钥 / 隐私）。推荐流程：

1. 先读，拿到内容和版本号：

```bash
botmux whiteboard read --id <id> --json
# { "id": "...", "updatedAt": "2026-...", "content": "..." }
```

2. 融合新信息，**整体重写**为一份完整的当前状态。

3. 带上刚才读到的版本号回写（乐观并发 / CAS）：

```bash
botmux whiteboard update --id <id> --expected-updated-at <updatedAt> "新的完整状态"
```

如果期间有别的 agent 改过白板，会返回 `whiteboard_cas_mismatch`（退出码 2）—— 重新 read 拿最新内容再融合即可。

也可以让 agent 直接用 `botmux-whiteboard` Skill：说「更新一下白板」「看看项目上下文」就会触发。

## 并发与安全

- **写锁串行化**：每块白板有独立文件锁，两个 agent 同时 `update` 不会写出半截文件，且经死锁回收（持有进程被 kill 后锁自动失效）。
- **CAS 冲突检测**：`--expected-updated-at` 让一次覆盖在「白板自上次 read 后被改过」时被拒绝，避免静默丢更新；不传则退化为直接覆盖（向后兼容）。
- **空内容拒写**：拒绝写入空白内容，防止误清空共享板。
- **不暴露路径 / 不存密钥**：prompt 只给白板 id 和命令；并提示 agent 不要往白板写密钥或隐私数据。

## Dashboard 白板页

Dashboard 提供白板页，按「群 → 白板」分组：

- 左侧列表按群分组，右侧详情看选中白板的元信息与当前内容预览。
- **受保护删除**：删除需 dashboard token（删板文件 + 清索引绑定 + 清理会话引用）。
- 白板读写 API 默认**不对匿名只读访客开放**（fail-closed），不会泄露白板内容或本地路径。

## 命令一览

| 命令 | 说明 |
| --- | --- |
| `whiteboard status` | 查看开关与白板数量 |
| `whiteboard enable` / `disable` | 开启 / 关闭能力 |
| `whiteboard list` | 列出本机白板（只读，关闭时也可用） |
| `whiteboard current [--create]` | 查看当前群默认白板；`--create` 按需创建 |
| `whiteboard read --id <id> [--json]` | 读 board.md；`--json` 出 `{ id, updatedAt, content }` |
| `whiteboard update --id <id> [--expected-updated-at <ts>] <内容>` | 整体覆盖当前状态（内容可走参数 / stdin / `--content-file`） |
| `whiteboard write --yes --id <id> <内容>` | 强制覆盖逃生口（需 `--yes`） |
| `whiteboard create [--id ID] [--title T]` | 显式新建一块白板 |
