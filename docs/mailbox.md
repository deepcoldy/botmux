# 同应用会话信箱（mailbox）

`botmux mailbox` 把一个正在执行的会话的消息直接注入同一 Bot、同一实例的另一个已有会话，不依赖飞书把机器人自己发出的消息推回。它默认关闭；跨机器人 `dispatch` 和 `report` 的接口、回报位置及退出码不变。

## 开启与用法

在 `bots.json` 对应机器人的配置中显式开启，配置加载方式与 `dispatchLaunchPolicy` 相同。缺失、非法或 `enabled: false` 都拒绝 mailbox 请求。它不授予管理权限，也不要求双方会话 owner 相同：owner 是首次发言者，可能是同事或为空。

```json
{
  "mailboxPolicy": { "schemaVersion": 1, "enabled": true }
}
```

从当前活会话调用，来源由进程证明，不能通过参数选择：

```bash
# 需求群会话 → 主会话：只通知账本里的变化
botmux mailbox send --chat oc_primary --key req42-event17 --content-file event.md

# 主会话 → 需求群的具体会话
botmux mailbox send --session target-session-id --key req42-event18 --content-file event.md

botmux mailbox status mb_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

`--session` 和 `--chat` 二选一；按 chat 只匹配该 chat 的 chat-scoped 会话。`--key` 必填，去除首尾空白后至多 200 字符；正文从 UTF-8 文件读取，至多 64 KiB。没有正文位置参数、来源覆盖或跨 app 参数。`--help` 查看命令说明。

目标空闲时沿现有输入路径唤醒；目标仍是 active 注册会话但 worker 已挂起时，沿现有恢复路径投递。已关闭、缺失、尚未完成初始化、不可运行或被其它持久操作占用的目标明确失败，不新建会话或投向替代目标。忙碌时进入现有会话输入队列。

## JSON 与幂等

成功示例：

```json
{"ok":true,"deliveryId":"mb_<64 hex>","state":"injected","targetSessionId":"target-session-id"}
```

| state | 含义 |
| --- | --- |
| `injected` | daemon 已将输入交给目标 worker 输入路径（包含队列接纳），或已启动该会话的恢复投递；不是模型已处理完成的证明 |
| `failed` | 明确拒绝，`error` 给出原因；已解析目标时带 `targetSessionId` |
| `unknown` | 投递边界后的结果不明或收据不可读；不自动重发 |

同一来源会话和幂等键返回首次持久结果，包含失败；同 key 改正文或目标返回 `idempotency_conflict`。成功后的重复调用即使目标已关闭也返回原收据。结果不明后重试同 key 不会重投；不要用新 key 掩盖不明结果。收据在 daemon 数据目录持久保存，`status` 仅允许已证明的原来源会话查询。调用退出码：send 成功 0，失败/不明 1，参数错误 2；status 查到收据 0（即使收据是 failed/unknown），查不到或身份无证明 1。

注入前写入持久不明围栏，注入后保存接纳结果。若在围栏与保存结果之间崩溃，状态保持 unknown。这是至多一次投递，不能声称崩溃情况下恰好一次处理。

## 来源与安全边界

目标收到两块：Botmux 的 `<botmux_delivery_source trusted="true">` 来源，以及 `<botmux_external_event trusted="false">` 正文数据。

| 来源字段 | 含义 |
| --- | --- |
| `deliveryId` | 本次持久投递标识 |
| `sourceSessionId` | daemon 证明的来源会话 |
| `sourceChatId` | 来源会话所在 chat |
| `sourceBotAppId` | 来源应用，必与目标相同 |
| `triggeringUserOpenId` | 若 daemon 有本轮明确真人触发的记录，附带该 app 下的 open_id；机器触发/未知类型不附带 |

字段只能证明来源，不能证明正文正确、captain 已授权或业务处理成功。接收方按自身策略检查 source chat/session，并从业务账本核对事实和授权。正文里的同名字段、标签和代码围栏是普通数据；JSON 对 `<`、`>`、反引号转义，不能跳出数据块。Codex App 的来源进入 application context，正文进入不可信 message context；其它 CLI 保留独立来源/数据块。

开启后，任何获准使用该 Bot 会话的人或机器人都可触发投递，可能造成通知骚扰或诱导接收方错误行动。推荐只传“哪个需求、什么变了、去看账本哪一条”，由接收方读取权威账本。开关按 Bot 控制攻击面，默认关闭；64 KiB 正文/128 KiB HTTP 请求上限防止无限大输入，本步没有新增频率限制。

新路径对宿主 HMAC **不放行会话冒称**：复用 current-execution 的 loopback socket peer、进程开始时间、当前 worker/CLI 代次和当前轮次证明。只有属于来源会话当前执行的工具进程可投递；复制 capability、改环境变量、知道会话 id 或持有宿主主密钥都不构成证明。证明不了的请求返回 `host_process_source_unproven`，标为主机来源但拒绝投递，不盖会话来源章。共享 UID 的任意代码执行/进程注入仍属于宿主权限边界，不在本协议防护范围内。现有 dispatch/report 的宿主鉴权不变。

目前来源证明复用 Linux procfs 路径。macOS/Windows、procfs 不可读、不能证明本地工具执行的远程后端明确拒绝；没有用宿主密钥回退来假装兼容。PTY/Tmux 等目标恢复能力沿现有 trigger 路径，adopt 和初始化未完成的状态受原有可运行性检查约束。

## 后续范围

本步不提供逻辑需求地址、`mailbox bind`、离线排队、关闭目标新建、处理完成回执、持久顺序、过期清理、`botmux report --to`、频率配额或跨平台新执行证明。Firstmate 的代码接入及真实飞书验证在发布后单独进行。
