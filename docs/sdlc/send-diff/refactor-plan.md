# send --diff 命令层一致性重构

## 已授权输入

用户明确要求 diff 与 attention/urgent 的代码实现方式和位置保持一致，降低复杂度。计划写于 2026-10-29T12:41:33+08:00，基于已提交的 b39ed70；复用原任务与开发分支，不提交 PR、不 push 或部署。

## 修改范围与方案

- 删除 src/cli/send-diff.ts，移除独立 BOOLEAN_FLAGS、重复 positionals 遍历、正文参数过滤和 --card-json argv 改写。
- 在 src/services/send-policy.ts 中保留 parseDiffFlag/DiffUsageArgs/diffUsageError，与 attention/urgent 相同；整理完整命令段落，避免打断 urgent 的类型定义。
- src/cli.ts 使用现有参数、正文优先级和 sendDryRun 读取流程；仅在 CLI 内添加有界 UTF-8 diff 文件读取。生成后的卡片直接接入已有卡片分派、mention、final 和回放流程。
- sandbox relay 保持现有受约束 cardFile 协议，只将生成卡片放入已有出站目录；不扩展身份或 flags allowlist。
- 保留 src/im/lark/diff-card.ts 的纯解析/渲染职责，与已有 md-card.ts 的分层一致。
- 将 diff 的 policy 测试并入 test/send-policy.test.ts；删除 helper 测试文件，摘要/输入行为改由真实 CLI 测试验证，避免为已删层保留测试。

## 验证

运行现有 send-policy、diff-card、cli-send-diff、cli-send-dry-run、cli-send-custom-final、cli-send-dispatch、send 内容/路由相关检查。确认 content-file/positional/stdin 摘要、UTF-8、无效组合、多文件截断、final/mention/回放行为；diff 与 attention 都读取正文 reason；dry-run 无会话也不发送。bun run build；git diff --check。

## 交付与限制

完成后提交新的本地重构 commit，保留已提交历史。记录重构前后运行代码量与移除文件；更新设计/验证和候选技能。
旧 v3.54.0 部署候选和部署脚本须在最终提交前同步本次功能，避免未来部署旧实现；目前运行版本不切换。

## 卡片模块合并（2026-10-29T13:48:23+08:00）

用户进一步明确卡片代码尽量集中在同一位置，复用 Markdown 卡片基础。基于 9fbed24 执行本轮重构：

- 将 diff 解析、正文元素和预算逻辑合入 src/im/lark/md-card.ts，删除 diff-card.ts。
- 删除独立 DiffCard 外壳类型，统一使用 ReplyCardV2 和 createReplyCard()，共用 update_multi、width_mode 和 vertical direction。
- diff 摘要使用通用 buildCardBodyElements()，折叠面板保留逐行着色、转义和真实 diff 内容。
- CLI 直接从现有 md-card import 取得所需函数；对 diff 私有辅助函数/常量使用明确命名，避免与已有 Markdown 渲染逻辑冲突。
- 将 diff 解析/渲染测试并入已有 md-card.test.ts，移除独立 diff-card.test.ts；补充通用配置与 Markdown 摘要表格的行为验证。
- 运行 md-card、send-policy、cli-send-diff、普通 dry-run/final/发送回归和预算检查；完整构建。同步 v3.54.0 候选并验证。
- 在原分支提交本地重构 commit，更新补丁和任务记录。PR、push、共享 daemon 部署继续暂缓。
