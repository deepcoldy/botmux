# Herdr 后端：把话题会话放进已有的 Herdr 会话

默认情况下，Herdr 后端把所有话题放进机器共享的 `botmux` 会话，每个话题新开一个工作区。配置 `herdr` 后，可以把话题放进自己正在用的 Herdr 会话，按需新开 Tab，或者在指定 Tab 里分屏。

## 配置位置

- `bots.json` 单个机器人：`"herdr": { ... }`
- Dashboard：Bot 配置 → 高级 → 会话后端选择 herdr 后，旁边出现「Herdr 放置配置」区块
- 全局环境变量：`BOTMUX_HERDR_SESSION_NAME`、`BOTMUX_HERDR_PLACEMENT`、`BOTMUX_HERDR_WORKSPACE`、`BOTMUX_HERDR_TAB`、`BOTMUX_HERDR_SPLIT_DIRECTION`、`BOTMUX_HERDR_CHAT_TYPES`（逗号分隔）

两处都写时按字段叠加：机器人里写了的字段覆盖环境变量，没写的沿用环境变量；空的 `"herdr": {}` 不改变任何东西。叠加后既没有 `sessionName` 也没有 `placement` 时，配置不生效，等同于没配。

只有会话实际走 Herdr 后端时才读这份配置；后端来自机器人的 `backendType`、全局 `BACKEND_TYPE` 还是会话已记录的后端都一样。

## 字段

| 字段 | 取值 | 说明 |
|---|---|---|
| `sessionName` | 会话名 | 放进哪个 Herdr 会话，默认 `botmux`。指向别的会话时，该会话必须已在运行，否则直接报错，不会替你新建 |
| `placement` | `workspace` / `tab` / `split` | `workspace`（默认）：每个话题一个新工作区；`tab`：在目标工作区新开一个 Tab；`split`：在目标 Tab 里分屏，找不到该 Tab 时新建一个 |
| `workspace` | 工作区 id 或标签 | `tab` / `split` 用的目标工作区；不填或没匹配到时用当前聚焦的工作区 |
| `tab` | Tab id 或标签 | `split` 用的目标 Tab，也是 `tab` / `split` 新建 Tab 时的标签 |
| `splitDirection` | `right` / `down` | 分屏方向，默认 `right` |
| `chatTypes` | `group` / `p2p` 的数组 | 只对这些聊天类型的**新会话**生效；不填时对所有会话生效。其它类型的新会话放进默认的 `botmux` 会话。已存在的会话不受影响，保持原位（见下） |

`workspace` / `tab` 的匹配顺序：id 或标签完全相同 → 标签的第一个词相同（`"3"` 命中 `"3 其他"`，不会命中 `"30 归档"`）→ 标签前缀 → 标签包含。

## `chatTypes` 与已存在会话的位置

放置位置在会话创建时确定并记录，`chatTypes` 只决定**新会话**放进哪个宿主。已经存在的会话不会因为之后修改或新增 `chatTypes` 被搬走：

- 普通重启、崩溃重试都回到记录的原会话、原 Tab / 分屏，即使当前聊天类型已经不在 `chatTypes` 里。
- 若记录的窗格已经不在，会在原宿主会话里重新放置；此时聊天类型已被 `chatTypes` 排除的，不再套用 Tab / 分屏配置，按默认的新工作区放置，但仍在原宿主里，不会迁回 `botmux`。
- 唯一例外是切换沙盒 / MCP 隔离形态的重启：当前聊天类型已被 `chatTypes` 排除（或没配自定义宿主）时，会话会被收回机器共享的 `botmux`；仍在 `chatTypes` 范围内的类型保持在配置的宿主里。

## 示例

群话题放进自己的 `default` 会话里标签以 `3` 开头的 Tab，向右分屏；私聊仍放在 `botmux` 会话：

```json
{
  "backendType": "herdr",
  "herdr": {
    "sessionName": "default",
    "placement": "split",
    "tab": "3",
    "splitDirection": "right",
    "chatTypes": ["group"]
  }
}
```

## 在你自己的会话里，botmux 会做和不会做的事

- 只关闭 botmux 自己开的窗格和自己新建的 Tab；不会对你的会话执行 `session stop` / `delete`，也不会关你的工作区。
- 读取工作区 / Tab / 窗格列表失败时直接报错，不会把「没读到」当成「没有」去新建工作区或 Tab。只有会话里确实一个工作区都没有时，才新建一个，标签用 `workspace` 配置值（没填时为 `botmux`）。
- CLI 退出后关闭它留下的空窗格；重启或崩溃重试时沿用同一放置配置，回到原来的 Tab / 分屏。

## 包装脚本

`cliPathOverride` 指向包装脚本时，按 `cliId` 或可执行文件名前缀识别 agent 种类（如 `claude-botmux` 识别为 `claude`），不需要再套一层名叫 `claude` 的壳。
