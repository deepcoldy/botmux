# 回复卡第二层 backlog（未启动）

本轮已收口第一层：自由 Markdown + 五类写作配方；回复卡 `width_mode: fill`、H1/H2 `heading-2`；原生表格 quoted 回读认 CardKit 归一化单元格。第二层等下轮拍板后再细化，本文只记账。

## 硬约束（任何第二层布局都要满足）

**quoted / history 回读必须对等。** 发出去的结构，跨 Agent `botmux quoted` / `history` 必须还能读回同等事实。本轮教训：`botmux send` 把表格发成 schema 2.0 native `table`，飞书读回时把 `lark_md` 单元格收成 `tag: markdown → property.elements[].property.content`（还可能夹 `code_span`）。只测 builder 原始 JSON 会绿、线上仍丢表。

下轮新增任何组件（`column_set` Diff、卡头、layout 壳）必须：

- 解析器吃 **live 归一化形态**，不只 builder 输出
- 单元格 / 分栏 / 标题文本都能还原成可读 Markdown
- 回归里同时覆盖 send 形态和 `quoted --raw` 形态
- 不用 `quoted --raw` 的 config 反证发送字段：飞书会剥掉 `width_mode` / `text_size` 并把标题收成 `**加粗**`

## 开放能力：`--layout` 薄壳

**语义：** 默认仍是自由 Markdown。Agent **显式 opt-in** 才套壳，不是选择器，也不是插件。

候选（下轮再砍）：

| 名字 | 意图 | 壳做什么 | 正文 |
|---|---|---|---|
| 不传 | 短确认 / 对不上配方 | 无 | 现有 renderer |
| `result` / `progress` / `compare` / `risk` / `handoff` | 与五类写作配方对齐 | 最多加中性卡头标题，不上色、不猜状态 | 仍走现在的 Markdown 渲染 |
| `diff` | 代码前后对比 | 见下一节 | 见下一节 |

不做：`--card-template`、插件加载器、自动根据正文猜 layout、彩色状态头、假按钮（选择继续走 `botmux ask`）。

## 开放能力：Diff 分栏 opt-in

**语义：** 只有 Agent 明确要 Diff（`--layout diff` 或等价约定）才左右分栏。禁止从普通相邻代码块猜测。

- 桌面：`column_set` 两列，左「之前 / 删除」、右「新增 / 变更后」
- **移动端回退：** 列宽不够时不得挤成两条窄栏。`flex_mode` 在窄屏上改为上下堆叠（先 before 后 after），或直接退回顺序代码块。回退必须保持同样的文本事实，quoted 不能只剩其中一列
- 单元格/代码块同样要走 live 归一化回读；`extractElementText` 已递归 `column_set`，但要补 **CardKit 读回后的列结构** 测例
- 体量上限先沿用现有卡片截断策略，完整 Diff 给链接，不在卡里塞整份 patch

## 字段清理（本轮刻意没动）

同类失效字段，下轮和 layout 一起扫，避免再出现「JSON 改了、客户端没变化」。

1. **`wrapAdoptCard`**（`src/im/lark/card-builder.ts`）：`schema: '2.0'` 却 `config.wide_screen_mode: true`。2.0 宽屏字段是 `width_mode: fill | compact | default`。与本轮回复卡修过的洞同构。只改 adopt 管理卡，不要把全部 schema 1.0 流式卡的 `wide_screen_mode` 误改掉。
2. **回复卡 footer** `text_size: 'notation_small_v2'`（`buildReplyCardFooter`）。2.0 markdown 枚举是 `notation`；其它值回落 `normal`，页脚可能并不比正文更小。改字号时必须同步 `message-parser.ts` 里按 `notation_small_v2` 识别 footer 的分支，否则会漏剥或误剥。

## 下轮启动前先确认

- 要不要 `--layout` 这个 CLI 面，还是继续只靠写作配方
- Diff 是否值得单独做；不要和进度条、自动上色绑在一起
- adopt / footer 字段清理是否并进同一 PR（建议：字段清理可先于 layout，风险更小）
