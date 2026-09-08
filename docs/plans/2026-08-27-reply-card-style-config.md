# 回复风格配置化（PR #1057 终态规格）

`--layout` 薄壳 + 按 bot 配置的实现规格。写作配方、`width_mode: fill`、`heading-2`、表格 live 回读已在同 PR 落地。

**本轮定稿（实现必须对齐，不要自行改语义）：**

- 五档：`result` / `progress` / `risk` / `blocked` / `handoff`
- 卡头：绿 / 蓝 / 橙 / 红 / **indigo**（交接不用 grey，避免像已失效）
- 标签：只有 `risk`、`blocked` 带「需要你」；其它档不带标签
- **不设** `compare` 档：对比用自由 Markdown；要人做选择走 `risk` + `botmux ask`
- **Diff 分栏不进本轮**（仍记在 `docs/plans/2026-08-27-reply-card-layer2-backlog.md`，另开）
- **卡头标题**：`{前缀}`；正文有首个 ATX H1/H2 则 `{前缀} · {标题文本}`，并取走该行不再当正文 heading 渲染。无 `--layout-title`，不从正文猜档。前缀：result=结果、progress=进度、risk=需要确认、blocked=受阻、handoff=交接

配置落在 **bot 维度**。飞书一条卡片只有一份渲染，群里不能按读者换皮肤。私聊按人配不进本轮。

## 底线（任何配置组合都不放开）

- 不做假按钮；要选择走 `botmux ask`
- 不接受调用方注入任意卡片 JSON 当「主题」（`--card-json` 仍是逃生阀，和风格配置无关）
- quoted / history 回读对等：换主题不能让跨 bot 读回丢字段
- 不从正文猜成功/失败再上色；颜色只来自 Agent 显式 `--layout <档>` + 该 bot 的主题映射

## 配置项清单

| 键 | 类型 | 缺省 | 作用 |
|---|---|---|---|
| `replyStyle.recipes` | bool | `true` | 是否把五类写作配方注入 `botmux-send` 指南。`false` → 指南回到纯自由 Markdown |
| `replyStyle.layout` | bool | `true`（layout 能力落地后） | 是否允许 `--layout`。`false` → flag 被忽略，回退普通回复卡 |
| `replyStyle.theme` | `'default' \| 'minimal' \| 'vivid'` | `'default'` | 预设主题，只改变壳的「重」，不改变五档语义 |
| `replyStyle.recipePrompt` | string | 缺省 | 非空则替换内置配方区；缺省用内置五类配方 |
| `replyStyle.layoutColors` | 对象 | 主题缺省 | 每档卡头颜色，键为五档名，值必须是飞书 `header.template` 官方枚举 |
| `replyStyle.layoutTags` | 对象 | 主题缺省 | 每档标签文案。缺省：仅 `risk`/`blocked` 为「需要你」。空字符串 = 该档不显示标签 |

`layoutColors` 只允许飞书卡头 template 枚举：`blue` / `wathet` / `turquoise` / `green` / `yellow` / `orange` / `red` / `carmine` / `violet` / `purple` / `indigo` / `grey`。未知档名、非法颜色、非字符串标签一律忽略并打日志，该档回退当前主题缺省，整张卡仍发出、不 fail。微调不能突破底线：不能用这个口子加按钮、进度条或任意 JSON。

长度与安全硬上限（按 Unicode code point 计，避免 emoji 被 UTF-16 腰斩）：

- `recipePrompt` 最多 **4096** 个 code point。超限、含 `NUL`、非字符串 → 忽略该字段并打日志，回退内置配方。
- `layoutTags` 单档最多 **32** 个 code point。超限、含 `Cc` 控制字符、非字符串、未知档名 → 忽略该档并打日志，回退当前主题缺省。

都是**逐项**忽略回退，不整块拒绝，不阻断 bots.json 加载或发送。`recipePrompt` 非空时**替换**内置配方区，不是追加；空或省略仍用内置文本。

## 预设主题

五档语义固定，主题只调视觉重量。

| 主题 | 卡头 | 标签 |
|---|---|---|
| `default` | `green` / `blue` / `orange` / `red` / `indigo` | 仅 `risk`、`blocked` →「需要你」 |
| `minimal` | 五档都无彩色 template，只留标题 | 仅 `risk`、`blocked` →「需要你」 |
| `vivid` | 同 default 的五色 | 五档都带：完成 / 进行中 / 需要你 / 需要你 / 交接 |

`vivid` 的额外标签是主题增量；**default 才是定稿观感**。实现时 default 不得给 result/progress/handoff 加标签。

**标签颜色（已拍板）：语义色固定，不随 `layoutColors` 卡头色漂移。** `text_tag.color` 用飞书标签官方枚举（与 `header.template` 不是同一张表；标签有 `neutral`/`lime`，没有 `grey`）。

| 档 | 标签文案（vivid 全开；default 仅 risk/blocked） | `text_tag.color` |
|---|---|---|
| result | 完成 | green |
| progress | 进行中 | blue |
| risk | 需要你 | red |
| blocked | 需要你 | red |
| handoff | 交接 | indigo |

不在标签官方枚举内的色忽略并打日志，该档标签色回退 `neutral`，整张卡仍发出、不 fail。改 `layoutColors` 只动卡头 template，不动上表。

短确认、未传 `--layout`：三种主题都 **不套壳**。没有 `compare`、`diff` 这两个名字。

## 卡头标题生成

档位只来自显式 `--layout`。`header.title` 按下面确定规则生成，不要新增 CLI flag。

| `--layout` | 固定前缀 |
|---|---|
| `result` | 结果 |
| `progress` | 进度 |
| `risk` | 需要确认 |
| `blocked` | 受阻 |
| `handoff` | 交接 |

1. 扫描正文第一个 ATX H1 或 H2（与会提升成 `heading-2` 的同一批）。H3+、Setext、代码围栏里的 `#` 都不算。
2. 没有这样的标题 → `header.title.content` = 前缀。
3. 有标题 → 默认 `{前缀} · {该标题文本}`，**并从正文去掉这一行**，不再渲染成 heading-2。
4. **防重复**：去掉空白后，标题文本等于前缀，或只是前缀的重复表述（如 `# 结果`、`# 需要确认`、`# 结果 · 结果`）→ 卡头只显示前缀，不出现「结果 · 结果」。该行仍从正文取走，避免正文再出一遍同样的 heading。
5. **回读对等**：标题进 `header.title`（以及 risk/blocked 的 `header.text_tag_list`）后，quoted/history 必须能从 header 读回。测例用 **live 归一化形态**（飞书可能把 title 收成 `{ tag, content }`），不能只测 builder 输出。取走正文行的前提是 header 回读不丢，否则就是本轮表格教训重演。

## 落点

**bots.json**（每个 bot 一条，紧挨 `brandLabel` / `usageDisplay` 这类展示配置）：

```json
{
  "replyStyle": {
    "recipes": true,
    "layout": true,
    "theme": "default",
    "recipePrompt": "",
    "layoutColors": { "handoff": "indigo" },
    "layoutTags": { "risk": "需要你", "blocked": "需要你" }
  }
}
```

缺省整块省略 = 上表缺省。不要做成全局 daemon 配置，避免一改全员 Bot 变脸。`layoutColors` / `layoutTags` 只写要覆盖的档，未写的档走当前主题。

**Dashboard**：Bot 设置里、品牌文案附近加一小节「回复风格」。本轮 UI：

- 配方引导：开 / 关
- layout 壳：开 / 关
- 主题：默认 / 极简 / 鲜明（下拉，枚举写死）
- 配方文本：多行输入，空 = 用内置引导
- 每档卡头颜色：五档各自一个下拉，选项锁官方色板；另加「跟随主题」
- 每档标签：五档各自一个短文本；空 = 跟随主题（default 下 result/progress/handoff 为空）

**skill 注入**：`replyStyle.recipes === false` 时，`botmux-send` 内置指南去掉配方表和选型信号，其它发送契约不变。`layout === false` 时指南不提 `--layout`。

**CLI**：`--layout` 只在 `layout !== false` 时生效；关掉则 stderr 一行提示已忽略，消息仍按普通回复卡发出，不 fail。非法名称（`diff` / `compare` / 缺值 / 重复）同样 fail-soft：stderr 提示后当普通回复卡发出。

**CLI vs relay：** CLI 层 fail-soft 面向用户输入，保证合法调用「发送不失败」。sandbox relay 的 host 校验面向伪造/篡改的 outbox——沙箱内 CLI 只会转发五个 canonical 名，host 再见到非法 `--layout` 只可能是绕过 child 的请求，硬拒绝（与 `--response-kind` 同门）。两层不矛盾，后人不要当成规格冲突。

**会话快照（自有 pane）：** worker spawn 把归一化后的稀疏对象冻进 `BOTMUX_REPLY_STYLE`。同一 pane 里 `botmux skill show botmux-send` 与 `botmux send` 都读这份快照，避免长会话中途改配置导致指南和渲染分叉。Riff/Mojo 在用户 env 合并后再冻一次，防止旧值/伪造值覆盖。共享持久后端在会话边界清理该键，避免跨 bot 泄漏。

**adopt / restore-adopt（非侵入，按 A 收边界）：** 不向已运行的外部 CLI 注入 env / skill / 动态指南，init **不带** `replyStyle`。不要把这条写成「adopt 不支持 replyStyle」：

- 指南注入不生效；磁盘 native/global 的 `botmux-send` 永远是稳定 loader（不含个性化配方或 `--layout`）
- `botmux skill show botmux-send` 只有同时存在 `BOTMUX_SESSION_ID`、`BOTMUX_LARK_APP_ID`、`BOTMUX_REPLY_STYLE` 才按快照个性化；缺任一则固定出厂默认指南（忽略环境里残留的无关快照）
- `botmux send --layout` 照常可用：按该 session 的 `larkAppId` 读 live `bots.json` / 内存 registry（无 worker 快照时，Dashboard 改完即时生效）

## 切分

### 本轮终态（本 PR）

1. 五档 layout 薄壳：卡头按上表 + 规定标签 + 正文仍走现有 Markdown（不加原生分栏、不加进度条、不加按钮）
2. `replyStyle.recipes` / `replyStyle.layout` / `replyStyle.theme`；枚举锁死，非法值忽略并回退缺省，发送不失败
3. `replyStyle.recipePrompt`：非空则**替换**内置配方区；空或省略 = 内置文本；最长 4096 code point，超限/NUL 逐项忽略
4. `replyStyle.layoutColors` / `replyStyle.layoutTags`：官方色板内每档微调；非法值按档回退主题缺省；单档标签最长 32 code point，超限/`Cc` 控制字符逐项忽略
5. bots.json 解析 + Dashboard：三个开关/主题下拉、配方多行文本框、每档颜色下拉、每档标签输入
6. `recipes === false` 时指南去掉配方表和选型信号（自定义 `recipePrompt` 也不注入）；`layout === false` 时指南不提 `--layout`，CLI 忽略 flag，颜色/标签配置不生效
7. 回读：换主题或微调颜色/标签后 `quoted` / `history` 仍能还原正文、表格、以及被取进 `header.title` / `text_tag_list` 的标题与标签；测例必须用 **live 归一化形态**，不认 builder 原始 JSON
8. 自有会话冻 `BOTMUX_REPLY_STYLE`；adopt 不注入指南；`skill show` 无完整会话标记则固定默认指南；adopt/global 的 `send --layout` 按 `larkAppId` 读 live 配置

### 本轮之后

1. Diff 分栏（见 layer2 backlog）
2. 私聊按人覆盖（若要做）；群聊永远不按读者分皮肤

## 明确不做（本轮）

- `compare` 档、`diff` 档、进度条、假按钮、插件模板
- 读者侧主题切换、一条消息两套渲染
- 从标题或正文关键词自动选档、自动上色
- 任意卡片 JSON 当主题
- 用 grey 做 handoff 卡头
