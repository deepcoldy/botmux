# 本地白板（Whiteboard）

白板是一份存在本机的 markdown 笔记，同一个飞书群里的机器人和会话共用一块。它记录的是项目「现在是什么状态」：目标、分工、方案、进展、下一步。

新会话或换了一个 bot 接手时，agent 先读一下白板就能跟上，不用翻聊天记录。适合多 agent 协作、长任务断点续做、跨话题交接。

白板是**快照，不是日志**：每次更新都整篇重写成最新状态，旧内容不保留。

> 默认关闭。不开启时不会建白板、不会绑定会话、不会往 prompt 里加任何东西，agent 的读写命令也会被拒绝。

## 快速开始

1. 打开白板能力（任选一种）：
   - 命令行：`botmux whiteboard enable`
   - Dashboard：**设置 → 本地白板 → 启用项目白板**
2. 在群里正常开一个话题和 bot 聊。会话启动（或开关打开后的下一轮对话）时会自动为这个群建好白板并绑定上。
3. 想让 agent 记点东西，直接说「更新一下白板」「把当前进展写到白板」；想让它恢复上下文，说「看看白板」。
4. 在 Dashboard 的 **白板** 页查看内容。

开关不用重启 daemon，新会话和后续对话轮次会按新状态处理。打开开关本身不会建板，要等某个会话第一次用到时才创建。

## 白板按什么共享

| 场景 | 用哪块白板 |
| --- | --- |
| 在飞书群里的会话 | 每个群一块默认白板。群里不同机器人、不同工作目录都共用它 |
| 不在群里（比如本地终端直接跑命令） | 按工作目录分，每个目录一块 |
| 接管的本地会话（`/adopt`） | 不自动绑定白板 |

一个会话绑定好白板后会一直用它。如果白板被删了，这个会话下一轮对话时会自动再建一块新的。

新白板自带一个模板，引导 agent 按这几节写：

```markdown
# 当前状态
## 项目目标
## 组织方式
## 核心方案
## 关键进展
## 下一步
```

## agent 怎么读写

开启后，每轮对话 botmux 都会给绑定了白板的会话附上一段 `<whiteboard>` 提示，告诉 agent 白板 id 和读写命令。提示里**只有 id 和命令，不带白板正文，也不带本地文件路径**，并提醒 agent 不要写密钥和隐私信息。

同时会给支持 Skill 的 CLI 装上 `botmux-whiteboard` Skill，用户说「白板」「项目上下文」「交接」之类的话就会触发。

推荐的写法是「先读、融合、再整篇写回」：

1. 读出内容和版本号：

   ```bash
   botmux whiteboard read --id <id> --json
   # { "id": "wb_...", "updatedAt": "2026-...", "content": "..." }
   ```

2. 把新信息融合进去，整篇重写成一份完整的当前状态（不是只追加本轮内容）。

3. 带上刚才读到的版本号写回：

   ```bash
   botmux whiteboard update --id <id> --expected-updated-at <updatedAt> "新的完整内容"
   ```

   内容也可以用管道（`cat note.md | botmux whiteboard update --id <id>`）或 `--content-file <路径>` 传入，长内容更方便。

如果这期间别的 agent 改过白板，第 3 步会失败并提示 `whiteboard_cas_mismatch`（退出码 2）。重新执行第 1 步拿最新内容，再融合一次就好。

在会话里跑命令时，`--id` 可以省略，会自动用当前会话绑定的白板；`update` 找不到白板时还会按上面的共享规则自动建一块。

## 防止写坏

| 保护 | 作用 |
| --- | --- |
| 版本号检查 | 带 `--expected-updated-at` 时，白板在你读过之后被改过就拒绝写入，避免悄悄覆盖别人的更新。不带则直接覆盖 |
| 写锁 | 两个 agent 同时写会排队，不会写出半截文件。持锁进程被杀掉，锁会自动释放 |
| 拒绝空内容 | 内容为空或全是空白时拒绝写入，防止误清空共享白板 |
| `write` 需确认 | `write` 是强制覆盖，必须加 `--yes`。日常更新请用 `update` |

白板没有历史版本，被覆盖的内容找不回来。重要内容请另外留档。

## Dashboard 白板页

Dashboard 左侧导航的 **白板** 页按群列出所有白板：

- 左边按群分组，选中一块后右边显示所属群、范围、最近更新时间、来源目录，以及 `board.md` 的只读预览。
- **删除白板**：会删掉白板文件，并解除群和会话上的绑定。删除需要已登录 Dashboard，且不可恢复。
- 匿名只读访客看不到白板列表和内容。
- 白板能力关闭时，页面顶部会提示「白板能力当前关闭」。已有白板仍可只读查看和删除。

`<whiteboard>` 提示的措辞可以在 Dashboard 的 **自定义** 页改写（搜索「白板」）。

## 命令一览

| 命令 | 说明 |
| --- | --- |
| `botmux whiteboard status` | 看开关状态和白板数量 |
| `botmux whiteboard enable` / `disable` | 打开 / 关闭能力。关闭后已有白板保留在磁盘上 |
| `botmux whiteboard list` | 列出本机所有白板（关闭时也能用） |
| `botmux whiteboard current [--create]` | 看当前会话的白板；加 `--create` 时没有就建一块 |
| `botmux whiteboard read [--id <id>] [--json]` | 读内容；`--json` 输出 `{ id, updatedAt, content }` |
| `botmux whiteboard update [--id <id>] [--expected-updated-at <ts>] <内容>` | 整篇覆盖为最新状态（内容可走参数 / 管道 / `--content-file`） |
| `botmux whiteboard write --yes [--id <id>] <内容>` | 强制覆盖，必须加 `--yes` |
| `botmux whiteboard create [--id <id>] [--title <标题>]` | 手动新建一块白板 |
| `botmux whiteboard path [--id <id>]` | 打印白板在本机的文件位置 |

不在会话里运行时，可以用 `--session-id`、`--chat-id`、`--working-dir` 指定上下文。白板关闭时，`current` / `create` / `read` / `update` / `write` 会报错退出（退出码 2）。
