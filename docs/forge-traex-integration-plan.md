# Forge x TraeX 接入方案

## 1. 结论

**建议把 `Forge x TraeX` 做成 botmux 的一等启动形态：`cliId=traex` + 新增启动模式字段，而不是新增 `forge` 适配器，也不是复用普通 `wrapperCli`。**

这样可以继续复用现有 TraeX adapter 的输入协议、ready/busy 判断、sessionId 发现、transcript drain、模型参数、工作目录参数和 Botmux 注入环境；同时在 setup / Dashboard 里把 `Forge x TraeX` 放到和 `Aiden x Codex` 同级的一层选项里，创建 bot 后每次会话启动都走：

```bash
forge run --agent traex --agent-args "<traex adapter args>"
```

本方案的核心原则是：**不对现有 TraeX / Aiden / TTADK / wrapperCli 行为做回归性改动；Forge 模式不能支持的组合必须在配置阶段 fail closed，不能在运行时静默降级成普通 TraeX。**

## 2. 目标与边界

### 2.1 目标

1. setup 阶段支持选择 `Forge x TraeX`，展示为一级菜单项，不再增加“选择 TraeX 后再选 Forge”的二级交互。
2. 选择 `Forge x TraeX` 的 bot 后，新建会话、恢复会话、worker 重启都通过 `forge run --agent traex` 启动。
3. setup 保存前检查本机是否同时满足：
   - `traex` 可执行文件存在；
   - `forge` 可执行文件存在；
   - `forge doctor` 退出码为 0。
4. 保持 botmux 当前能力不降级，包括：
   - 飞书话题会话和群会话路由；
   - repo picker / defaultWorkingDir / worktree；
   - TraeX 模型、reasoning effort、backend variant、cwd 等参数；
   - Botmux `send` / `ask` / preview / MCP gateway 等环境注入；
   - session restore、restart、closed card、spawn command、local terminal；
   - TraeX transcript drain、submit confirmation、usage 统计；
   - sandbox / readIsolation 若无法确认兼容，配置阶段明确阻断。

### 2.2 非目标

1. 不新增 `forge` 这个 `CliId`。
2. 不在每个话题首次启动时再弹“TraeX / Forge Pipeline / Forge Pilot”模式卡。
3. 不自动把用户首轮提示词改写成 `$forge-pipeline` 或 `$forge-pilot`。
4. 不整体合入 `feat_support_forge` 分支。该分支里有大量与本需求无关的卡片、回复模式和命令改动；本方案只借鉴 `forge doctor` 检测和 `forge run --agent traex` 启动构造。

## 3. 当前代码事实

### 3.1 CLI 选择

当前 setup / Dashboard 的 Agent 选择由 `src/setup/cli-selection.ts` 统一生成：

- `resolveCliSelection(key)` 返回 `cliId + wrapperCli?`。
- `Aiden x Claude` / `Aiden x Codex` / `TTADK x Codex` 等通过 `wrapperCli` 表示。
- Dashboard 添加机器人使用扁平的 `CLI_SELECT_OPTIONS`，截图里的 `Aiden x Codex` 就是一级菜单项。
- 终端 TUI 使用 `CLI_SELECT_TREE`，部分 CLI 会进二级菜单。

### 3.2 启动依赖检测

当前 `src/setup/cli-availability.ts` 只检查一个“实际第一进程”：

- 普通 CLI 检查 adapter 对应 binary；
- `wrapperCli` 检查 wrapper 的首 token；
- `riff` / `mira` 这类 API backend 不要求本机 binary。

`Forge x TraeX` 不是单 binary 依赖，它至少需要 `forge` 和 `traex` 两个命令，并且 `forge doctor` 要通过。

### 3.3 Worker 启动

当前 worker 的启动流程是：

1. 通过 `traex` adapter `buildArgs()` 生成 TraeX 参数；
2. 如存在 `wrapperCli`，调用 `buildWrappedLaunch(wrapperCli, args)` 改写成 wrapper 启动；
3. 再叠加 sandbox / credential-only bwrap / backend 等外层包装；
4. 通过 backend spawn。

普通 `wrapperCli` 的语义是：

```text
<wrapperCli tokens> + <adapter args>
```

但 `forge run` 的真实契约是：

```bash
forge run [prompt] --agent traex --agent-args "<shell-like split args>"
```

所以不能把 `Forge x TraeX` 直接落成普通 `wrapperCli="forge run --agent traex"`，否则 TraeX args 的传递形态会错。

## 4. 推荐设计

### 4.1 数据模型

新增一个独立启动维度，建议命名为 `cliLaunchMode`：

```ts
export type CliLaunchMode = 'forge-traex';
```

落点：

```ts
interface BotConfig {
  cliId: CliId;
  wrapperCli?: string;
  cliLaunchMode?: CliLaunchMode;
}

interface Session {
  cliId?: CliId;
  wrapperCli?: string;
  cliLaunchMode?: CliLaunchMode;
}

interface SessionCliLaunchSnapshotV1 {
  cliId: CliId;
  wrapperCli: string | null;
  cliLaunchMode?: CliLaunchMode | null;
}

type DaemonToWorkerInit = {
  cliId: string;
  wrapperCli?: string;
  cliLaunchMode?: CliLaunchMode;
}
```

字段语义：

- `undefined`：普通启动，保持当前行为。
- `'forge-traex'`：只对 `cliId === 'traex'` 有效，worker 用 Forge 启动 TraeX。
- 不引入 `'plain'`，避免 bots.json 多写默认值。

配置合法性：

| 组合 | 处理 |
|---|---|
| `cliLaunchMode='forge-traex'` 且 `cliId='traex'` | 合法 |
| `cliLaunchMode='forge-traex'` 且 `cliId!='traex'` | load / save 阶段报错 |
| `cliLaunchMode` 与 `wrapperCli` 同时存在 | 报错 |
| `cliLaunchMode` 与 `cliRuntime` 同时存在 | 报错 |
| `cliLaunchMode` 与 `cliPathOverride` 同时存在 | 建议先报错，除非验证 Forge 能按 bot 维度指定 TraeX binary |
| `cliLaunchMode` 与 `sandbox/readIsolation` 同时存在 | 必须有兼容性验证；验证前应阻断保存，不能静默无隔离启动 |

### 4.2 CLI 选择项

在 `src/setup/cli-selection.ts` 新增一级选项：

```ts
const FORGE_X_TRAEX: CliSelectOption = {
  key: 'forge-x-traex',
  label: 'Forge x TraeX',
  cliId: 'traex',
  cliLaunchMode: 'forge-traex',
};
```

需要同步扩展：

- `CliSelectOption` 增加 `cliLaunchMode?: CliLaunchMode`；
- `ResolvedCliSelection` 增加 `cliLaunchMode?: CliLaunchMode`；
- `resolveCliSelection()` 返回该字段；
- `selectionKeyForBot(cliId, wrapperCli, cliLaunchMode)` 能反查 `forge-x-traex`；
- `CLI_SELECT_OPTIONS` 把 `Forge x TraeX` 放在 `TRAE CLI 2.0` 附近，作为一级项；
- `CLI_SELECT_TREE` 不把它放进二级菜单。终端 TUI 中也直接展示 `Forge x TraeX` leaf。

建议展示顺序：

```text
TRAE CLI 2.0
Forge x TraeX
TRAE CLI 1.0 / Coco
```

这满足“不要二级菜单”的要求，同时不影响 Aiden / TTADK / CJADK 现有选项。

### 4.3 setup / scripted setup / Dashboard 写盘

需要更新的入口：

| 入口 | 修改 |
|---|---|
| 交互式 `botmux setup` | 解析 `forge-x-traex` 后写 `cliId: 'traex', cliLaunchMode: 'forge-traex'` |
| `botmux setup edit` | 切回普通 CLI 时清掉旧 `cliLaunchMode` |
| scripted `setup add/edit --cli forge-x-traex` | 同上 |
| Dashboard 添加机器人 | 一级下拉显示 `Forge x TraeX`，并展示安装状态 |
| Dashboard Bot Defaults `/api/bot-agent` | 保存 `cliLaunchMode`，返回 `selectionKey='forge-x-traex'` |

`BotConfigEditInput` 建议新增三态字段：

```ts
cliLaunchMode?: CliLaunchMode | null;
```

语义：

- `undefined`：不改；
- `'forge-traex'`：设置；
- `null`：清空。

`applyBotConfigEdits()` 中要保证：

- 选择普通 CLI 时清空 `wrapperCli` 和 `cliLaunchMode`；
- 选择 wrapper 网关时设置 `wrapperCli`，清空 `cliLaunchMode`；
- 选择 `Forge x TraeX` 时设置 `cliLaunchMode`，清空 `wrapperCli`。

### 4.4 可用性检查

`checkCliAvailability()` 增加 `cliLaunchMode` 入参：

```ts
interface CliAvailabilityInput {
  cliId: CliId;
  cliPathOverride?: string;
  wrapperCli?: string;
  cliLaunchMode?: CliLaunchMode;
}
```

当 `cliLaunchMode === 'forge-traex'`：

1. 用现有逻辑检查 `traex` 是否可执行；
2. 检查 `forge` 是否可执行；
3. 执行 `forge doctor`：

```bash
forge doctor
```

判断规则：

- 退出码为 0：可用，doctor warnings 不阻断；
- 非 0 / timeout / spawn error：不可用；
- 输出只保留前几行关键错误，避免 setup 报错过长。

建议沿用 `feat_support_forge` 分支的缓存思路：

- `forge doctor` 默认 15s timeout；
- 结果缓存 60s；
- setup 保存时可 `force: true`，避免保存旧缓存。

`hasAgentLaunchConfigChanged()` 必须把 `cliLaunchMode` 纳入比较，否则从普通 TraeX 切到 Forge x TraeX 时不会触发依赖检查。

### 4.5 Worker 启动构造

新增一个纯函数，避免把 Forge 逻辑散在 worker 大函数里：

```ts
export function buildForgeTraexLaunch(
  traexArgs: readonly string[],
  resolveBin: (bin: string) => string,
): { bin: string; args: string[] } {
  const agentArgs = traexArgs.map(quoteForgeAgentArg).join(' ');
  return {
    bin: resolveBin('forge'),
    args: [
      'run',
      '--agent',
      'traex',
      ...(agentArgs ? ['--agent-args', agentArgs] : []),
    ],
  };
}
```

`quoteForgeAgentArg()` 必须按 shell-like split 规则转义，至少覆盖：

- 空字符串；
- 空格；
- 单引号；
- JSON 字符串参数；
- `-c key="value with spaces"` 这类 TraeX config 参数。

worker `spawnCli()` 中的形态：

```ts
const args = cliAdapter.buildArgs(...);

const forgeTraexLaunch =
  cfg.cliId === 'traex' && cfg.cliLaunchMode === 'forge-traex'
    ? buildForgeTraexLaunch(args, bin => locateOnEffectiveChildPath(bin, effectiveChildEnv) ?? bin)
    : undefined;

let spawnBin = forgeTraexLaunch?.bin ?? cliAdapter.resolvedBin;
let spawnArgs = forgeTraexLaunch?.args ?? args;
```

关键要求：

- `buildArgs()` 仍由 TraeX adapter 生成，保证现有 TraeX 参数不丢；
- `CLI_EXTRA_ARGS` 仍先并入 TraeX args，再进入 `--agent-args`；
- `wrapperCli` 与 `cliLaunchMode` 配置互斥，不需要运行时“忽略 wrapper”；
- spawn 日志、preflight、sandbox、spawn command 都读 `spawnBin/spawnArgs`，不能继续写死 `cliAdapter.resolvedBin/args`。

### 4.6 PID 与 sessionId 归属

这是不降级的关键点。

普通 TraeX 下，backend 的 child pid 通常就是 TraeX pid。Forge 模式下，backend 的 child pid 很可能是 `forge`，真正写 `~/.trae/cli/sessions/...` 的是它的 descendant `traex`。

如果不修这里，会影响：

- submit confirmation；
- `cliSessionId` 捕获；
- transcript bridge；
- usage drain；
- session restore。

方案：

1. 复用 `findLaunchedCliPid(launcherPid, 'traex')`；
2. 当 `cfg.cliLaunchMode === 'forge-traex'` 时，启动一个 bounded retry；
3. 找到 real TraeX pid 后：

```ts
backend.cliPid = realTraexPid;
backend.cliCwd = cfg.workingDir;
codexAdoptPendingPid = realTraexPid;
publishLocalProcessAttestation(realTraexPid);
```

4. 同步覆盖同步 pid 路径和 zellij 这类 late pid 路径。

注意：CLI PID marker 可以继续先写 forge pid，因为 in-agent `botmux send` 的祖先链通常能走到 forge；但 TraeX rollout 归属必须用 real TraeX pid。

### 4.7 不降级能力矩阵

| 能力 | 保持方式 | 需要验证 |
|---|---|---|
| TraeX ready/busy/idle | 继续使用 `traex` adapter pattern | Forge 首屏是否改变 prompt marker |
| 首轮和后续输入 | 仍通过 PTY 写入 TraeX composer | `forge run` 是否透传 stdin 到 TraeX |
| model / reasoning / backend variant | TraeX `buildArgs()` 原样进入 `--agent-args` | `forge run -x` shell-like split 是否还原一致 |
| `-C workingDir` | TraeX args 原样传入 | Forge 是否改变 cwd 语义 |
| Botmux env | child env 给 forge，forge 子进程继承 | Forge 是否清理环境 |
| tool shell env | TraeX `-c shell_environment_policy.set.*` 原样传入 | TraeX 在 Forge 下仍生效 |
| `botmux send/ask` | 依赖 env + botmux PATH 注入 | Forge 是否覆盖 PATH |
| `cliSessionId` 捕获 | real TraeX pid resolver | 必测 |
| transcript drain / usage | real TraeX pid + TraeX rollout path | 必测 |
| restore/restart | session 冻结 `cliLaunchMode` | 必测 |
| closed card resume | resume 命令改成 Forge 形态 | 必测 |
| local terminal | launch/resume 命令改成 Forge 形态 | 必测 |
| sandbox/readIsolation | 验证前 fail closed；验证后补 forge state paths / exec paths | 必测 |
| native subagent runtime | 不能静默禁用；需要验证 hook 合并 | 必测 |

### 4.8 Native subagent runtime 与 Forge hook 的处理

当前 TraeX native subagent runtime 通过 process-level TraeX config 注入：

```text
-c hooks.PreToolUse=[{ matcher="spawn_agent", hooks=[...] }]
```

Forge 也依赖 TraeX hook。这里不能直接照搬 `feat_support_forge` 里“Forge 模式禁用 nativeSubagentRuntimeHookCommand”的做法，因为那会静默降级 botmux 现有能力。

处理策略：

1. 先做验证：确认 TraeX 的 process-level `-c hooks.PreToolUse=...` 与 Forge 安装在 `~/.trae/cli/hooks.json` 的 hook 是合并还是覆盖。
2. 如果是合并：保留现有注入。
3. 如果是覆盖：必须实现合并 hook dispatcher，或者在保存 `Forge x TraeX` 时检测到 bot 配置了 `nativeSubagentRuntime` 就报错。
4. 无论哪种方式，都不能在 worker 里直接丢掉 native subagent runtime。

## 5. 需要修改的文件

| 模块 | 文件 | 改动 |
|---|---|---|
| 类型 | `src/types.ts` | `Session`、`SessionCliLaunchSnapshotV1`、`DaemonToWorker init` 增加 `cliLaunchMode` |
| Bot 配置 | `src/bot-registry.ts` | `BotConfig`、load/normalize、合法性校验、display 描述 |
| setup 选择 | `src/setup/cli-selection.ts` | 增加 `Forge x TraeX` 一级选项、解析和反查 |
| setup 编辑 | `src/setup/bot-config-editor.ts` | `BotConfigEditInput` 增加三态 `cliLaunchMode`，互斥校验 |
| scripted setup | `src/setup/setup-args.ts` | `--cli forge-x-traex` 写入 `cliLaunchMode` |
| 可用性检测 | `src/setup/cli-availability.ts` | 检查 `traex` + `forge doctor` |
| Forge helper | `src/core/forge-availability.ts` 或 `src/setup/forge-availability.ts` | doctor 检查、缓存、输出压缩 |
| 启动 helper | `src/core/forge-traex-launch.ts` | `buildForgeTraexLaunch()` 与 quoting |
| worker 启动 | `src/worker.ts` | Forge launch 改写、preflight、sandbox、pid resolve、spawn command |
| worker pool | `src/core/worker-pool.ts` | session freeze、init message、fork child session 继承 |
| restore / mismatch | `src/core/session-manager.ts` | `cliLaunchMode` 纳入 bot/session mismatch 判断 |
| closed card | `src/core/closed-session-card.ts` | Forge 模式 resume 命令 |
| local terminal | `src/core/local-terminal-opener.ts` | Forge 模式 launch/resume 命令 |
| Dashboard API | `src/core/dashboard-ipc-server.ts` | GET/PUT bot-agent 读写 `cliLaunchMode` |
| Dashboard payload | `src/dashboard/bot-payload.ts`、`src/dashboard/web/bot-defaults.ts` | 返回 `agentSelectionKey=forge-x-traex` |

## 6. 测试计划

### 6.1 单测

1. `test/cli-selection.test.ts`
   - `CLI_SELECT_OPTIONS` 包含 `forge-x-traex`；
   - `resolveCliSelection('forge-x-traex')` 返回 `{ cliId: 'traex', cliLaunchMode: 'forge-traex' }`；
   - `selectionKeyForBot('traex', undefined, 'forge-traex')` 返回 `forge-x-traex`；
   - `Forge x TraeX` 不落入二级菜单。

2. `test/setup-args.test.ts`
   - `setup add --cli forge-x-traex` 写入 `cliLaunchMode`；
   - 切回 `--cli traex` 清空 `cliLaunchMode`；
   - 与 `--wrapper-cli` 同时出现时按互斥规则处理。

3. `test/cli-availability.test.ts`
   - 缺 `traex` 报不可用；
   - 缺 `forge` 报不可用；
   - `forge doctor` 非 0 报不可用；
   - `forge doctor` exit 0 且有 warning 仍可用；
   - `hasAgentLaunchConfigChanged()` 能识别普通 TraeX 与 Forge x TraeX 的变化。

4. `test/forge-traex-launch.test.ts`
   - `buildForgeTraexLaunch()` 生成 `forge run --agent traex --agent-args ...`；
   - 覆盖空格、单引号、JSON、`-c` 参数 quoting；
   - 不丢 `--model`、`-C`、`model_reasoning_effort`、`model_backend_variant`。

5. `test/session-lifecycle-start.test.ts`
   - 新 session 冻结 `cliLaunchMode`；
   - `DaemonToWorker init` 携带 `cliLaunchMode`；
   - fork child session 继承 `cliLaunchMode`；
   - bot 热切普通 TraeX / Forge x TraeX 后旧 session 被判定 mismatch。

6. `test/reproduce-command.test.ts` / `test/local-terminal-opener.test.ts` / `test/closed-session-card.test.ts`
   - Forge 模式展示 `forge run --agent traex ...`；
   - 不再套 `wrapperCli`；
   - resume 命令符合 Forge 形态。

7. `test/find-launched-cli-pid.test.ts`
   - `forge -> traex` 进程树能找到 real TraeX pid；
   - late pid retry 不会写入旧 backend。

### 6.2 手工验证

1. 本机准备：

```bash
command -v traex
command -v forge
forge doctor
```

2. 构建：

```bash
bun run build
```

3. Dashboard 添加 bot：
   - 下拉一级列表出现 `Forge x TraeX`；
   - 安装状态正确显示；
   - 选择后写入 bots.json。

4. 会话启动：
   - daemon 日志出现 `forge run --agent traex`；
   - 首轮 prompt 正常进入 TraeX；
   - follow-up 正常；
   - `cliSessionId` 能捕获；
   - worker restart 后仍走 Forge；
   - daemon restart 后 restore 仍走 Forge。

5. 能力回归：
   - `/repo` / repo picker；
   - defaultWorkingDir；
   - worktree；
   - model / reasoning effort / backend variant；
   - `botmux send`；
   - `botmux ask`；
   - preview；
   - native title；
   - sandbox / readIsolation；
   - native subagent runtime。

## 7. 迁移与兼容性

### 7.1 现有配置

现有 bots.json 不含 `cliLaunchMode`，默认走普通 TraeX 或其它 CLI，行为不变。

### 7.2 回滚风险

旧版 botmux 不认识 `cliLaunchMode`，回滚到旧版本后可能把 `Forge x TraeX` bot 当普通 TraeX 启动。这是新增独立字段天然存在的回滚风险。

可选缓解：

- release note 明确说明：回滚旧版本前需要把 `forge-x-traex` bot 切回普通 `traex` 或停止；
- 如果必须 fail closed，可以引入配置版本或兼容哨兵，但旧版本不会读取新哨兵，无法完全靠代码补救。

### 7.3 不采纳的方案

| 方案 | 不采纳原因 |
|---|---|
| 新增 `cliId='forge'` | 会复制/绕开 TraeX adapter，大量 ready、busy、history、sessionId、usage 能力要重做，风险高 |
| 用普通 `wrapperCli='forge run --agent traex'` | `forge run` 需要 `--agent-args` 字符串，普通 wrapper argv 透传语义不匹配 |
| 话题启动时再弹 Forge 模式卡 | 增加用户启动路径，不符合“setup 选择后每次固定启动”的目标 |
| 静默禁用 native subagent / sandbox 等能力 | 违反“不降级当前能力”，应合并支持或配置阶段阻断 |

## 8. 分阶段落地

### Phase 1：最小可用且不静默降级

1. 增加 `cliLaunchMode` 数据模型和 setup 一级选项。
2. setup / Dashboard 保存前检查 `traex`、`forge`、`forge doctor`。
3. worker 用 `forge run --agent traex --agent-args ...` 启动。
4. real TraeX pid resolver 接入 submit/sessionId/transcript。
5. 对未验证组合 fail closed：`cliPathOverride`、`sandbox/readIsolation`、`nativeSubagentRuntime`。
6. 补齐单测和基础手工验证。

### Phase 2：补齐高级能力组合

1. 验证并支持 sandbox/readIsolation：
   - `execPaths` 包含 forge 和 traex；
   - policy 暴露 Forge 必需的 `~/.forge-runs` 子路径；
   - 不扩大已有 TraeX authPaths 写权限。
2. 验证并支持 native subagent runtime 与 Forge hook 共存。
3. 补 Dashboard 安装诊断细节，例如显示 `forge doctor` 的 compact reason。

### Phase 3：发布与回归

1. 用 `bun run build` 做基础编译验证。
2. 在 live daemon 上 `bun run switch:here && bun run daemon:restart`。
3. 飞书里用 `Forge x TraeX` bot 完成新话题、follow-up、restart、daemon restore 验证。
4. PR 描述中明确影响面：setup、Dashboard、worker spawn、TraeX transcript、session restore。

## 9. 关键验收标准

1. Dashboard 添加机器人下拉里，`Forge x TraeX` 是一级选项，和 `Aiden x Codex` 同级。
2. `botmux setup add --cli forge-x-traex ...` 能创建 bot，并写入 `cliId='traex'` + `cliLaunchMode='forge-traex'`。
3. `forge doctor` 不通过时，setup 不写入坏配置。
4. 该 bot 新建会话时日志和 spawn command 都显示 `forge run --agent traex`。
5. TraeX 首轮、follow-up、sessionId 捕获、回复转发和 usage 统计正常。
6. bot 从普通 TraeX 切到 Forge x TraeX 后，旧普通 TraeX session 不会被 lazy resume 成新模式；反向切换同理。
7. 任意暂不支持的组合都明确报错，不静默回退普通 TraeX，也不绕开隔离或 hook。
