# Antigravity 原生终端输入提速

agy 1.5.4 已实测支持 bracketed paste：约 35KB、1000 行中文消息可整段提交并在原生 transcript 完整记录。旧适配器仍为 agy 1.0 的限制逐行发送 M-Enter，并加入行间节流及提交前 300ms 等待。本次复用已存在的原子粘贴提交能力，减少终端调用和固定等待，继续通过 history 增量确认及 deferred recheck 判断提交。

```mermaid
flowchart LR
  A[已探测的启动 CLI 版本] --> B{支持已验证的粘贴版本?}
  B -->|是| C[完整粘贴帧与唯一 Enter]
  B -->|否或未知| D[保留原有软换行输入]
  C --> E[history 增量确认]
  D --> E
  E -->|未确认| F[延迟复查 不重发输入]
```

修改原生 `antigravity.ts` 与相应测试、实测脚本；`types.ts` 和 `worker.ts` 仅传递是否恢复存续进程的上下文。复用 `SpawnContext.cliVersion`，不新增启动探测进程或公共后端实现。不改 ACP，不使用 `-i`：首轮和后续轮次继续共用同一确认链路，避免引入首轮 history 不记录的差异。

版本未知、旧版、预发布版、未经过 buildArgs 的 adopt 适配器以及暖恢复的存续进程保留旧路径。Worker 通过已有后端判断显式传递 reattach，只有确定创建新进程时才使用安装版本判断，避免磁盘升级后误判旧 pane。现代路径在后端明确支持原子 `submitBracketedPaste` 时复用它，其余后端使用一次 write 写入完整帧与提交键；写入异常/未确认不切换另一种输入方式，以免重复提交。

验证覆盖 PTY、Tmux 风格能力、版本隔离、中文/空行/长消息、慢确认、写入未确认/异常、旧版兼容；真实 CLI 使用临时 HOME、工作目录、日志和窄认证副本，并校验原始认证未修改。只提交 PR，不切换全局 launcher 或重启现有 daemon。


实测使用 `bun scripts/fenced-run.ts -- node --import tsx scripts/verify-antigravity-terminal-input.ts --agy-bin <cli> --auth-dir <authentication-directory> --report <report.json>`。node-pty 探针由 Node 执行，Bun 仅执行围栏。agy 1.5.4 对 1004 行、约 29KB 中文和 emoji 输入，在真实 PTY 与私有 tmux 两条路径都只提交一次，原生完整 transcript 各仅出现一条完整输入。单次测得 history 确认分别为 113ms、268ms，完整原生记录出现分别为 3499ms、3855ms；这些是一次观测，不是模型响应耗时或性能保证。认证源文件哈希保持不变。

对抗验证发现磁盘版本不能代表暖恢复进程版本，已通过显式 reattach 上下文修复；暖恢复和未知边界保留旧路径。额外验证了写入结果不明与迟到确认、并发输入完整帧、非法 ESC 和 CRLF 归一化。


修复状态展示前的验证：在 master `5011868` 上重放本次提交后，完整构建通过。通过 fenced runner 清理会话身份/IPC 环境并串行运行 6 个相关测试文件，64 条中 63 条通过；唯一失败为 `worker-agy-delivery.integration.test.ts` 的 `keeps an active command working despite its visible empty composer`，在输入前等待 screen_update 超时。另建未修改的 master `5011868` 工作树执行同一用例，同样超时，故未将其归因于本次输入改动，随后继续定位并修复下述首提示阶段发布门控问题；此次状态展示修复以前，PR 保留草稿，未部署。跨 CLI 的 Grok tmux 启动及 Claude 启动回归通过。分别移除暖恢复与 ESC 保护的变异测试均准确失败，随后恢复源码。


后续修复：首提示门控期间，已有运行命令的 Antigravity 会话被屏幕定时器直接返回，导致真实运行画面被隐藏。仅当原生终端具有权威视图、视图包含 busyPattern、且原生会话记录证明仍在运行时，允许发布 working 画面及后续变化。仅修改观测发布，不解除 awaitingFirstPrompt、不发布 prompt_ready、不触发输入；普通启动、旧 transcript 配空闲画面仍保持门控。对应修改 `worker.ts`，增加定时器行为测试，并重跑真实 worker 现有用例。启动性能脚本增加进程创建至输入就绪及提交至确认的分段计时。


状态展示修复的定向验证：原失败的真实 worker 用例及 7 条新定时器行为测试均通过。使用真实 xterm renderer、原生 busy 状态和临时 transcript 验证运行帧及其变化会发布，空输入框、坏 transcript、非权威后端不发布。跨 CLI 保留 argv 首轮只截图/发布一次，避免每个 tick 额外遍历画面。移除 native 发布条件或 argv 截图去重条件的变异均触发对应行为测试失败。

启动计时覆盖两个范围：真实 CLI 从进程创建到输入框就绪，以及已构建 worker 从创建到首条 prompt 进入原生 transcript。后者通过 `--worker` 启用，在隔离的 API 会话使用小 prompt、关闭 prompt 注入，不含飞书传输或模型答案生成耗时。所有记录保留实际毫秒数，不将 history 确认时间等同于模型响应时间。


两轮 agy 1.5.4 实测：PTY 输入框就绪 947/936ms，长消息确认 108/112ms；tmux 输入框就绪 988/1000ms，长消息确认 374/338ms。完整 worker 创建至首条小 prompt 进入原生会话，PTY 为 7561/10338ms，tmux 为 10829/11629ms，因此此机器本轮可观察的启动范围约 8–12 秒。两轮所有长输入都只有一条完整原生记录，认证源哈希未变。


修复后的完整相关验证：完整构建通过；10 个相关测试文件覆盖89个用例，双worker运行88/89通过，唯一ACP/tmux长输入用例在20秒断言内超时。相同代码、相同断言及预算串行复跑ACP完整3用例均通过，未跳过或放宽断言。原失败native状态用例、新增7条行为测试、Grok/Claude启动与argv状态回归均通过。ACP失败轮长帧输入阶段约10.57秒，未记录final OSC精确到达时间，因此仅保留并发时序不稳定的限制，不宣称发现结果丢失或收尾死锁。
