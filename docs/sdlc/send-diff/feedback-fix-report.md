# PR #2515 反馈修复报告（历史版本 f724276）

本报告保留首次反馈修复的验证证据。用户随后要求超限仍显示部分diff，当前本地实现及新验证见 [部分预览修订报告](partial-preview-report.md)。以下“完全省略预览”和null统计描述仅适用于已推送的历史版本。

## 范围

修复需求文档diff的标题final拒发、异常收口和超大输入提示；先补互斥测试。生产代码仍集中在 md-card.ts/cli.ts，更新既有技能，不新增生产模块。

## 缺陷分析与结果

- 标题：H1/H2摘要的宿主element_id会被custom final拒绝。现保留共同Markdown显示样式、去掉摘要内部ID，不放宽全局保留ID规则；标题final及回放正常。
- 异常：三个构建调用点的throw缺少统一收口。现通过CLI内同一个构建函数处理，输入/预算错误为单行原因、exit2、无provider副作用。
- 大文件：用户要求超过2MiB时优雅提示。现stat超过上限直接生成说明卡片，不读全文；读取后超过上限（文件增长）同样降级。卡片明确预览省略，stats为null，完整diff保持原样。
- 互斥：原生产拒绝正确。先补Codex/thread和Claude Code/chat回归，均exit2且0次provider请求；再做守卫变异证明用例有效。

## 用例

新增8个用例，同时补强既有合法超限输入和互斥断言：H1/H2卡片保留ID、标题final、摘要字节/表格膨胀超限、stat前超大文件不读全文、stat后增长、超大文件标题final。保留正常diff、空diff、UTF-8/路径、计数/转义、摘要优先级、final/@/回放和relay基线。

## 验证

- Vitest：相关13个文件456项通过，2项既有Linux专用在macOS跳过。
- Bun：171项卡片 +80项策略 +21项CLI，272项通过。Bun的命名fs导入夹具使用真实module-mock API，与Node的syncBuiltinESMExports分别适配。
- 4项Vitest守卫变异：parse字节、stat大小、读入后长度、plugin互斥；移除各检查都会失败，验证后源码精确恢复。
- 2项Bun文件守卫变异：stat与读入后长度，均被检出。
- bun run build通过：类型、Dashboard构建与资产审计；已构建CLI对3MiB示例输出提示卡片并通过预算自查。
- 覆盖率：按技能条件跳过（用户/项目无生成覆盖率门禁，EXEC_SOURCE为空）。没有虚构覆盖率数据。
- bits-unit-test-gen Step1–Step7已执行，utree flush成功。测试流程的生产修复由本轮用户显式授权，未因测试失败削弱断言或防线。

## 行为边界

2MiB是逐行解析预算。超大文件不验证全文格式、不提供伪计数；stats和omittedFiles为null表示不可计算，preview.reason=input_too_large。原始diff需按技能流程先交付附件/链接。

摘要标题仍显示，但diff摘要回读不再保留宿主的标题层级ID；普通回复卡片未改动。预算超限只提示清晰原因，未扩展摘要自适应。保持原有卡片/媒体/语音/slash限制。

## 展示示意

![超大diff的提示卡片](../../assets/send-diff-large-file-preview.png)

根据实际命令生成的schema2.0卡片绘制，非飞书客户端截图。本轮不切换共享daemon或本机全局命令。
