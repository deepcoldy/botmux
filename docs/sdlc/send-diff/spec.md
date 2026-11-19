# send --diff specification

## Scope and intent traceability
新增 --diff 文件参数，与 --attention 同属 send 的核心可选参数。允许 --diff=path；重复、空值、stdin 别名、与原始卡片输入或媒体混用在解析时拒绝。

## Current-state context
cmdSend 先处理 help/dry-run，再处理身份、relay、VC 和既有卡片发送。使用已有纯函数式 policy 返回 requested/path/error 与 usageError。

## Proposed behavior and user flows
接收已有 unified diff，生成每文件折叠面板，+N/-M、红绿上下文、Markdown 转义和 nbsp 缩进，整卡约 18KB 预算。正文使用 send 原有的 content-file > positional > stdin 优先级作为摘要；在既有参数校验和正文读取处生成 diff 卡片，直接进入原有发送流程。

## Architecture and data flow
src/services/send-policy.ts：parseDiffFlag/diffUsageError；src/im/lark/md-card.ts：通用 Markdown 和 diff 正文渲染，共用 createReplyCard；src/cli.ts：命令执行、普通正文读取、有界 UTF-8 diff 文件读取、dry-run、help；src/skills/definitions.ts：推荐 native 命令。

## Interfaces, schemas, and permissions
生成纯展示 schema 2.0，无 callback。dry-run 只本地解析并返回 JSON，不走会话/relay/provider。真实发送经过既有授权、路由、final、mention、预期链接、幂等和回放处理。与 --layout、--as、文档评论等组合沿用既有卡片边界。

## Failure modes and edge cases
逐行解析最多2MiB，超大文件读取有界前缀并显示部分diff，用小灰字说明截断；保留完整原文件。正常输入严格 UTF-8、hunk 数字和行数验证、Git quoted UTF-8、增删文件、rename/binary 说明、行数和字节双重截断。空 diff 不伪造变化。媒体/附件先单独交付再 final；不新增上传或补偿写操作。

## Security, compliance, and operational rules
用户内容仅作数据，无 shell。原始 diff 在调用时读取一次并作为确定性渲染输入。不会改变身份或 durable outbox 语义。live daemon 切换需单独授权（可能影响同机所有 Bot），实现和验证完成后再提交具体部署结果。

## Test, rollout, and rollback strategy
复用原型有效行为用例，将核心策略测试并入现有 send-policy 套件，增加实际 CLI dry-run、fake provider final 和受约束 relay 发送集成测试。bun 1.4.3 冻结依赖，bun run build。保留 patch、构建日志和上一版 skill；全局部署前提供具体命令和回滚路径。

## Decisions and alternatives
根据用户明确要求采用核心参数；不会安装原型插件。既有发送状态语义保持不变，diff 是输入格式适配。

## 命令层一致性重构

按照用户要求删除独立 send-diff.ts 与 argv 改写层。diff 与 attention/urgent 的参数策略同位于 send-policy.ts，执行同位于 cli.ts；卡片解析渲染统一位于 im/lark/md-card.ts，共用普通回复卡片外壳。policy 测试合并到已有 send-policy.test.ts，摘要和输入行为使用真实 CLI 测试。relay 将生成卡片放入原有 cardFile 协议，不新增宿主 flag 或身份通道。

卡片模块进一步合并：已移除独立 diff-card.ts 与独立 DiffCard 外壳类型。diff 正文和摘要使用 md-card 内现有构建函数，整张卡片配置使用 createReplyCard。diff 用例合并到 md-card.test.ts；本轮卡片模块及发送相关检查为 448 项通过、2 项 Linux 专用跳过，开发版完整构建通过；v3.54.0 候选核心检查 264 项通过。

摘要现在经过通用 Markdown 正规化（例如清理末尾无显示意义的换行），CLI 用例对照同一 body builder 验证摘要优先级。diff 行内容的换行/转义保留原实现。

## 历史PR反馈修复：标题、错误及超大diff

本节记录已推送的 f724276 版本；超大输入的完全省略方案已被下节“待审批修订”取代。

- diff摘要继续使用通用Markdown显示，但去掉生成的宿主element_id，避免H1/H2标题触发custom final保留ID校验；不放宽全局自定义卡片校验。标题仍可见，回读不再保留该摘要的宿主层级ID。
- CLI内统一卡片构建错误处理，正常发送、dry-run和relay均以单行原因+退出码2反馈用户输入或预算错误，不输出内部堆栈。
- 文件超过2MiB时，不解析全文也不截到半个hunk；输出大小和预览上限说明卡片。stats的files/added/removed为null，preview.reason为input_too_large，明确统计不可用。完整文件不被修改，仍由Agent先交付附件/链接。
- 文件stat检查后的读取结果也保留长度保护，文件增长时使用相同提示。直接调用parseUnifiedDiff的文本输入仍严格执行2MiB守卫。
- diff与plugin-card-action的当前发送互斥已先补回归并验证，不增加callback能力。

标题展示与原普通send一致：H1/H2均使用heading-2字号，H3-H6沿用正文加粗回退。本功能支持标题语法并修复final拒发，不新增diff专属样式或改变原send标题字号。

## 超限仍保留部分diff

超2MiB时使用FD读取有界前缀，最多2MiB+1字节用于判断超限；只解码2MiB，UTF-8流式解码保留末尾字符边界。解析器仅在明确前缀模式允许EOF未完成hunk，非法内容仍拒绝，未完整尾部文件头不展示。

保留原折叠文件面板，每文件最多60行；小灰字说明实际展示行数和计数仅预览。单长行显示前段并提示截断；卡片超过18KB时继续降低实际展示行或文件数。

完整输入的statsScope=full，超限前缀的statsScope=preview，部分计数只统计显示的行，未知全量省略文件数为null。本轮实现、验证和说明按明确授权更新至既有PR。

## 摘要错误与Agent重试

摘要超长时，命令原因简化为“摘要过长”，仍退出码2并在发送前结束。错误返回当前Agent；Agent精简摘要或表格后使用同一diff重试，必要时去掉可选摘要。程序不自动发送兜底话术或错误说明卡片。已成功发送不重发；本流程不新开Agent轮次，也不在CLI内运行模型。

## diff调用中的链接约定

botmux-send技能规定：文内链接按普通diff文本展示，不自动收集或加入--expected-link校验。云端文档入口URL在摘要中交付，需要防漏时可显式用--expected-link指定该入口，文内其他链接不加入。校验沿用整张卡片包含指定URL的既有行为，不强制只在摘要区域匹配；本轮不改CLI逻辑。

## FIFO非阻塞文件检查

使用O_RDONLY|O_NONBLOCK打开diff路径，再以fstat检查已打开对象是否为普通文件。无写端FIFO立即进入既有exit2错误路径，不读取管道内容；普通文件及symlink指向普通文件保持接受。未添加O_NOFOLLOW，不扩展管道输入接口，2MiB前缀和60行预览预算不变。
