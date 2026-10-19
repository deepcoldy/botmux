# Bot 与 Agent 分离配置

把今天平铺在 `bots.json` 单个条目里的配置拆成两类对象：

- **Bot** —— 飞书侧身份与接入行为：应用凭证、谁能用、在哪些群、怎么回复、卡片样式。一个 Bot 就是一个飞书应用。
- **Agent** —— 可复用的执行配置：用哪个 CLI、什么模型和推理强度、默认在哪个目录干活、是否沙箱、用什么终端后端、启动时跑哪些命令。

一个 Agent 可以被多个 Bot 共用；一个 Bot 最多关联一个 Agent。未关联的 Bot 叫「独立配置」，行为与今天完全一致。

## 为什么要拆

线上 55 个 Bot 里，所有 Bot 都配了 `cliId`，35 个配了 `defaultWorkingDir`，31 个配了 `workingDir`。按 `cliId + model` 分组后，同一组 Bot 往往只在飞书应用上不同：19 个 claude-code，9 个 codex。现在想给一组 Bot 换模型或换目录，只能逐个改，而且看不出哪些 Bot 实际上在跑同一套配置。

拆开以后：

- 改一次 Agent，所有关联 Bot 的新会话一起生效。
- 新建 Bot 时选一个现成的 Agent，不用重填 CLI、模型、目录。
- 在关联图里一眼看出「哪些飞书机器人背后是同一个 Agent」，以及哪些 Bot 的实际配置已经和 Agent 不一致。

## 参考与取舍

参考了一款 Agent 平台的配置页（左侧 Agent 列表，右侧按「执行 / 工作区 / 已连接的 Bot / 高级」分组的属性面板），也参考了代理配置页「左列配置、右列账号、贝塞尔曲线连接」的关联图。下面这些地方是有意不照搬的：

| 参考做法 | botmux 的做法 | 原因 |
|---|---|---|
| Agent 是运行实体，Bot 只是入口 | Agent 只是**配置模板**，运行实体仍是 Bot daemon | botmux 一个 Bot 对应一个 daemon 进程，会话、配额、授权都挂在 Bot 上，不能挪 |
| 改 Agent 后由平台统一调度 | 改 Agent 后**物化**到每个关联 Bot 的 `bots.json` 条目 | daemon loader 和运行时零改动；降级到旧版 botmux 仍可工作（与 `cliPathOverride` 的回滚安全原则一致） |
| 设备、凭证、可见性、并发数 | 不纳入 v1 | botmux 是单机多 daemon，凭证属于 Bot 的飞书应用或 CLI 自身登录态，混进 Agent 会把身份边界搞乱（见 CLAUDE.md「飞书 owner 身份边界」） |
| 关联图只读展示 | 关联图可**拖拽连线**完成关联，边上直接显示同步状态 | 配置关系和一致性在同一张图里看清、改完 |

## 字段划分（v1）

Agent 只收录 Dashboard 已经有逐字段写入接口、线上确实在用的字段。每组字段对应一个现有 daemon IPC，下发时原样复用其校验和热更新：

| Agent 分组 | 字段 | 下发接口（daemon IPC） |
|---|---|---|
| 执行 | `cliId`（选择键，含 wrapper 网关形态）、`model`、`reasoningEffort`、`configDir`（CLI 配置目录，见下节） | `PUT /api/bot-agent` |
| 工作区 | `workingDirMode`（`off` / `default` / `oncall`）、`workingDir`、`autoWorktree` | `PUT /api/bot-working-dir-mode` |
| 运行环境 | `sandboxMode`（`off` / `oncall` / `scratch`） | `PUT /api/bot-sandbox` |
| 运行环境 | `backendType`（空 = 跟随全局） | `PUT /api/bot-backend-type` |
| 启动 | `startupCommands` | `PUT /api/bot-startup-commands` |
| 零注入 | `promptInjection`（`default` / `none`） | `PUT /api/bot-prompt-injection` |

每组字段都可以**不设置**。未设置的分组不下发，Bot 保留自己的值。比如一个 Agent 只设置了「执行」，关联后只统一 CLI 和模型，工作目录仍由各 Bot 自己决定。

明确留给 Bot 的字段：飞书凭证、`allowedUsers` 等名单、群相关的回复与 @ 模式、卡片样式、按群覆盖（`groupDefaultModels` 等）、配额、授权、触发器。

下发顺序即上表顺序，零注入例外：daemon 只在零注入自己的写入接口上按 Bot **当前**的 CLI / 沙箱 / 后端校验，CLI / 沙箱 / 后端的写入接口（`/api/bot-agent`、`/api/bot-sandbox`、`/api/bot-backend-type`）不检查零注入。所以：

- 开启零注入排最后（先下发会按旧组合校验）；关闭排最前（零注入还开着时，切到不支持的组合会被下面的逐步校验拦下）。
- Agent 统一了 CLI 时，保存 Agent 就按该 CLI 提前拒绝不支持的组合（`promptInjection:unsupported`）。
- 后端一律按新会话 spawn 时的**生效值**判断：覆盖值，没有覆盖（或 Agent 清除了覆盖）时用 daemon 的默认后端（`BACKEND_TYPE` / 自动探测，daemon 在 Bot 配置快照里以 `defaultBackendType` 带给 Dashboard），再按 CLI 配对（远端 CLI 用同名后端；本地 CLI 落在远端后端上回落到 daemon 默认值，默认值也是远端时用 pty）。配对规则抽到无依赖的 `core/remote-cli-ids.ts`（`resolvePairedBackendId`），spawn 用的 `reconcileRiffBackendType` 委托过去；daemon 的零注入写入校验、运行时判断（`supportsZeroPromptInjectionForBot`，提示词构造与回复投递据此决定）、Bot 页开关、Agent 同步校验共用，口径与 spawn 时的强制校验一致。
- 同步会改到这几组时，浏览器先按**同步后的组合**（Agent 管的取 Agent，不管的取 Bot 当前值）整体判断，不成立就一组都不写、报 `zero_prompt_unsupported`。
- 整体成立后，每次写入这几组前再按**已成功写入的分组**判断中间组合：前面某组失败（例如关闭零注入没写成）时，后面的写入不会把 Bot 留在不支持的组合上。被拦下的分组推迟到其它分组之后再试（例如零注入开着时 claude-code + zmx → antigravity + tmux，先换后端再换 CLI），仍不成立才报失败。

暂不纳入 v1、后续可加的字段：

- `env`：值里常有密钥。Dashboard 只回显 key 不回显 value，偏差检测只能比 key，需要单独设计。
- `skills`、`cliRuntime`、dsh 专属字段、`nativeSubagentRuntime`：使用量小，且依赖 CLI 的条件分支多。

## CLI 配置目录（`cliConfigDir`）

需求来自一个本地 wrapper：用 `CLAUDE_CONFIG_DIR=~/.claude-api` 加一组 `ANTHROPIC_*` 启动 claude。原因是 `~/.claude/settings.json` 的 `env` 与顶层 `model` / `availableModels` 优先级高于进程环境变量，只换环境变量盖不住全局配置。

### 为什么不用 `cliPathOverride` 指向 wrapper，也不扩展 `cliRuntime`

- botmux 从 CLI 的数据根推导出一串路径：hook 安装位置（`<数据根>/settings.json`，约 14 个 hook）、transcript 与 pid 状态、`.claude.json` 目录信任、MCP 网关条目、手动续聊命令。wrapper 在 botmux 不知情的情况下换目录，这些路径都还指着 `~/.claude`，回合结束检测、权限卡片、上下文注入、回复兜底、用量统计会一起静默失效。
- 开文件沙盒时，wrapper 的 `exec env CLAUDE_CONFIG_DIR=…` 会覆盖沙盒重定向到 BOT_HOME 的设置，而 wrapper 指向的目录没有挂进沙盒。
- `cliRuntime` 描述的是「用哪个可执行文件」（路径、更新渠道、版本探测），换配置目录是同一个二进制换一套配置，两者正交，合并后无法表达「同一二进制、不同配置」。

### 做法

- `BotConfig.cliConfigDir`：绝对路径或 `~/` 开头，目前仅 `claude-code`。格式非法时 loader 直接拒绝；对不支持的 CLI 丢弃，和其它 CLI 专属字段一致。
- 适配器层复用 relay / seed 已有的「Claude 家族 + 自定义数据根」机制（`claudeConfigProfileVariant`）：数据根、`.claude.json`、hook 目标、MCP 网关、`CLAUDE_CONFIG_DIR`、续聊命令前缀全部跟着走，不逐处打补丁。hook / skills 的「每个 daemon 生命周期装一次」门控改为按 `(cli, 配置目录)` 计。
- 按会话冻结：`Session.cliConfigDir` 在首次 fork 时冻结（与 `cliId`、wrapper 同一套纪律）。改 Bot 配置只影响新会话；旧版本冻结过的会话不回填；`/cli` 临时切换的会话不继承 Bot 的配置目录。Session 以整行 JSON 存储，新增可选字段不需要迁移。
- 与文件沙盒兼容：沙盒仍把数据根重定向到 BOT_HOME 以保证隔离，但预置 BOT_HOME 时，env 的继承来源、登录凭证、`.claude.json` 都改为取自配置目录，而不是全局 `~/.claude`。这样无论是否开沙盒，Bot 用的都是这套配置，不会回落到全局账号。
- 修改配置目录不会关闭正在运行的会话（它们按冻结的目录继续运行）。这和切换 CLI 不同。
- Dashboard：Bot 配置页「Agent 配置」与 Agent 页「执行」分组都有「配置目录」字段，写入前校验目录存在。

## 存储

新增 `agents.json`，与当前生效的 `bots.json` 放在同一目录，权限 `0600`，写入时加跨进程文件锁并原子 rename（复用 `withFileLock`）：

```json
{
  "version": 1,
  "agents": [
    {
      "id": "ag_k3x9...",
      "name": "主仓库 Claude",
      "description": "可选说明",
      "exec": { "cliId": "claude-code", "model": "", "reasoningEffort": "" },
      "workspace": { "mode": "default", "workingDir": "~/iserver/botmux", "autoWorktree": false },
      "sandbox": { "mode": "off" },
      "backend": { "backendType": "" },
      "startup": { "startupCommands": "" },
      "createdAt": 1791999114525,
      "updatedAt": 1791999114525
    }
  ],
  "links": { "cli_a1b2c3": "ag_k3x9..." }
}
```

- 关联关系存在 `links`（`larkAppId → agentId`），**不写进 `bots.json`**。这样 `bots.json` 的 schema、loader、写入不变量和所有读它的进程（包括沙箱里的 CLI 子进程）都不受影响。
- `links` 指向的 Bot 已从 `bots.json` 删除时，读取时忽略，下一次写入时清理。
- 只有 Dashboard 进程读写 `agents.json`。

## 生效方式：物化下发

关联、编辑 Agent、手动同步这三种操作，都会把 Agent 已设置的分组逐个下发到目标 Bot：

```
Dashboard ──PUT /api/bots/:appId/agent──────────▶ Bot daemon ──▶ 校验 → 写 bots.json → 内存热更新
          ──PUT /api/bots/:appId/working-dir-mode▶ …
          ──…
```

- 用的是 Bot 设置页今天在用的同一批接口：CLI 可用性检查、目录存在性校验、沙箱冲突检查、后端可用性检查、`bots.json` 写入不变量全部复用，不新增第二条写入路径。
- **只下发有偏差的分组**。没变化的分组不发请求，避免无谓触发 daemon 侧的会话保护检查（`PUT /api/bot-agent` 在有受保护会话时会拒绝）。
- 每个分组独立下发、独立报告结果。一个 Bot 的某个分组失败（例如目录不存在）不影响其它分组和其它 Bot；失败的那条边会以「有偏差」留在关联图上，可稍后重试。
- 生效时机与在 Bot 设置页手动修改相同：下个新会话生效。**唯一例外是切换 CLI**：daemon 会关闭该 Bot 上使用旧 CLI 的活跃会话（`closeCliMismatchedSessionsForBot`，Bot 设置页改 CLI 也是如此）。因此关联弹窗和「保存并同步」在会切换 CLI 时都会先明确提示，下发结果里也会报告关闭了几个会话、有无残留。
- 下发由浏览器按 Bot 并发（上限 4）执行。中途关掉页面只会留下部分 Bot 未同步，表现为关联图上的偏差边，不会产生不一致的半写状态（每个分组的写入本身在 daemon 侧是原子的）。

## 一致性：边的三种状态

因为真实生效的配置在 `bots.json` 里，Agent 和 Bot 可能对不上：有人在 Bot 设置页手改、手改了 `bots.json`、下发时 Bot 离线、下发时校验失败。Dashboard 每次加载时用纯函数逐分组比较 Agent 与 Bot 当前值，给每条关联边一个状态：

| 状态 | 判定 | 关联图里的样子 | 操作 |
|---|---|---|---|
| 已同步 | 所有已设置分组都一致 | 实线 | — |
| 有偏差 | 至少一个分组不一致 | 琥珀色虚线，Bot 卡片标「N 项不一致」 | 「同步」= 重新下发 |
| 离线 | Bot daemon 不在线，读不到当前值 | 灰色虚线 | Bot 上线后自动复查 |

## 关联、解除与删除

- **关联**：如果 Bot 当前配置与 Agent 不同，先弹窗列出会变化的项（如「CLI：codex → claude-code」「默认目录：/a → /b」），确认后写入 `links` 并下发。配置完全一致时直接关联。Bot 已关联其它 Agent 时，同一弹窗里说明「将从 X 改关联到 Y」。
- **解除关联**：只删 `links`，不改 Bot 配置。因为配置早已物化在 Bot 上，解除后 Bot 行为不变，变回「独立配置」。
- **删除 Agent**：删除定义和它的全部 `links`；关联的 Bot 保留当前配置，变回独立配置。确认弹窗里写明影响几个 Bot。
- **从 Bot 生成 Agent**：读取某个 Bot 的当前值创建 Agent，并（默认）自动关联这个 Bot。生成时零差异，这是老用户迁移的主要入口。「执行」「工作区」两组总是带上；「沙盒」「后端」「启动命令」只在来源 Bot 有非默认值时带上，避免这个 Agent 以后关联到别的 Bot 时顺手把它们的这几项清掉。

## Dashboard 交互

新增导航项「Agent」（「数字员工」分组，路由 `#/agents`），页面标题右侧有两个视图切换和「+ 新建 Agent」。

### 关联图视图（默认）

```
 Agent                                   Bot
┌───────────────────────┐            ┌─────────────────────────┐
│ ◆ 主仓库 Claude    ●  │────────────│ 🤖 小助手-A              │
│ claude-code · default │╲           │ 已同步                   │
│ ~/iserver/botmux      │ ╲          └─────────────────────────┘
│ 关联 3 个 Bot         ○ ╲─ ─ ─ ─ ─ ┌─────────────────────────┐
└───────────────────────┘  ╲         │ 🤖 小助手-B   2 项不一致 │
                            ╲        └─────────────────────────┘
┌───────────────────────┐    ╲───────┌─────────────────────────┐
│ ◆ Codex 审查          ○  │         │ 🤖 小助手-C              │
│ codex · gpt-5.5 · high│           └─────────────────────────┘
│ 未关联                │            ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
└───────────────────────┘              🤖 独立 Bot   独立配置
                                     └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

- 左列 Agent，右列 Bot。Bot 按所属 Agent 分段排序，减少连线交叉；独立配置的 Bot 放在最后，用虚线边框区分。
- 连线是从 Agent 卡片右侧端口到 Bot 卡片左侧的三次贝塞尔曲线，颜色和线型表达上面的三种同步状态。
- 悬停 Agent 或 Bot：高亮相关连线和卡片，其它淡出。
- **拖拽关联**：从 Agent 卡片右侧的端口拖到任意 Bot 卡片上松手，弹出关联确认（预选该 Agent）。拖拽时有跟随鼠标的预览曲线，悬停的目标 Bot 高亮。
- **非拖拽路径**（键盘与触屏）：点击 Bot 卡片（或聚焦后回车）打开同一个弹窗。弹窗列出所有 Agent 和「独立配置」，选中后即时展示差异表，按钮随选择变为「关联并同步 N 项」「同步 N 项」「解除关联」或「无变化」。关联、改关联、同步、解除共用这一个入口。
- 点击 Agent 卡片进入配置视图并选中它。

### 配置视图

左侧 Agent 列表，每行显示名称、`CLI · 模型`、关联 Bot 数。右侧是选中 Agent 的编辑面板，分为：

1. **基本**：名称、说明。
2. **执行**：CLI、模型、推理强度。复用 Bot 设置页的 CLI 下拉和模型选择器（含实时模型探测）。
3. **工作区**：工作目录模式和目录。
4. **运行环境**：沙箱模式、终端后端。
5. **启动命令**。
6. **已连接的 Bot**：Bot 列表，每行显示同步状态，行尾可同步或解除。右上角「添加 Bot」打开多选弹窗，每个候选显示当前关联和选中后会改变几项（或「配置一致」「离线」）。弹窗汇总需要同步的数量，并提示哪些 Bot 会切换 CLI。确认后逐个写入关联，再把有偏差的在线 Bot 一次性同步。

每个分组带「不设置」开关，表示「这一组不归 Agent 管，由各 Bot 自己决定」。保存时如果有关联 Bot，按钮文案为「保存并同步到 N 个 Bot」，保存后逐个显示下发结果。

### 组件复用

Agent 编辑面板渲染在 `.bot-defaults-page` 样式作用域内，直接复用 Bot 配置页的组件：`BdTabGrid` 加 `bd-tile` 卡片网格、工作目录模式卡片（`WorkingDirModeFields`）、沙盒分段（`SandboxModeFields`）、后端下拉（`BackendTypeField`）、CLI / 模型 / 思考强度控件。这三个表单从 Bot 配置页抽成不负责保存的受控组件，Bot 配置页内部也改为使用它们，渲染结果不变。

Bot 配置页「整页吃满 main」的外壳布局原来用 `main:has(.bot-defaults-page)` 选中，现收窄为 `main:has(.page.bot-defaults-page)`，只认页面根，避免嵌入的作用域把 Agent 页整页切成双栏布局。

### UI 组件库评估

结论：不引入 StyleX；Base UI 值得引入，但只用于弹层类原语（Popover / Select / Menu / Tooltip），并单独提 PR，不放在本次改动里。

- **StyleX** 是样式方案（编译期原子化 CSS-in-JS），需要接入构建插件，并迁移约 3.5 万行 `style.css`。这次遇到的问题不在样式技术，而在「组件定位逻辑」与「页面级 CSS 覆盖」互相打架，StyleX 解决不了，投入产出比低。
- **Base UI** 是无样式的可访问组件原语，弹层由 Floating UI 负责定位（视口碰撞、翻转、portal），能和现有 design token 直接配合。「添加 Bot」弹层错位的根因是页面 CSS 改写了 `DropdownMenu` 弹层的 `left/right`，与组件自带的居中 `transform` 叠加。仓库里已经有 `dashboard-dropdown-viewport` 测试专门防这类回归，说明弹层定位是反复出问题的地方，换成 Floating UI 能从根上消除。
- 不在本次引入的原因：要改 `package.json` 和锁文件，按仓库约定不能在共享 `node_modules` 的 worktree 里安装依赖；另外替换 `DropdownMenu` 会影响所有页面的下拉，应该作为一次独立的、带全页截图回归的改动来做。

### Bot 设置页

已关联的 Bot 在 Bot 设置页顶部显示提示条：「执行配置由 Agent『X』统一管理。要修改可在 Agent 关联图解除关联。」并附「前往关联图」链接。

Agent 实际托管的分组在 Bot 设置页里会被锁定（`AgentManagedLock`），没托管的分组不受影响：

- 锁定的区块：「Agent 配置」里的 CLI / 模型 / 配置目录 / 思考强度及其保存按钮，「默认工作目录」的模式与目录，「文件沙盒」，「会话后端」，「启动命令」。
- 锁定方式：内容 `inert`（不可聚焦、不可点击）并置灰，区块顶部显示「🔒 由 Agent『X』统一管理」。点击锁定区域会弹出完整提示。
- 不归 Agent 管的设置仍可编辑，例如同一板块里的「技能注入」「自动开工」。

## 接口

全部挂在 Dashboard 进程，默认需要管理身份（与其它 `/api/*` 一样走全局鉴权闸），写操作再校验 `canManageHost`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agents` | `{ agents, links }` |
| POST | `/api/agents` | 新建。body 可带 `fromBot: larkAppId`，表示从该 Bot 当前值生成并自动关联 |
| PUT | `/api/agents/:id` | 更新定义，返回新定义。不负责下发 |
| DELETE | `/api/agents/:id` | 删除定义及其 links |
| PUT | `/api/agents/:id/links/:appId` | 写入关联（会覆盖原来的关联） |
| DELETE | `/api/agents/:id/links/:appId` | 解除关联 |

下发由浏览器调用现有的 `PUT /api/bots/:appId/<field>` 完成。服务端的 Agent 接口只管 `agents.json`，不做第二套 Bot 写入逻辑。浏览器端有一个纯函数把 Agent 分组翻译成接口请求列表，同样的函数也用于偏差检测，保证「比较什么」和「下发什么」只有一处定义。

## 影响面

- Agent 模板本身：只新增 `agents.json`（仅 Dashboard 读写）。关联与同步走已有的逐字段接口，行为与在 Bot 设置页手动修改相同。
- `cliConfigDir` 动到了运行时，影响面如下：
  - `bots.json` / `Session` 各新增一个可选字段。不配置时与之前完全一致：适配器默认值不变，`spawnEnv` 仍为空，hook 门控 key 退化为 `cliId`。
  - 只影响 claude-code。其它 CLI 读到该字段会丢弃；relay / seed 仍固定在各自的数据根。
  - 会话类型：话题、群聊、恢复会话按冻结值启动；`/cli` 临时切换与 adopt 会话不使用 Bot 的配置目录。
  - 后端：PTY、tmux 都经由 `spawnEnv` 注入。`CLAUDE_CONFIG_DIR` 原本就在 tmux 透传白名单内（seed 已在用）。
  - 沙盒：开与关两种情况都覆盖。沙盒开启时仍重定向到 BOT_HOME，只是预置来源换成了配置目录。
- Dashboard：新增 Agent 页与 `/api/agents*` 路由；Bot 设置页增加「配置目录」字段、Agent 提示条和 `#/bot-defaults?bot=<appId>` 深链；Bot 设置页的工作目录、沙盒、后端三个表单抽成受控组件，渲染不变。

## 后续

- `env`（只比较 key、按 key 合并下发）、`skills`、`cliRuntime`。
- 新建 Bot 的 onboarding 流程里直接选择 Agent。
- 「归并建议」：发现多个配置完全相同的独立 Bot 时，提示一键生成 Agent 并关联。
- 从 IM 命令（如 `/config`、`/botconfig`）修改已关联 Bot 的托管字段时给出同样提示（目前只有 Dashboard 锁定，IM 侧改动会在关联图里显示为偏差）。
