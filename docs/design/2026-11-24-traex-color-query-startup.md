# TRAE 启动期颜色查询与画面静默

## 现象与根因

在 v3.59.30 上，TRAE 0.214.1 冷启动后、首条消息提交前打开可写 Web
终端，原生输入框和 model/context 页脚已经就绪，首条消息仍可能一直排队。

#3567 区分了 **Web → CLI** 的中性协议回包与人工输入，但没有区分
**CLI → Web** 的颜色查询与画面输出。实测浏览器每秒收到一次
`ESC ] 11 ; ? ESC \` 并回传 25 字节颜色响应，`forceUser=false` 正确。
查询本身不修改终端单元格，却不断推进 worker 的 screen revision、
`lastPtyOutputAtMs` 和 IdleDetector 静默计时；约 1 秒的查询周期使约
2 秒的启动静默窗口无法成立。

旧集成用例只持续发送输入侧的颜色响应，而模拟 CLI 没有持续输出查询，
因此不能覆盖这条失败路径。

## 最小修复与边界

仅对 TRAE 的**完整颜色查询组成的输出块**作窄识别：OSC 10 / 11 / 12，
兼容 BEL、ST 结束符和 C1 表达。

- renderer、WebSocket、scrollback 仍接收逐字不变的原始字节，浏览器仍正常回包。
- 仍更新进程活动时间；不把存活的查询流误判为进程无活动。
- 不更新画面 revision、画面静默时间或 IdleDetector，不以查询制造新的就绪证据。
- 混合绘制、未知 OSC、颜色赋值、擦屏、光标移动、未完成/分片序列全部保留原活动语义。
  这是保守的完整块优化，不承诺解决持续分片查询造成的所有等待。
- 不修改 Web 输入分类、人工输入代次、paste dirty、原生线程初始化、工作/阻塞状态、
  renderer drain、提交回执或 90 秒保护边界；不增加 Enter、超时强制提交或请求重放。
- 其它 CLI 保持原输出策略。没有平台系统调用变更。

## 验证

隔离 HOME / TRAE_HOME / 会话数据 / tmux socket，使用 loopback 合成模型，
没有继承生产凭据、发送业务任务、安装候选或重启线上服务。

### 真实组件差分

| Worker / 操作 | 原生精确输入回执 | 合成回复 |
| --- | ---: | --- |
| 正式 v3.59.30 二进制，启动时打开真实 Chrome/xterm | 0（24 秒观察窗口） | 无 |
| 当前主干源码，同上 | 0 | 无 |
| 当前主干源码，不打开终端 | 1 | 有 |
| 修复源码，启动时打开真实 Chrome/xterm | 1 | 有 |
| 修复后的独立编译二进制，同上 | 1 | 有 |
| 修复后的独立编译二进制，打开终端后按 Escape | 1 | 有 |
| 修复后的独立编译二进制，输入未提交草稿 | 0，草稿保留 | 无 |
| 修复后的独立编译二进制，TRAE 0.216.0 兼容回归 | 1 | 有 |

成功场景中颜色查询及 `forceUser=false` 响应仍持续，说明不是靠关闭终端、
丢弃查询或取消输入安全闸来恢复。以原生 history 的精确输入及合成模型请求/回复为
验收依据，不将 worker 初始 IPC 接纳回执当作原生已执行。

### 可重复的仓库测试

- `terminal-color-query.test.ts`：窄协议语法、合并查询与混合/未知/分片反例。
- `worker-traex-color-query.test.ts`：执行真实 worker 输出函数与真实 IdleDetector，
  验证持续查询不饿死静默窗口、字节仍原样转发、无凭空就绪、原生 working/blocked
  不被解除、其它 CLI 不变。
- `worker-traex-startup-readiness.integration.test.ts` 的
  `web-color-query-heartbeat`：真实 Worker + 模拟 CLI + 可写 WS，PTY/tmux 两种后端；
  初始化前零提交，持续双向查询/响应时初始化后仅提交一次，等待精确原生回执。

额外异常时序探针覆盖人工输入恰逢 renderer barrier、取消、generation/backend
更替、部分写入与周期查询交叠。移除 query-only 早退、revision 豁免、TRAE 范围、
原始字节 relay 或语法锚点，新增测试均出现对应断言失败。

上述真实 CLI/浏览器验收在 macOS arm64 完成；没有据此宣称 Linux 实机或生产
会话已经验收。具体测试命令和计数见 PR 验证部分。
