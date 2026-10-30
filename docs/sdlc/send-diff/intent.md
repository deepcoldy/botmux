# send --diff

## Background and problem
需求讨论会持续迭代需求文档。Agent 修改后通常只给出新文档或简短摘要，用户不知道本轮真实新增、删除或改写了哪些内容，难以核对改动与讨论结论是否一致。

## Users
在飞书与 Agent 讨论、迭代并确认需求文档的用户，以及执行文档修改的 Agent。

## Goals and core requirements
让用户在每轮文档修改后直接查看真实前后差异，按新增、删除和保留上下文核对修改。新增 `botmux send --diff <统一diff文件> [摘要]`，通过逐文件折叠卡片呈现实际差异；botmux-send 技能要求保存本轮基线并生成真实 diff。

## Constraints and assumptions
用户已明确要求与 attention/urgent 的参数规则和执行位置保持一致，卡片代码集中在已有 md-card.ts。命令读取已有 unified diff，不自动编辑文档或编造前后版本。完整 diff 可先交付附件，卡片控制展示体积并保留真实计数。

## Success criteria and verification
用户能在飞书核对需求文档本轮实际修改；Markdown特殊字符、路径、缩进与上下文按规则呈现。相关解析/渲染、参数、dry-run、final/@/回放及relay检查通过；完整构建通过，本机试用展示可用。

## Non-goals
悬停浮层、等宽彩色代码块、二进制内容预览、改变既有权限和投递状态语义。

## Open questions / decision record
实现和本机试用已完成。今后新的PR先交用户审批初稿，通过后再提交。用户最新明确要求保留既有PR #2515并更新描述；该PR已恢复为Draft，核心场景为需求讨论中查看Agent本轮真实文档修改。正式ready、合并或发版仍属于后续步骤。
