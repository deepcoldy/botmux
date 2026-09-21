# 文件沙盒第三模式：scratch（全根 COW，关盒即焚）

日期：2026-09-21
状态：**已实现**（owner 已批准方向：三模式并存，不替换 oncall）；真机探针 + 真 claude/codex 端到端通过，全量 unit 对照干净 master 零新增回归。待 live worker 会话验收（需 owner 口令部署本 checkout）
作者：Claude

## 1. 背景

文件沙盒已有两代上线模型：

- **v2 overlay（2026-06，PR #161）**：`bwrap --ro-bind / /` 读整个真实文件系统，HOME/项目各挂一层 overlayfs，写 copy-up 到 upper（宿主零改动），改动经 `/land` 落盘。后因 oncall 共享场景的**保密性**问题（读全 + 黑名单遮罩反复 fail-open：lark-cli 密钥库、bots.json sidecar 等）与挂载/landing 复杂度，于 2026-07 被重构。
- **v3 oncall/白名单（现状，PR #407/#482）**：deny-by-default 三档 FsPolicy（readWrite/readOnly/deny）+ tmpfs 根，白名单内的写**直达宿主、即时落盘**。保密性在结构上成立，但代价是：① 白名单外路径在沙盒内"不存在"，每个新 CLI/每种宿主布局都要手工声明 authPaths/数据目录（#355 symlink HOME、#356 codex SQLite 锁、#362 多个 CLI 状态目录，半年修不完的一类 bug）；② 不提供"改动可弃"语义——owner 自己让 agent 做实验时，白名单内的写直接污染真实仓库与 dotfiles。

owner 的需求是第三种、与 oncall **威胁模型正交**的模式：

> 启动一个虚拟的沙盒环境，允许用户任意使用读写权限，不落盘、不影响沙盒外环境。

即"整台机器的一次性草稿纸"：读全盘（CLI 原生配置/授权零摩擦）、写哪里都行但只进 COW 上层、会话结束全部丢弃。本文件是该模式（下称 **scratch**）的设计。

## 2. 三模式对比

| | `off` | `oncall`（现状默认沙盒） | **`scratch`（新增）** |
|---|---|---|---|
| 目标 | — | 半信任使用者：**保密**（读不到别人的凭证/数据） | owner/可信载荷：**完整可弃**（写不污染宿主） |
| 可读范围 | 全部 | deny-by-default 白名单 | **全部**（真实 fs 原生视图） |
| 写 | 直达宿主 | 白名单内直达宿主 | **全部进 COW upper，宿主永不变** |
| 改动保留 | 永久 | 即时落盘 | 默认关盒即焚；可选 disk upper 跨重启存活 |
| 落盘命令 | 不需要 | 不需要 | **不提供 /land**（要改动请在 off/oncall 下跑；scratch = 一次性） |
| 网络 | 通 | 默认通（可配） | 默认通（可配） |
| 抗恶意载荷 | 无 | 有（读边界 + seccomp 判据 + 凭证 relay） | **无承诺**：载荷可读全盘 secret 并经网络外发；只防"写"的意外/误操作 |
| 平台 | 全 | Linux bwrap + macOS Seatbelt | **Linux only**（bwrap + overlayfs/fuse-overlayfs；macOS 内核无 COW 原语，UI 隐藏并报错指引） |
| 典型用户 | 单机自用 | 把 bot 分享给 oncall/群友 | owner 自己跑破坏性/试验性任务 |

两个沙盒模式互斥（一个会话只能一种），但共用 outbox relay、seccomp 隔离判据、shim、内部路径穿透 bind 等设施。

## 3. 机制（已在 live 机实测，2026-09-21）

环境：root、kernel 5.15.120、bwrap 0.8.0（无 `--overlay`）、ext4 根、fuse-overlayfs 已装。

```
host 侧（daemon 进程，root 用内核 mount，非 root 用 fuse-overlayfs）:
  <upperSlot>/upper, <upperSlot>/work, <dataDir>/sandboxes/<sid>/root(merged)
  mount -t overlay overlay -o lowerdir=/,upperdir=<upper>,workdir=<work> <merged>

bwrap（包 CLI 进程，与 v3 同一注入点）:
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts
  --bind <merged> /                 # 容器根 = 全根 COW 视图
  --proc /proc --dev /dev
  --tmpfs /tmp --tmpfs /run --tmpfs /var/tmp --tmpfs /dev/shm   # /var/tmp 顺手遮蔽 upper 槽
  ……v3 已有的内部穿透 bind（outbox /run/sbxbin shim、trustedBotmuxCommandPaths、MCP gateway socket）原样保留……
  -- <cli> <args>
```

实测结论：

1. **root + tmpfs upper**：`mount -t tmpfs` 作 upper 槽（独立超级块），全根 overlay 挂载成功；容器内读写 `/etc`、`/root`、根目录任意路径全部成功（copy-up），宿主逐项核验零改动；umount 零残留。
2. **root + 磁盘 upper 与 lower=/ 同 ext4**：本机 5.15 内核**直接允许**（v2 时代注释的 "upper inside lower" 限制在此内核不触发；挂载失败的环境仍有 tmpfs 槽兜底，fail-closed 报错不裸跑）。
3. **跨重启 resume**：磁盘 upper 模式 umount 后用同一 upper/work 重新 mount，COW 内容完整可见。daemon 重启 = 重挂即可恢复；tmpfs upper 随 mount namespace 死亡，模式下声明不支持跨重启恢复。
4. **非 root**：`fuse-overlayfs -o lowerdir=/,upperdir=…,workdir=… <merged>` 成功，非 root `bwrap --bind <merged> /` 写入隔离与宿主零泄漏同样成立（仅需 /dev/fuse 与 userns，v2 已有检测/自动装依赖逻辑可复活）。
5. **upper 槽遮蔽**：bwrap `--tmpfs /var/tmp` 后容器内看不到 upper 槽目录，且 /var/tmp 正常可写。

## 4. 配置

`bots.json` per-bot：

```json
{ "sandbox": "scratch" }
```

- 类型从 `boolean` 宽化为 `"off" | "oncall" | "scratch"`：
  - `true` → `"oncall"`；`false`/缺省 → `"off"`（读取归一化，写盘不强制改）。
  - `BOTMUX_SANDBOX=1` 保持原语义（=oncall）；新增 `BOTMUX_SANDBOX=scratch` 显式取值；未识别取值 fail-closed 报错。
- scratch 专属子配置（均可选）：

```json
{
  "sandbox": "scratch",
  "scratchStorage": "tmpfs",       // "tmpfs"(默认;内存,关盒即焚) | "disk"(upper 落盘,支持 daemon 重启续跑,会话结束删除)
  "scratchTmpfsSizeMb": 0,         // 0=内核默认(≈半内存);大构建可调
  "scratchNetwork": true,          // 缺省 true 保留网络;false 加 --unshare-net
  "scratchDenyPaths": []           // 可选额外遮罩(绝对路径,mode-000 mask,同 oncall deny 编译)
}
```

- **固定 mandatory 遮罩（深度防御，不可配开）**：bots.json 及其备份/sidecar（`*.bak*` 等，沿用 read-isolation 已枚举的集合）、`.dashboard-secret`、webhook 主密钥文件等 **botmux 自身传输凭证**。理由：沙盒内本就不直连飞书（send 走 relay），这些文件对 CLI 干活零用途，遮住不产生"路径不存在"类回归；它不构成恶意载荷下的安全承诺（读全 + 网络通仍可读其它 secret 外发），只是消除最蠢的自伤面。`~/.ssh`/`~/.aws` 等**不**进固定集（owner 场景 git ssh/云 CLI 要用），需要的人走 `scratchDenyPaths`。
- 校验：`scratch` + `codexBrowser`/`existingAppServer` 沿用现有互斥报错（3331/3345 行附近）；`sandboxPaths`（oncall 白名单）在 scratch 下被忽略并在启动日志告警（不是错误）。
- macOS 上选 scratch：dashboard 控件隐藏/置灰；bots.json 显式写了则 daemon 启动校验报错（与 riff 远端后端等"不支持"一致的硬错误，绝不静默降级成 off 或 oncall）。

## 5. 生命周期

每会话目录：`<dataDir>/sandboxes/<sid>/`

- tmpfs 模式：`root/`（merged 挂载点）、`outbox/`、`shimbin/`、`empties/`（后三者 v3 同名同义）；upper/work 在 `/var/tmp/botmux-sbx/<sid>/{upper,work}`（tmpfs 挂载于该目录）。
- disk 模式：再加 `upper/`、`work/`；会话结束整体删除。

状态机：

1. **冷启动 spawn**：fail-closed 顺序——建目录 → 挂 upper 槽（tmpfs 模式）→ 挂 overlay（失败：root 内核挂载失败且同 fs 时不自动乱试，直接报错给会话卡；非 root 走 fuse-overlayfs）→ 编译 bwrap argv（merged bind 为根 + tmpfs 遮蔽 + v3 内部穿透 bind + seccomp 判据 + deny masks）→ spawn。任何一步失败：清理已建挂载并**硬失败**，worker 不得裸跑（沿用 v3 `DirectSandboxSpawn | null` 契约）。
2. **Session 冻结字段**：`sandboxMode: 'oncall'|'scratch'`、`scratch?: { storage, mergedHostPath, upperHostPath }`。reattach/adopt 沿用 v3"沙盒决策按会话冻结、历史会话不被新配置重新沙盒化"的规则。
3. **宿主侧读取（daemon 视角）**：CLI 在容器内写的一切（含 `~/.codex/*.jsonl`、`~/.claude/projects/**`、events.jsonl、cwd 下产物）宿主真实路径看不到，**统一映射到 `join(mergedHostPath, canonicalAbsPath)`**——只有一个 merged 根，纯前缀映射（v2 是 project/home 两个映射点，v2 的 bridge redirect 调用点清单见 §8 接线）。所有输入路径先 realpath 规范化（symlink-HOME 教训 #355）。overlay 未挂载时这些路径 ENOENT，按"会话未恢复"显式报错，不回退读宿主真实路径（否则会把陈旧/别人的数据当成本会话）。
4. **suspend**：v3 suspend 杀 CLI 回收内存。scratch 下 host 侧 overlay **保留挂载**（tmpfs upper 本就在内存，留着成本与恢复速度权衡后定：默认保留，同 v3 pane 语义；resume = 重新 bwrap bind 同一 merged，upper 状态连续）。
5. **daemon 重启**：
   - disk 模式：启动 sweep 阶段对记录在册的 scratch 会话**重挂** overlay（同一 upper/work，实测可恢复），然后该会话才允许 reattach；重挂失败标记会话不可恢复（卡片提示），不清 upper（人工可查）。
   - tmpfs 模式：槽与 upper 随旧 namespace 消亡，会话标记为**不可恢复**：不 reattach、不假装新会话（避免 CLI resume 读到一半状态），卡片给"scratch 会话已随重启结束，开新会话"。
6. **正常结束/删除会话**：先确保容器进程不在 → lazy umount merged（沿用 v2 的 umount→fusermount→`-l` 三级）→ tmpfs 槽 umount → 删会话目录（disk 模式含 upper/work）。
7. **crash 兜底 + sweep**：复活 v2 的 `sweepOrphanSandboxes` 思路但更简单（单层 overlay）：daemon 启动时枚举 `/var/tmp/botmux-sbx/*` 与 dataDir 下带 overlay 挂载标记的会话目录，**/proc 活进程守卫**（挂载被活 pane 持有则跳过，v2 曾误删活会话，commit b88c16574），无主的挂载先 umount 再清目录；tmpfs 槽死亡后残留的空目录直接清。周期 reconciler 同策略对账。

## 6. outbox relay / 内部设施复用

- `botmux send` 中转、shim（`/run/sbxbin`）、`BOTMUX_SEND_RELAY`、`startOutboxWatcher`、seccomp nice 隔离判据（`linuxIsolationLaunch`，与挂载布局无关）、owner env 冻结注入、proxy env、trusted botmux 命令路径穿透 bind、MCP gateway socket 穿透 bind——**全部原样复用 v3**。
- outbox 走**真实宿主目录穿透 bind**（v3 现机制），daemon watcher 零改动；不改成"从 merged 里读"，避免 watcher 生命周期与挂载耦合。
- 唯一差异：v3 的根是 tmpfs + 白名单 bind；scratch 的根是 `--bind <merged> /`。v3 的 deny 编译（mode-000 空源 mask、usrmerge symlink 复制、嵌套 carve-out）在 scratch 仅用于 mandatory 集 + `scratchDenyPaths`，挂载顺序保持"merged 根 → 遮罩 → 内部穿透 bind（末位胜）"。

## 7. Dashboard / 文案

- bot 默认设置面板「文件沙盒」由 toggle 改为**三选一分段控件**：关闭 / oncall（分享给他人，现文案）/ scratch（一次性草稿环境）。
- scratch 副文案明确两句：① 改动默认**不保留**、不影响真实文件；② **不防恶意指令**——不要在不可信内容下开启，需要保密用 oncall。
- scratch 下 storage 二选一小控件（内存即焚 / 磁盘可跨重启续跑）与说明；Linux 以外平台该分段整体置灰并注"仅 Linux"。
- i18n 中英双语，沿用现有 sandbox.* key 前缀扩展。

## 8. 实现改动点（接线清单）

> 本节待两份代码考古完成后填全（v2 bridge redirect 调用点 + v3 接线面），初版：

- `src/adapters/backend/sandbox.ts`：新增 `prepareScratchSandbox(opts): ScratchSandboxSpawn | null`（与 DirectSandboxSpawn 同形：bin/args/env/outbox/cleanup + mergedHostPath）；复活并裁剪 v2 的 overlay primitives（mount/unmount/ensureDeps，去掉 landing）。
- `src/adapters/cli/fs-policy.ts`：scratch deny 编译复用现有 bwrap mask 发射；新增"仅 mandatory + 用户 deny"的极小 policy 构造。
- `src/worker.ts`：sandboxRequested 三态化；16225 调用处分流；CLI 数据路径读取接 §5.3 remap。
- `src/bot-registry.ts`：字段宽化 + 校验 + 迁移；`src/services/sandbox-migration.ts` 扩展。
- `src/core/types.ts`：Session 冻结字段。
- sweep/cleanup（daemon 启动 + reconciler）、dashboard 页面/API/i18n、docs（file-sandbox.md 增章）。
- macOS/riff 门控：`localSandboxApplies` 增加 scratch 专属判定。

## 9. 测试计划

- 单测：配置归一化/迁移/校验（三态、boolean 兼容、非法值、平台门控、互斥项）；bwrap argv 编译断言（根 bind 顺序、tmpfs 遮蔽、穿透 bind 末位、deny mask）；merged 路径 remap 纯函数（symlink canonicalize、ENOENT 不回退）；cleanup 三级 umount。
- 变异测试：新测试对旧 src 必须红（沿用仓库规矩）。
- 真机 e2e（本机）：
  1. 探针脚本扩展自 `scripts/sandbox-probe.mjs`：全根读写矩阵（/etc、/root、cwd、/tmp）、宿主零泄漏、upper 槽不可见、关盒清理。
  2. **真 codex 一轮**：冷启动 → 改项目文件 + 改 dotfile → 飞书收回复（验证 transcript/usage 桥接经 merged 读取）→ 结束后宿主核验零改动。
  3. **真 claude 一轮**：同上 + `botmux send` relay（含附件）+ hook 可用。
  4. disk 模式：挂载中 kill daemon → 重启 → 会话自动重挂可 resume；tmpfs 模式同样 kill → 会话标不可恢复、不裸跑。
  5. 非 root fuse-overlayfs 路径（本机 probeuser 已验证基础挂载，补 worker 全链路）。
  6. 后端矩阵：pty + tmux（zellij 时间允许）；adopt/suspend/resume。
- 回归：oncall/off 两模式全绿（对照 origin/master 基线），确认接线三态化没有改变现有模式行为。

## 10. 非目标 / 已知限制

- 不做 /land、不做改动导出（disk 模式 upper 留到会话删除为止；未来可加"导出 patch"，不进首版）。
- 不做网络隔离策略细化（仅 boolean share/unshare，同 oncall）。
- 不防内核级逃逸/恶意载荷；UI 与文档明示。
- macOS 不支持（Seatbelt 无 COW；不做 APFS snapshot 方案——快照是整盘级、无法 per-session 且写穿透真实 fs，语义不符）。
- tmpfs 容量受内存限制；大构建用 disk 或调大 size。
- disk upper 的 COW 历史里能看到会话期间写入的一切（含可能的 secret），目录权限 0700，删除即清。

## 11. 实现状态（2026-09-21 完成）

- `src/adapters/backend/scratch-sandbox.ts`：prepare/attach/teardown/sweep + 子挂载递归 overlay + cwd COW 探针 + remap 助手
- `src/adapters/cli/sandbox-mode.ts`：三态归一化（boolean 兼容、env fail-closed）
- `src/services/scratch-host-view.ts`：宿主侧 merged 视图映射
- worker 三态接线：oncall 旧路径零改动；scratch 分支独立 prepare；CODEX_HOME/TRAE_HOME worker 侧重指 merged、子进程强制原生路径；claude bridge 显式 remap；transcript-resolver 全部 CLI 分支按冻结 scratch 状态 remap
- 配置/冻结：bots.json 与 Session 保持 oncall=`true` 旧表示（零迁移），仅 scratch 为字符串；scratchStorage/scratchTmpfsSizeMb/scratchDenyPaths 随会话冻结
- workflow 快照链（contract/bot-resolve/sandbox-policy/zod payloads）透传 scratch
- Dashboard 三选分段控件 + 存储二选 + 中英 i18n + CSS；IPC 路由兼容旧 `{enabled}` 与新 `{mode}`
- daemon 启动/周期 sweep 接入 scratch 孤儿回收
- 验证：`scripts/scratch-sandbox-probe.mjs [--disk]`（tmpfs/disk 各 17 项）、`scripts/scratch-real-cli-probe.mjs [--codex]`（真 claude/codex 一轮，宿主零泄漏）、test/sandbox-mode.test.ts + test/scratch-sandbox-unit.test.ts（19 项）；全量 unit 对照 c351d3ecd 干净树零新增回归
