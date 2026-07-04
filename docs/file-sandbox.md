# 文件沙盒（oncall 安全共享）

把某个 bot 的 CLI 会话关进一个**按会话隔离的文件沙盒**，让你能把机器人放心分享给半受信任的人（oncall）：对方只能操作 agent + 一份项目副本，**碰不到你磁盘上的真实文件、密钥、别的会话数据**。

> 调研与威胁模型见 [`sandbox-oncall-research-20260605.md`](./sandbox-oncall-research-20260605.md)。
> 当前 scope = **只隔离文件**（Linux）。网络**不**隔离（`npm install` / `git fetch` 照常）；不防内核级容器逃逸——面向半受信任用户，不是面向恶意攻击者。

## 启用

- **dashboard（推荐）**：bot 默认设置面板（「默认进入 oncall 模式」那块）里的「**文件沙盒**」开关，一键开关、即时落 `bots.json`、下个新会话生效。配 oncall bot 时顺手勾上。
- per-bot 手动：`bots.json` 里给该 bot 加 `"sandbox": true`
- 临时/测试：环境变量 `BOTMUX_SANDBOX=1`（对该 daemon 的所有会话强制开）

仅 Linux 生效（依赖 bubblewrap）；非 Linux 自动跳过。需要 PTY 后端（tmux/zellij 后端暂不包裹，自动回退直跑）。macOS 的 `sandbox-exec` 后端是后续工作。

## 工作原理

```
worker spawnCli
  └─ prepareSandbox()                      adapters/backend/sandbox.ts
       ├─ 每会话目录 <dataDir>/sandboxes/<sid>/{home,work,outbox,shimbin}
       ├─ git clone --no-hardlinks 源项目 → work（独立 .git，动不了源仓库）
       ├─ seedScopedConfig(cliId)          只拷认证(auth.json/config…)，剔历史
       ├─ 写 botmux shim → PATH 头（让沙盒内 botmux 走本 build 的 relay）
       └─ buildSandboxArgs()               bwrap 参数
  └─ bwrap … -- <cli> <原 args>            把 CLI 关进沙盒
  └─ startOutboxWatcher()                  daemon 侧代投递（持凭证）
```

**bwrap 绑定策略**（`buildSandboxArgs`）：

- `--ro-bind` 系统工具链（`/usr` `/bin` …）+ fnm node/CLI 安装目录 + botmux dist + node_modules
- `--bind scopedHome → $HOME`：脱敏家目录盖住真实家目录，于是 `~/.codex`、`~/.claude` 等都落在脱敏区
- `--bind 项目副本 → 原 workingDir`：副本挂在 CLI 原本认得的路径上，所以 `codex -C <dir>` 之类参数无需改写
- `--bind outbox`：沙盒内回消息的**唯一** IPC 出口
- 不绑：`~/.ssh`、`~/.aws`、`bots.json`、别的会话/项目、各 CLI 历史
- `--unshare-user/pid/ipc/uts/cgroup`，默认保留网络

**per-CLI 脱敏配置**（`seedScopedConfig` + `CONFIG_SCOPE`）：每会话新建配置目录，**只**拷该 CLI 启动所需的认证/配置，历史/会话/日志一律不进沙盒。已覆盖 codex、claude-code；新 CLI 加一条 `CONFIG_SCOPE` 即可。

## botmux send 中转（关键）

`botmux send` 原本**直连飞书**（读 `bots.json` 拿密钥）。沙盒里没有 `bots.json`，所以：

1. 沙盒内 `botmux send` 检测到 `BOTMUX_SEND_RELAY`，把请求（argv + 内容文件 + 附件）写进 `outbox`，**不直连飞书**
2. daemon 侧 `startOutboxWatcher` 拾取请求，在**沙盒外**用真实凭证重跑 `send` 投递，结果写回
3. 附件被拷进 `outbox`（共享路径）后路径改写，host 侧才读得到

→ **所有飞书密钥全程不进沙盒**。

## 落盘（把改动交回）

agent 在副本上改完，用 `botmux send --files <patch>`（`git diff` 出来的补丁）把改动交回话题，owner review 后手动应用。**交互式「应用到磁盘」确认卡是后续工作**（复用现有授权卡基建）。

## 已验证（本机实测）

- 文件隔离：宿主密钥/家目录读不到，原文件未动
- per-CLI 脱敏：codex `auth.json` 进得去、`history.jsonl` 进不去
- 项目副本独立（`git clone --no-hardlinks`）
- send 中转：沙盒内 `botmux send`（含文件附件）→ outbox → daemon 代投 → 真实到达飞书，全程零凭证入沙盒
- 真实 worker：codex 经 worker spawn 钩子在 bwrap 内正常启动运行

## 后续

- 交互式落盘确认卡（apply/discard 按钮 + `git apply`）
- macOS `sandbox-exec` 后端
- tmux/zellij 后端支持
- 沙盒目录 GC / 生命周期
- 出口网络管控（升级到「不止隔离文件」时）
