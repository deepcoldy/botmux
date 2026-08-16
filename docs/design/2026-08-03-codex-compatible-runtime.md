---
title: Codex-compatible Runtime 支持 - Spec 与单 PR 实施计划
type: feat
date: 2026-08-03
topic: codex-compatible-runtime
status: implemented
---

# Codex-compatible Runtime 支持

## 1. 背景与问题

Botmux 已能通过 `cliId: "codex"` + `cliPathOverride` 启动一个兼容 Codex
参数和状态布局的第三方二进制。这解决了“能否启动”，但没有表达“实际运行的是哪个
发行版”。当前多条链路仍只看 `cliId`：

- adapter、展示名、版本缓存和更新卡片都把进程视为官方 Codex；
- 结构化 doctor 不可用时，更新检查会回退官方 Codex 的发布源；
- RPC 因存在 `cliPathOverride` 被整体禁用；
- `/adopt` 只认识静态进程名，无法发现新的兼容二进制；
- 本地 resume 命令由 adapter 写死为 `codex resume ...`；
- session 只冻结 `cliId`、path、wrapper、model，没有冻结发行版身份。

已观察到的通用故障形态是：一个版本流独立的 Codex-compatible fork 被拿来与官方
Codex 版本比较，并收到不属于它的升级建议。本文不记录机器名、用户目录、bot 身份或
私有包信息；测试使用仓库内 fake runtime。

## 2. 核心决策

1. `cliId` 表示行为协议/adapter；`cliRuntime` 表示实际发行版。
2. 发行版来源不确定时，只展示当前版本，不比较 latest、不通知更新。
3. runtime 配置只能声明能力意图；高风险能力仍需只读探针和既有安全门共同放行。
4. runtime 身份随 session 冻结；bot 热切 runtime 不能用新二进制恢复旧会话。
5. 本迭代以一个 PR 完成配置、会话、更新、RPC、adopt、resume、setup/dashboard 闭环，
   但按依赖关系拆成可独立审阅的 commits。

## 3. 目标

- 新增一个 Codex-compatible fork 时只需配置，不新增 `CliId`、adapter 或 display map。
- 官方 Codex 在无新配置时保持现有行为。
- 显式 custom runtime 有独立名称、可执行文件、版本和 update provider。
- update、status、日志、session/card、dashboard 使用同一份 runtime identity。
- RPC、adopt、resume 对声明且验证通过的 compatible runtime 可用。
- 旧 `bots.json`、旧 session 和旧 update store 能安全读取并确定性迁移。
- 非 Codex CLI、wrapper、各 backend 的既有逻辑不受影响。

## 4. 非目标

- 不允许仅靠配置把一个改变了参数、TUI、输入确认或 resume 语义的 CLI 伪装成 Codex。
- 不支持改变 rollout/history/auth 数据格式的 fork；此类变化需要新 adapter 或未来的
  state provider。
- 不自动安装或升级任何 CLI，也不执行 doctor 返回的更新命令。
- 不从二进制名称猜品牌、包名或“官方身份”。
- 首版不支持显式 `cliRuntime` 与 `wrapperCli` 叠加；launcher 可能替换真实二进制，
  无法可靠证明 runtime identity。现有 wrapper 配置继续工作。

## 5. 四层边界

| 层 | 负责 | 不负责 |
|---|---|---|
| Adapter | args、输入提交、TUI/bridge、resume 结构、Codex state 协议 | 产品名、发行版本、安装来源 |
| Runtime | 稳定 id、展示名、实际 executable | latest 查询和升级命令 |
| Release provider | 当前/最新版本来源、来源标识、可选人工更新提示 | 启动进程、执行升级 |
| State profile | rollout/history/auth/subscription 的布局与解析 | 产品品牌和 update channel |

本 PR 只新增 `codex` runtime profile。其 `stateProfile` 固定为内部值 `codex`，沿用
`CODEX_HOME` 和现有 transcript 服务；不开放任意 state parser 配置。若 fork 改了状态
协议，它不属于“Codex-compatible runtime”。

## 6. 配置 Schema

建议在 `BotConfig` 新增：

```ts
interface CliRuntimeConfig {
  id: string;
  displayName?: string;
  executable: string;
  update?:
    | { provider: 'auto' }
    | { provider: 'self' }
    | { provider: 'npm'; packageName: string }
    | { provider: 'none' };
}

interface BotConfig {
  cliId: CliId;
  cliRuntime?: CliRuntimeConfig;
}
```

示例仅使用虚构发行版：

```json
{
  "cliId": "codex",
  "cliPathOverride": "acme-codex",
  "cliRuntime": {
    "id": "acme-codex",
    "displayName": "Acme Codex",
    "executable": "acme-codex",
    "update": {
      "provider": "npm",
      "packageName": "@acme/codex"
    }
  }
}
```

约束：

- 本 PR 仅允许 `cliId === 'codex'` 使用 `cliRuntime`；否则配置校验失败。
- `id` 使用稳定的 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` 格式。
- `executable` 是一个 bare command name 或绝对路径，不接受依赖 cwd 的相对路径，也不按
  argv 拆分。PATH 探测通过固定 shell script + 独立位置参数完成，绝不把配置值插入
  shell source；绝对路径本身可含空格，但不能包含 NUL 或换行。
- `displayName` 限定长度并去控制字符；缺省取稳定 `id`。
- 内置 `codex` id 与 executable basename 为官方 runtime 保留；自定义发行版必须使用
  可区分的稳定 id 和命令名，避免 RPC/adopt 仅凭进程名误认官方进程。
- `update` 缺省为 `{ provider: 'auto' }`。
- `cliRuntime` 是新版本的唯一 canonical source。为支持回滚到不认识该字段的旧版 BotMux，
  配置写入端原子双写一个与 `cliRuntime.executable` 完全相等的 `cliPathOverride` 降级影子；
  loader 只接受字段齐全且完全相等的组合；缺失影子或任何不一致都明确失败，不静默选边。
- `cliRuntime` 与 `wrapperCli` 同时出现暂时报错；不影响没有 `cliRuntime` 的旧 wrapper。

## 7. 统一解析模型

所有调用方先通过一个纯 resolver 得到：

```ts
interface ResolvedCliRuntime {
  id: string;
  displayName: string;
  executable: string;
  source: 'official' | 'configured' | 'legacy-path';
  update: ResolvedUpdateConfig;
}
```

adapter factory 仍按 `cliId` 创建 Codex adapter，但 `resolvedBin`、展示、版本 key、
RPC pane ownership 和 resume executable 都从 descriptor 取。禁止各模块重新从
`cliId + cliPathOverride` 各自推导身份。

## 8. 向后兼容策略

### 8.1 官方 Codex

`cliId: "codex"` 且没有 `cliRuntime`/`cliPathOverride` 时解析为内置
`codex`：名称 Codex、executable `codex`、state profile `codex`、update provider
`internal`（内部类型，固定官方发布源）。启动参数、RPC 默认和更新体验
保持不变。

结构化 runtime 的 setup、Dashboard 等写入端同时保存完全相等的 legacy path 影子。新版本
始终按 `cliRuntime` 解析身份、展示和能力，旧版本降级后仍会通过 `cliPathOverride` 启动同一
发行版，而不是静默退回官方 Codex。清除或切换 runtime 时两个字段也必须原子同步。

### 8.2 Legacy `cliPathOverride`

旧配置不要求迁移且 spawn 行为不变。内部用 executable basename 派生 legacy runtime
id/displayName（不写回 `bots.json`）。legacy runtime 仍因缺少结构化兼容声明而禁用 RPC；
resume/本地终端继续使用原 path。唯一有意修正：非默认 executable 不再回退官方
latest；来源未知时不比较、不通知。setup/dashboard 提供显式迁移入口，用户保存
`cliRuntime` 后才获得稳定、可编辑的发行版身份和完整能力。

### 8.3 Unknown binary

显式 runtime 可使用 `update:auto`。保守探测顺序为：

1. 读取 `--version`；
2. 从 executable 的 realpath 向上查找其真实拥有者 `package.json/bin`；
3. 只有唯一匹配的 npm package 才查询该 package 的 latest；
4. `auto` 只把该归属用于选择版本流，不据此猜测实际安装器，也不合成
   `npm`/`pnpm`/`yarn` 更新命令；
5. 无法确认来源则状态为 `current-only`，绝不回退官方 Codex。

`doctor --json` 只用于内置 `internal` 或用户显式选择的 `self` provider，并且 doctor
报告的 current 必须与 executable 的 `--version` 一致。这样一个沿用上游 Codex doctor
实现的 fork 不会在默认 `auto` 下重新引入官方版本流。

### 8.4 Legacy sessions

- `agentFrozen !== true`：第一次 fork 按现有规则从 live bot 回填 runtime snapshot。
- 已冻结且只有 `cliPathOverride`：从 session 自身字段派生 legacy identity，不能继承
  bot 新增的 runtime。
- 已冻结且无 path 的官方 Codex session：补为内置 official identity，不改变启动。
- bot 的 `adapterId + runtimeSource + runtimeId + wrapper` 与 session 不同，沿用现有 mismatch teardown
  语义关闭/隔离旧会话，不能跨发行版冷恢复。

### 8.5 Update store

新 store entry 带 `runtimeId`、`displayName`、provider/package source fingerprint、managed 状态和 executable。
旧官方 entry 可兼容读取；custom runtime 使用不同 key，audit 会裁剪不再配置的旧 key，
成功但无法确认来源的探针会清空 stale latest。这样不会把历史上的官方 latest 继承给
custom runtime。provider 或 packageName 改变会绕过 TTL 立即重探，失败也不能继承旧
source 的 latest、command、install target 或通知水位。
Dashboard 在读取持久化状态时还会按当前 runtime、executable 与 provider/package fingerprint
即时过滤；即使后台 audit 尚未跑到下一轮，切换更新源后也不会短暂展示旧 badge。

## 9. 安全与 fail-closed

- 全部探针使用 `execFile` argv，不经过 shell；每步有 timeout、输出上限和并发去重。
- doctor、package metadata 和生成的 `updateCommand` 仅作为展示数据，永不执行。
- `npm.packageName` 必须通过 npm package-name 校验；registry URL 由代码构造。
- doctor 的 current/latest 必须能解析；无法解析时只保留 executable `--version` 的
  current。
- update provider 失败不能沿用另一个 provider 的 latest/update command。
- 只有结构化 runtime 才构成“用户明确声明该二进制满足 Codex adapter contract”；RPC
  仍必须通过 backend、sandbox、approval、startup command 等全部既有安全门。
- adopt 的 discovery 与 click-confirm 使用配置 executable 的 exact basename matcher，
  不允许一个 custom bot 广泛认领任意未知进程。
- 冲突 schema 或非法 runtime 字段在 scripted setup / Dashboard save 时明确失败；
  Dashboard 还会拒绝缺失或无法输出版本的 executable。脚本化 setup 保留“先写配置、
  后安装二进制”的既有能力；运行期 stale executable 只影响对应 bot，不阻断其它 bot
  启动和更新检查。

## 10. 关键链路设计

### 10.1 Session 与展示

在持久化 `Session` 中冻结规范化 runtime snapshot（id、displayName、executable、source、
update policy），并扩展 `agentFrozen` 语义。latest 不进 session；`cliVersion` 是该 session
实际 runtime 的当前版本。

新增统一 `runtimeDisplayName()`/`runtimeKey()`，接入 worker 日志、status、流式卡片、
关闭卡、sessions/dashboard rows 和更新卡。只有 `source: configured` 使用 runtime
displayName；official、legacy 与其它 CLI 的既有文案保持原样。

版本 cache 从 `cliId` 改为 `runtimeKey`，禁止 custom 与 official 相互覆盖。status 只有在
同一 runtime identity 下才显示 current → latest。

### 10.2 Update provider

将 `cli-runtime-update` 拆成 provider + audit：

- `internal`：保留官方 registry fallback；仅内置 runtime 可使用。
- `self`：只接受 runtime 自身结构化 doctor 结果，无 registry fallback。
- `npm`：查询显式 package；命令缺省时可不展示，不能伪造包管理器。
- `auto`：只接受唯一 npm provenance；可查询对应 package 的 latest，但不推断安装器或
  合成更新命令；未知即 current-only。
- `none`：不进入定时 update audit；运行时 `--version` 状态能力不受影响。

entry key 包含 runtimeId 和 resolved executable；卡片使用 runtime displayName，可选展示
source/install target/update command。

### 10.3 RPC

worker init 接收 runtime snapshot。移除“任何 path override 都禁用”这一粗粒度门，改为：
内置 official 保持现状；显式 runtime 代表用户对严格 Codex contract 的声明，再经过
tmux、sandbox、read isolation、approval、startup command 等现有门。legacy path 仍禁用。

app-server 和 viewer 必须使用同一 runtime executable。pane ownership 检测使用该
executable 的 exact basename + `--remote` argv；任何不确定都回退 paste。

### 10.4 Adopt

把静态 `CLI_COMM_MAP` 过滤扩展为“adapter matcher + runtime executable basename”。Codex custom
bot 只看到匹配自身 runtime 的 pane；official bot 不得看到 custom pane。tmux、zellij、
herdr 的 discovery 与 confirm 都携带 runtime matcher，transcript 仍走 codex state profile。

### 10.5 Resume

adapter 继续决定 `resume <threadId>` 的结构；runtime 层负责安全替换首个 executable。
关闭卡必须使用 session snapshot，而不是当前 bot config。显式 custom runtime 与 legacy
path session 都输出其冻结 executable；wrapper 仍走既有 decorator。

### 10.6 Setup 与 Dashboard

Dashboard 的 Codex 选择项下增加“Official Codex / Codex-compatible custom runtime”，并
把旧 `cliPathOverride` 显示为单独的 legacy 迁移态。只改模型等其它字段时不触碰 runtime；
只有显式选择 Official 或 Custom 才清除/迁移 legacy path。
custom 表单编辑上述 schema，并在保存前执行只读 preflight：executable 与 `--version`；
更新 monitor 再按 provider / provenance 给出“可管理/未托管”状态。脚本化 setup 同时
提供 `--cli-runtime <JSON|->` 稳定接口。

preflight 不发模型请求、不创建会话、不执行更新。Dashboard Bot Defaults 与 setup 共用
同一 schema validator；Dashboard PUT 额外返回规范化 runtime 和只读版本探针结果。
UI 改动在 PR 中附截图。

## 11. 影响范围

- 跨 CLI：resolver 入口是通用模型，但本 PR 只开放 Codex；至少跑一个非 Codex adapter
  回归，确保 adapter registry 和 availability 未漂移。
- 跨平台：executable realpath、process comm 和 package provenance 覆盖 Linux/macOS；
  不依赖 shell-only 命令。
- 跨 backend：spawn/resume 覆盖 tmux/pty；RPC 仍限 tmux；adopt 覆盖 tmux/zellij/herdr。
- 跨会话：新会话、冷恢复、daemon restore、idle suspend、热切 runtime、adopt/import。
- 配置面：CLI setup、dashboard PUT、`bots.json` normalize、session store、update cache。

## 12. 测试矩阵

| 场景 | 关键断言 |
|---|---|
| 官方 Codex 无新字段 | spawn/display/update/RPC 与基线一致 |
| legacy default `cliPathOverride` | spawn 不变；无官方 fallback；RPC 仍关闭 |
| 显式 npm custom | 独立 display/key/latest/command；不污染 official |
| 显式 self custom | 只信同源完整 doctor 结果；异常输出降级 current-only |
| auto 可定位唯一 npm owner | 查询真实 package，不查询官方 package，不合成包管理器命令 |
| auto unknown binary | 有 current、无 latest、无提醒、无假命令 |
| update none | 不访问 registry、不通知 |
| official/custom 同时配置 | 两份 cache、dashboard row 和通知水位独立 |
| update store v1 | 污染 entry 被丢弃并重新探测 |
| 结构化 runtime + RPC 开关 | tmux RPC 可用，app-server/viewer 同 executable |
| legacy path + RPC 开关 | 安全退回 paste |
| RPC 既有安全门 | sandbox/read isolation/approval/startup command 继续阻断 |
| custom adopt | exact alias 可发现并确认；official/custom 互不可见 |
| 其它 custom process | exact basename filter 不会误接管 |
| custom close/resume | 卡片使用 frozen executable 与 displayName |
| runtime 热切 | 旧 session mismatch 关闭，不用新 runtime 恢复 |
| Dashboard legacy path | 只改模型时保留；显式 Official 才清除；显式 Custom 才迁移 |
| legacy frozen session | 不继承新 runtime；official legacy 可恢复 |
| wrapper legacy | 选择、spawn、resume decorator 均保持原行为 |
| 非 Codex CLI | Claude/OpenCode 至少各一条 adapter/version/session 回归 |
| 平台/backend | Linux/macOS resolver；tmux/pty spawn；三类 adopt discovery |
| setup/dashboard | schema round-trip、冲突 400、diagnostics、i18n、bundle |

测试实现使用临时目录中的 fake executables/package.json 和依赖注入的 `execFile`/fetch；
不得依赖真实第三方包、真实 home 或网络。先跑定向测试，再跑：

```bash
pnpm test
pnpm build
git diff --check
```

需要手动验证 UI/真实 TUI 时，按仓库规范从本 checkout build + claim + restart；记录实际
命令和结果，不把机器信息写进 PR。

## 13. 单 PR 多 Commit 计划

1. `docs(design): 定义 Codex-compatible runtime 方案`
   - 本 spec；锁定 schema、不变量、迁移和验收。
2. `feat(runtime): 引入 CLI runtime 描述与会话快照`
   - config normalize/validator、resolver、adapter executable 注入、session freeze/mismatch；
   - resolver、legacy session、非 Codex 回归测试。
3. `fix(update): 按发行版隔离 CLI 版本与更新来源`
   - provider、runtime-key cache、card/dashboard 展示；
   - internal/self/npm/auto/none 与污染 store 测试。
4. `feat(codex): 接通 compatible runtime 的 RPC adopt 与 resume`
   - worker IPC、process matcher、session-snapshot resume；
   - RPC 安全门和 tmux/zellij/herdr discovery 测试。
5. `feat(setup): 增加 compatible runtime 配置与预检`
   - setup/dashboard 共用表单、API 校验、diagnostics、i18n、截图；
   - round-trip/API/bundle 测试与最终全量回归。

每个 commit 都必须能编译、其定向测试通过；后续 commit 不靠临时兼容分支修复前一
commit 的红灯。最终 rebase 最新 `origin/master` 后重跑全量门禁。

## 14. 验收标准

- 新增一个严格 Codex-compatible fake runtime 无需新增 adapter/`CliId`/静态展示映射。
- custom runtime 的名称、current/latest、update source、resume executable 全程一致。
- unknown runtime 永远不会拿官方 Codex latest 做比较或发提醒。
- official Codex 的配置、启动、RPC、更新和 UI 基线保持不变。
- legacy `cliPathOverride` 无需迁移即可启动，且停止错误的官方更新 fallback。
- runtime 热切、daemon restart、cold resume 都不会跨 runtime 恢复 session。
- RPC/adopt 只有在结构化兼容声明与既有安全门同时满足时启用，失败安全降级。
- 非 Codex CLI、legacy wrapper、tmux/pty 和现有 session 恢复测试通过。
- `pnpm test`、`pnpm build`、`git diff --check` 通过；UI 改动附可审阅截图。
- PR 描述用中文说明改动、原因、兼容策略、影响面和实际验证结果。
