# 文件沙盒（oncall 安全共享）

把某个 bot 的 CLI 会话关进一个**按会话隔离的文件沙盒**，让你能把机器人放心分享给半受信任的人（oncall）：对方可以读真实工具链/CLI 配置并操作项目，但对 `$HOME` 和项目目录的写入会落到 overlay upper，不直接改宿主真实文件；`botmux send` 通过 relay 代发，不把发送凭证通过 env/argv/IPC 注入沙盒。

> 调研与威胁模型见 [`sandbox-oncall-research-20260605.md`](./sandbox-oncall-research-20260605.md)。
> 当前 scope = **只隔离文件**（Linux）。网络**不**隔离（`npm install` / `git fetch` 照常）；不防内核级容器逃逸——面向半受信任用户，不是面向恶意攻击者。

## 启用

- **dashboard（推荐）**：bot 默认设置面板（「默认进入 oncall 模式」那块）里的「**文件沙盒**」开关，一键开关、即时落 `bots.json`、下个新会话生效。配 oncall bot 时顺手勾上。
- per-bot 手动：`bots.json` 里给该 bot 加 `"sandbox": true`
- 临时/测试：环境变量 `BOTMUX_SANDBOX=1`（对该 daemon 的所有会话强制开）

仅 Linux 生效（依赖 bubblewrap + overlayfs；非 root 通常需要 fuse-overlayfs）。非 Linux 自动跳过。macOS 的 `sandbox-exec` 后端是后续工作。

## 工作原理

当前实现是 **overlayfs read-all / write-isolated** 模型：

```
worker spawnCli
  └─ prepareSandbox()                              adapters/backend/sandbox.ts
       ├─ <dataDir>/sandboxes/<sid>/proj-upper     项目改动 upper（可落盘 changeset）
       ├─ <dataDir>/sandboxes/<sid>/proj-work      项目 overlay workdir
       ├─ <dataDir>/sandboxes/<sid>/proj-merged    项目 overlay merged
       ├─ <dataDir>/sandboxes/<sid>/home-merged    HOME overlay merged
       ├─ <dataDir>/sandboxes/<sid>/shimbin        botmux relay shim
       ├─ /var/tmp/botmux-sbx-<uid>/<sid>/home-upper     HOME 写入 upper
       ├─ /var/tmp/botmux-sbx-<uid>/<sid>/home-work      HOME overlay workdir
       └─ /var/tmp/botmux-sbx-<uid>/<sid>/outbox         botmux send relay outbox
  └─ bwrap … -- <cli> <原 args>                    把 CLI 关进 namespace
  └─ startOutboxWatcher()                          daemon 侧代投递（持凭证）
```

说明：

- 真实文件系统先以只读方式暴露，CLI 启动所需的系统工具链、Node、CLI 安装目录、认证配置等可以正常读取。
- `$HOME` 和项目目录分别由 host 侧 overlay merged 目录 bind 回原路径；读走真实 lower，写入 copy-up 到对应 upper。
- 项目改动集中在 `<dataDir>/sandboxes/<sid>/proj-upper`，供后续 diff/land 使用。
- HOME 写入集中在 `/var/tmp/botmux-sbx-<uid>/<sid>/home-upper`，避免 overlayfs upper/work 位于 HOME lower 内部。
- outbox 放在 `/var/tmp/botmux-sbx-<uid>/<sid>/outbox`，避免在 HOME overlay 内部再 bind 子目录导致部分 bwrap 环境卡在挂载阶段。
- `/var/tmp/botmux-sbx-<uid>`、`<sid>`、`outbox` 都会收紧到 `0700`；relay 内容/附件/请求/响应文件以 `0600` 写入，避免公共多用户机器上被其他本地用户读取。

**bwrap 绑定策略**（`buildSandboxArgs`）：

- `--ro-bind / /`：真实文件系统只读暴露。
- `--bind home-merged → $HOME`：HOME 写隔离；`~/.codex`、`~/.claude` 等写入 copy-up 到 `home-upper`。
- `--bind proj-merged → 原 workingDir`：项目写隔离；CLI 原本的 `-C <dir>` 等路径无需改写。
- CLI auth/login 路径按适配器声明 bind 为真实可写，用于 token refresh / 登录状态持久化。
- per-bot `hidePaths` 可用 tmpfs/empty file 遮蔽敏感路径。
- `sandboxReadonlyPaths` 可额外只读暴露参考资料，但不能覆盖 HOME/项目 overlay root。
- `--bind outbox`：沙盒内回消息的**唯一** IPC 出口，且最后 bind，避免被 mask 盖掉。
- `--unshare-user/pid/ipc/uts/cgroup`，默认保留网络。

## botmux send 中转（关键）

`botmux send` 原本**直连飞书**（读 `bots.json` 拿密钥）。沙盒内的 shim 会改走 relay，中转本身不把发送凭证通过 env/argv/IPC 交给沙盒进程：

1. 沙盒内 `botmux send` 检测到 `BOTMUX_SEND_RELAY=/var/tmp/botmux-sbx-<uid>/<sid>/outbox`，把内容、附件和 allowlist 后的展示参数写进 outbox，**不直连飞书**。
2. daemon 侧 `startOutboxWatcher` 拾取 `.req.json`，把 outbox 内的内容/附件 TOCTOU-safe 地复制到 host-private staging。
3. daemon 在**沙盒外**用真实凭证重跑 `send` 投递，并把 `.res.json` 写回 outbox。

→ relay 只保证「代发链路」不注入发送凭证。当前模型是 read-all/write-isolated，真实 HOME/配置文件默认仍可读；如果需要隐藏磁盘上的 botmux 配置、飞书密钥或其它敏感文件，必须额外配置 `sandboxHidePaths` / read isolation。

### 升级兼容

旧版本已经运行中的 persistent sandbox 会话可能仍在使用旧 HOME upper / outbox：

```
/var/tmp/botmux-sbx/<sid>/home-upper
/var/tmp/botmux-sbx/<sid>/outbox
<dataDir>/sandboxes/<sid>/outbox
```

daemon restart reattach 时会优先寻找新路径 `/var/tmp/botmux-sbx-<uid>/<sid>/outbox`；如果不存在，会 fallback 到旧路径，以便升级前已经运行的 sandbox 会话继续 relay。Claude bridge 的 HOME upper redirect 也会在旧 `/var/tmp/botmux-sbx/<sid>/home-upper` 存在且新路径不存在时继续指向旧路径，避免 persistent tmux sandbox 升级后看不到 CLI 写入。新建 sandbox 会话只使用 `/var/tmp/botmux-sbx-<uid>/<sid>/...`。

## 落盘（把改动交回）

agent 在 overlay 项目目录内改完后，改动位于 `<dataDir>/sandboxes/<sid>/proj-upper`。后续可通过 sandbox land/diff 逻辑把 upper changeset 展示给 owner review，再应用到真实项目。**交互式「应用到磁盘」确认卡是后续工作**（复用现有授权卡基建）。

## 已验证（本机实测）

- 文件隔离：项目/HOME 写入进入 upper，原文件未直接修改。
- auth/login 路径：按 CLI adapter 声明真实可写，token refresh 可持久化。
- send 中转：沙盒内 `botmux send`（含文件附件）→ outbox → daemon 代投 → 真实到达飞书；relay 链路不向沙盒注入发送凭证。
- 真实 worker：CLI 经 worker spawn 钩子在 bwrap 内正常启动运行。

## 后续

- 交互式落盘确认卡（apply/discard 按钮 + `git apply`）
- macOS `sandbox-exec` 后端
- 出口网络管控（升级到「不止隔离文件」时）
