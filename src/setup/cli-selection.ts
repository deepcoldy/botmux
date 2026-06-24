/**
 * cli-selection.ts
 *
 * 单一事实源：把「用户可选的 CLI 形态」从「原始 cliId 列表」抽象成一层
 * **可级联的选择项**。除了原生 CLI，额外提供若干网关形态：
 *   - Aiden × Claude → 底层 cliId=claude-code，启动前缀 `aiden x claude`
 *   - Aiden × Codex  → 底层 cliId=codex，启动前缀 `aiden x codex`
 *   - CJADK × Claude → 底层 cliId=claude-code，启动前缀 `cjadk claude`
 *   - CJADK × Codex  → 底层 cliId=codex，启动前缀 `cjadk codex`
 *
 * 这些形态**不生成任何 wrapper 脚本**：通过 bot 配置的 `wrapperCli`（通用启动前缀）
 * 实现——worker 在 spawn 时把启动命令拼成 `<wrapperCli> <CLI 参数>`（纯 argv，跨系统）。
 * `wrapperCli` 是通用机制（也能承载 ccr / claude-w 等），不止 aiden / cjadk。见 worker.ts 的
 * wrapperCli 处理与 {@link buildWrappedLaunch} / {@link stripSettingsArgs}。
 *
 * aiden 与 cjadk 的差异：`aiden x claude` 不收 `--settings`（要剥掉），而 cjadk
 * （`allowUnknownOption`）把全部 passthrough 参数原样转发给真正的 claude/codex，
 * `--settings`（承载 bypass 键）必须保留，故不走剥离分支。
 *
 * 三处入口（终端 setup / 终端 bot 编辑 / dashboard 网页添加机器人）共用本模块：
 *   - 展示：`CLI_SELECT_OPTIONS`（扁平，web 下拉 + 非 TTY 回退）/ `CLI_SELECT_TREE`（级联，终端 TUI）
 *   - 解析：`resolveCliSelection(key)` → `{ cliId, wrapperCli? }`（纯映射，无副作用）
 */
import { CLI_OPTIONS } from './bot-config-editor.js';
import type { CliId } from '../adapters/cli/types.js';

/** 一个用户可选项；wrapperCli 不为空时表示它以该前缀启动（如 `aiden x claude`）。 */
export interface CliSelectOption {
  /** 唯一选择键：合法 CliId，或 'aiden-x-claude' / 'aiden-x-codex'。 */
  readonly key: string;
  /** 展示名。 */
  readonly label: string;
  /** 底层适配器 cliId。 */
  readonly cliId: CliId;
  /** 通用启动前缀，如 'aiden x claude'；普通 CLI 无此项。 */
  readonly wrapperCli?: string;
}

/** 级联树节点：顶层 CLI；children 非空表示选中后进二级菜单（目前只有 Aiden）。 */
export interface CliSelectGroup {
  readonly key: string;
  readonly label: string;
  /** 叶子项：直接可选；children：进二级菜单。两者必居其一。 */
  readonly option?: CliSelectOption;
  readonly children?: ReadonlyArray<CliSelectOption>;
}

/** 解析结果：落进 bot 配置的 cliId（+ 可选 wrapperCli）。 */
export interface ResolvedCliSelection {
  readonly cliId: CliId;
  readonly wrapperCli?: string;
}

// ─── aiden 选项 ──────────────────────────────────────────────────────────────

const AIDEN_NATIVE: CliSelectOption = { key: 'aiden', label: 'Aiden（原生 agent）', cliId: 'aiden' };
const AIDEN_X_CLAUDE: CliSelectOption = { key: 'aiden-x-claude', label: 'Aiden × Claude', cliId: 'claude-code', wrapperCli: 'aiden x claude' };
const AIDEN_X_CODEX: CliSelectOption = { key: 'aiden-x-codex', label: 'Aiden × Codex', cliId: 'codex', wrapperCli: 'aiden x codex' };

const AIDEN_VARIANTS: ReadonlyArray<CliSelectOption> = [AIDEN_NATIVE, AIDEN_X_CLAUDE, AIDEN_X_CODEX];

// ─── Mira 选项 ───────────────────────────────────────────────────────────────
// Mira 有两种形态（都是原生 cliId，无 wrapperCli），合并成一个「Mira」二级菜单：
//   - Mira App  → cliId `mira`：直连 Mira Web API（云端编排 + 远程沙盒，聊天/搜索）
//   - Mir CLI   → cliId `mir` ：本地 `mircli -p --lean`（在用户机器上执行、操作工作区）
const MIRA_APP: CliSelectOption = { key: 'mira', label: 'Mira App（Web API）', cliId: 'mira' };
const MIRA_CLI: CliSelectOption = { key: 'mir', label: 'Mir CLI（本地 mircli）', cliId: 'mir' };

const MIRA_VARIANTS: ReadonlyArray<CliSelectOption> = [MIRA_APP, MIRA_CLI];

// ─── Codex 选项 ──────────────────────────────────────────────────────────────
// 两种形态合并成一个「Codex」二级菜单（都是原生 cliId，无 wrapperCli）：
//   - Codex     → cliId `codex`     ：标准 codex CLI
//   - Codex App → cliId `codex-app` ：Codex 桌面 app 的 app-server runner
const CODEX_NATIVE: CliSelectOption = { key: 'codex', label: 'Codex', cliId: 'codex' };
const CODEX_APP: CliSelectOption = { key: 'codex-app', label: 'Codex App', cliId: 'codex-app' };
const CODEX_VARIANTS: ReadonlyArray<CliSelectOption> = [CODEX_NATIVE, CODEX_APP];

// ─── TRAE 选项 ───────────────────────────────────────────────────────────────
// TRAE 家族合并成一个「TRAE (CoCo)」二级菜单（都是原生 cliId，无 wrapperCli）：
//   - TRAE CLI (CoCo) → cliId `coco`  ：Trae CLI 的 CoCo 形态
//   - traex           → cliId `traex` ：TRAE CLI（traecli）
const TRAE_COCO: CliSelectOption = { key: 'coco', label: 'TRAE CLI（CoCo）', cliId: 'coco' };
const TRAE_X: CliSelectOption = { key: 'traex', label: 'traex', cliId: 'traex' };
const TRAE_VARIANTS: ReadonlyArray<CliSelectOption> = [TRAE_COCO, TRAE_X];

// ─── Pi 选项 ─────────────────────────────────────────────────────────────────
// Pi 与 Oh My Pi 不合并，但在菜单里相邻摆放（在 Pi 的位置成对发出）。
const PI_OPTION: CliSelectOption = { key: 'pi', label: 'Pi', cliId: 'pi' };
const OHMYPI_OPTION: CliSelectOption = { key: 'oh-my-pi', label: 'Oh My Pi', cliId: 'oh-my-pi' };

// ─── cjadk 选项 ──────────────────────────────────────────────────────────────
// cjadk 没有「原生 agent」模式，只是个装配启动器（`cjadk <agent>`），故只有 × 变体。

const CJADK_X_CLAUDE: CliSelectOption = { key: 'cjadk-x-claude', label: 'CJADK × Claude', cliId: 'claude-code', wrapperCli: 'cjadk claude' };
const CJADK_X_CODEX: CliSelectOption = { key: 'cjadk-x-codex', label: 'CJADK × Codex', cliId: 'codex', wrapperCli: 'cjadk codex' };

const CJADK_VARIANTS: ReadonlyArray<CliSelectOption> = [CJADK_X_CLAUDE, CJADK_X_CODEX];

// ─── ttadk 选项 ──────────────────────────────────────────────────────────────
// ttadk（@byted/ttadk）跟 cjadk 一样是网关装配启动器：`ttadk <子命令>` 是
// `ttadk code -t <tool>` 的快捷写法，启动真实 CLI 前注入网关鉴权 env。与 cjadk
// 的关键差异：ttadk 默认会弹「交互式选模型菜单」卡住 PTY，靠 **`-m <model>`** 跳过
// （而非 cjadk 的 CJADK_INTERACTIVE env 开关），故模型对 managed 模型类 CLI 必填。
// CoCo 例外（ttadk 内部 requiresManagedModel=false，不弹菜单、不接受 -m）。
//
// 模型不写死在 wrapperCli，而是复用 bot 的通用 `model` 字段（dashboard 可动态改）：
// 启动期由 worker 检测 ttadk 前缀，把 `model` 注入成 ttadk 的 `-m`（见
// {@link buildWrappedLaunch} 的 `ttadkModel` 形参），并**不**把 model 透给底层适配器
// （否则真实 CLI 会再吃一个 --model 重复）。ttadk 的 code 命令用
// `allowUnknownOption + enablePositionalOptions`，故 botmux 适配器的其余参数
// （--settings/--dangerously-skip-permissions/--session-id…）原样 bare 透传给真实 CLI，
// 无需 `--` 分隔（与 cjadk 同）。Cursor 走 ttadk 的 `cursor-cli` 子命令（cliId 仍是 cursor）。

/** ttadk 默认模型（dashboard 占位 / 启动期空值兜底，CoCo 不适用）。 */
export const TTADK_DEFAULT_MODEL = 'glm-5.1';

/** dashboard 模型框候选（账号不同会变，仅作建议，仍可自由填任意模型 id）。 */
export const TTADK_MODEL_SUGGESTIONS: ReadonlyArray<string> = [
  'glm-5.1',
  'glm-5',
  'kimi-k2.5',
  'gpt-5.3-codex',
  'gpt-5.2',
  'gpt-5.2-codex',
];

/** ttadk 子命令中**不接受 `-m`**（requiresManagedModel=false）的那些——目前仅 coco。 */
const TTADK_NO_MODEL_SUBCOMMANDS: ReadonlySet<string> = new Set(['coco']);

const TTADK_X_CLAUDE: CliSelectOption = { key: 'ttadk-x-claude', label: 'TTADK × Claude', cliId: 'claude-code', wrapperCli: 'ttadk claude' };
const TTADK_X_CODEX: CliSelectOption = { key: 'ttadk-x-codex', label: 'TTADK × Codex', cliId: 'codex', wrapperCli: 'ttadk codex' };
const TTADK_X_OPENCODE: CliSelectOption = { key: 'ttadk-x-opencode', label: 'TTADK × OpenCode', cliId: 'opencode', wrapperCli: 'ttadk opencode' };
const TTADK_X_COCO: CliSelectOption = { key: 'ttadk-x-coco', label: 'TTADK × CoCo', cliId: 'coco', wrapperCli: 'ttadk coco' };
const TTADK_X_CURSOR: CliSelectOption = { key: 'ttadk-x-cursor', label: 'TTADK × Cursor', cliId: 'cursor', wrapperCli: 'ttadk cursor-cli' };
const TTADK_X_GEMINI: CliSelectOption = { key: 'ttadk-x-gemini', label: 'TTADK × Gemini', cliId: 'gemini', wrapperCli: 'ttadk gemini' };

const TTADK_VARIANTS: ReadonlyArray<CliSelectOption> = [
  TTADK_X_CLAUDE, TTADK_X_CODEX, TTADK_X_OPENCODE, TTADK_X_COCO, TTADK_X_CURSOR, TTADK_X_GEMINI,
];

/** 顶层 CLI 之外、纯 wrapperCli 网关分组（不对应任何原生 cliId），追加到树/列表末尾。 */
const EXTRA_GATEWAY_GROUPS: ReadonlyArray<CliSelectGroup> = [
  { key: 'cjadk', label: 'CJADK', children: CJADK_VARIANTS },
  { key: 'ttadk', label: 'TTADK', children: TTADK_VARIANTS },
];

// ─── 扁平 / 级联 视图（均派生自 bot-config-editor 的 CLI_OPTIONS，避免再抄一份）──

/**
 * 级联树（终端 TUI 用）：顺序同 CLI_OPTIONS；'aiden' 一项展开成 children；
 * 末尾追加无原生 cliId 的网关分组（CJADK / TTADK）。
 */
export const CLI_SELECT_TREE: ReadonlyArray<CliSelectGroup> = [
  ...CLI_OPTIONS.flatMap((o): CliSelectGroup[] => {
    if (o.id === 'aiden') return [{ key: 'aiden', label: 'Aiden', children: AIDEN_VARIANTS }];
    // mira + mir collapse into one「Mira」二级菜单 at mira's position.
    if (o.id === 'mira') return [{ key: 'mira', label: 'Mira', children: MIRA_VARIANTS }];
    if (o.id === 'mir') return []; // already a child of the Mira group above
    // codex + codex-app collapse into one「Codex」二级菜单 at codex's position.
    if (o.id === 'codex') return [{ key: 'codex', label: 'Codex', children: CODEX_VARIANTS }];
    if (o.id === 'codex-app') return [];
    // coco + traex collapse into one「TRAE (CoCo)」二级菜单 at coco's position.
    if (o.id === 'coco') return [{ key: 'trae', label: 'TRAE (CoCo)', children: TRAE_VARIANTS }];
    if (o.id === 'traex') return [];
    // Pi and Oh My Pi are kept as adjacent leaves (emitted together at pi's spot).
    if (o.id === 'pi') return [
      { key: 'pi', label: 'Pi', option: PI_OPTION },
      { key: 'oh-my-pi', label: 'Oh My Pi', option: OHMYPI_OPTION },
    ];
    if (o.id === 'oh-my-pi') return [];
    return [{ key: o.id, label: o.label, option: { key: o.id, label: o.label, cliId: o.id } }];
  }),
  ...EXTRA_GATEWAY_GROUPS,
];

/**
 * 扁平选项（web 下拉 + 非 TTY 回退用）：'aiden' 之后紧跟两个 aiden×* 项，
 * 末尾依次追加 cjadk×* 与 ttadk×* 项。
 */
export const CLI_SELECT_OPTIONS: ReadonlyArray<CliSelectOption> = [
  ...CLI_OPTIONS.flatMap((o) => {
    if (o.id === 'aiden') return AIDEN_VARIANTS;
    if (o.id === 'mira') return MIRA_VARIANTS;   // expands to Mira App + Mir CLI
    if (o.id === 'mir') return [];               // already included via MIRA_VARIANTS
    if (o.id === 'codex') return CODEX_VARIANTS;  // expands to Codex + Codex App
    if (o.id === 'codex-app') return [];
    if (o.id === 'coco') return TRAE_VARIANTS;    // expands to TRAE CLI (CoCo) + traex
    if (o.id === 'traex') return [];
    if (o.id === 'pi') return [PI_OPTION, OHMYPI_OPTION];  // Pi + Oh My Pi adjacent
    if (o.id === 'oh-my-pi') return [];
    return [{ key: o.id, label: o.label, cliId: o.id }];
  }),
  ...CJADK_VARIANTS,
  ...TTADK_VARIANTS,
];

const OPTION_BY_KEY: ReadonlyMap<string, CliSelectOption> = new Map(
  CLI_SELECT_OPTIONS.map((o) => [o.key, o]),
);

/** 按 key 查选项；非法 key 返回 undefined。 */
export function lookupCliSelection(key: string): CliSelectOption | undefined {
  return OPTION_BY_KEY.get(key.trim());
}

/** 反查：由一个 bot 现有的 cliId + wrapperCli 得到对应的选择键（供编辑时高亮默认）。 */
export function selectionKeyForBot(cliId: string, wrapperCli?: string): string {
  if (wrapperCli && wrapperCli.trim()) {
    const match = CLI_SELECT_OPTIONS.find((o) => o.wrapperCli === wrapperCli.trim());
    if (match) return match.key;
  }
  return cliId;
}

/**
 * 把选择键解析成可落盘的 bot 配置片段（纯映射，无副作用）。非法 key 抛错。
 */
export function resolveCliSelection(key: string): ResolvedCliSelection {
  const opt = lookupCliSelection(key);
  if (!opt) {
    throw new Error(
      `未知 CLI 选择项 "${key}"。合法值：${CLI_SELECT_OPTIONS.map((o) => o.key).join(', ')}`,
    );
  }
  return opt.wrapperCli ? { cliId: opt.cliId, wrapperCli: opt.wrapperCli } : { cliId: opt.cliId };
}

// ─── 运行时：通用 wrapperCli 启动前缀（无 wrapper 脚本）────────────────────────

/** 按空格把 wrapperCli 前缀拆成 token（首 token 为 bin）。 */
export function parseWrapperCli(wrapperCli: string): string[] {
  return wrapperCli.trim().split(/\s+/).filter(Boolean);
}

/** wrapper 前缀首 token 是否为 aiden 网关（`aiden x <cli>`）。aiden 会拦截底层 CLI
 *  的 config 透传参数——`aiden x claude` 拒收 `--settings`、`aiden x codex` 自 1.8.38
 *  起直接报错拒收 `-c`——故转发前要剥掉 botmux 注入的那部分（见 {@link stripWrapperUnsafeArgs}）。 */
function isAidenWrapper(tokens: ReadonlyArray<string>): boolean {
  return tokens[0] === 'aiden';
}

/** wrapper 前缀首 token 是否为 cjadk 装配启动器（`cjadk <agent>`）。cjadk 的 `code` 子命令
 *  把 `-c, --command` 占为己用（commander 选项），会吞掉 botmux 给 codex 注入的
 *  `-c shell_environment_policy.set.BOTMUX_*=…`（绑到 cjadk 的 --command，当成"要运行的命令"
 *  → 报 `… is not installed. Please install it first.`）——故 cjadk codex 转发前要把它改写成
 *  codex 的长形式 `--config`（见 {@link rewriteCjadkCodexConfigArgs}）。 */
function isCjadkWrapper(tokens: ReadonlyArray<string>): boolean {
  return tokens[0] === 'cjadk';
}

/** 是否为 botmux 经 codex `-c` 注入的「把 BOTMUX_* 塞进 shell 工具环境」配置覆盖值。
 *  只认 botmux 自己注入的 `shell_environment_policy.set.BOTMUX_` 前缀，绝不误伤用户
 *  自带的 `-c key=val`。 */
function isBotmuxShellEnvConfigValue(value: string | undefined): boolean {
  return !!value && value.startsWith('shell_environment_policy.set.BOTMUX_');
}

/**
 * 剥掉 aiden x claude 拒收的 `--settings`（含其值），支持 `--settings <v>` 与
 * `--settings=<v>` 两种写法。其余参数原样保留。改用纯 argv 处理（跨系统、无 shell）。
 */
export function stripSettingsArgs(args: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--settings') { i++; continue; }     // 跳过 flag + 紧随其后的值
    if (a.startsWith('--settings=')) continue;       // 跳过 --settings=<v>
    out.push(a);
  }
  return out;
}

/**
 * 剥掉 aiden `aiden x <cli>` 网关拒收的、**botmux 注入的**底层 CLI config 覆盖参数：
 *   - `--settings <v>` / `--settings=<v>`（claude 携带 hook/bypass，aiden x claude 历来就剥）
 *   - `-c shell_environment_policy.set.BOTMUX_*=…`（codex 用来把 BOTMUX_SESSION_ID 注入
 *     shell 工具环境；aiden 1.8.38+ 直接报错拒收 `aiden x codex` 透传的 `-c`，正是本次回归）
 * 这些参数承载的 session 环境已在进程级 env（BOTMUX_SESSION_ID 等）注入、并被 wrapper
 * 子进程继承（见 worker.ts childEnv），故剥掉只是去掉一条冗余的 belt-and-suspenders
 * 通道，不丢功能。`-c` 按 botmux 注入特征精确识别——只剥值以 `shell_environment_policy.set.BOTMUX_`
 * 开头者，用户自带的 `-c key=val` 一律不动；`--settings` 则沿用 aiden x claude 历来的兼容策略
 * 整体剥离（复用 {@link stripSettingsArgs}，不区分来源）。原生启动及 ttadk 等「裸透传」网关
 * 不走本函数，仍保留 `-c`（它们的 launcher 接受并转发给真 CLI，照常生效）。cjadk 走单独的
 * {@link rewriteCjadkCodexConfigArgs}（它的 `code` 子命令把 `-c` 占为 `--command`，要改写成
 * `--config` 才能透传，而非剥离——故不复用本函数）。
 *
 * 关键：识别按 botmux 注入特征（`--settings` 的语义 + `-c …BOTMUX_` 前缀）而非按某个具体 CLI——
 * 任何适配器将来注入**同形态**的 config 覆盖，经 aiden 网关时都会被一并剥掉，不会重蹈 codex 覆辙。
 * 注意范围仅限上述两种 botmux 注入形态：coco 的 `--config model.name=…`（承载 model、非 session
 * 管线，且无内置 `aiden x coco` 选项）等不同形态的 config 覆盖**有意不在此剥离**。
 */
export function stripWrapperUnsafeArgs(args: ReadonlyArray<string>): string[] {
  // 先剥 claude 的 --settings（单一事实源 stripSettingsArgs），再剥 codex 注入的 -c override。
  const afterSettings = stripSettingsArgs(args);
  const out: string[] = [];
  for (let i = 0; i < afterSettings.length; i++) {
    const a = afterSettings[i]!;
    if (a === '-c' && isBotmuxShellEnvConfigValue(afterSettings[i + 1])) { i++; continue; }
    out.push(a);
  }
  return out;
}

/**
 * cjadk codex 专用改写：把 botmux 给 codex 注入的 `-c shell_environment_policy.set.BOTMUX_*=…`
 * 改写成 codex 的长形式 `--config shell_environment_policy.set.BOTMUX_*=…`。
 *
 * 起因：cjadk 的 `code` 子命令用 commander 定义了 `-c, --command <cmd>`（"运行自定义命令而非默认
 * agent 命令"），即便 `allowUnknownOption(true)`，**已定义**的 `-c` 仍被 cjadk 自己吃掉绑到
 * `--command`，不会透传给真 codex——于是 cjadk 把 `shell_environment_policy.set.BOTMUX_SESSION_ID="…"`
 * 当成"要运行的命令"，报 `… is not installed. Please install it first.`（本次只在 cjadk codex 复现的根因；
 * cjadk claude 不受影响是因为 claude 注入的是 `--settings` 而非 `-c`）。
 *
 * codex 的 `--config` 是 `-c` 的长形式（`-c, --config <key=value>`），而 cjadk 的 `code` 子命令**未定义**
 * `--config`，故 `--config …` 落入 cjadk 的 passthrough（`allowUnknownOption`）原样转发给真 codex，效果与 `-c`
 * 完全一致。相比 aiden 路径的整条剥离，改写**保留**了把 BOTMUX_SESSION_ID 注入 codex shell 工具环境的通道。
 *
 * 只改写 botmux 自己注入的那一处（值以 `shell_environment_policy.set.BOTMUX_` 开头），用户自带的 `-c key=val`
 * 一律不动。非 codex 的 cjadk 形态（cjadk claude 带 `--settings`、不带 `-c BOTMUX`）经此函数是 no-op，
 * `--settings` 照常保留透传。
 */
export function rewriteCjadkCodexConfigArgs(args: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-c' && isBotmuxShellEnvConfigValue(args[i + 1])) {
      out.push('--config', args[i + 1]!);
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** 该前缀是否为 ttadk 网关（`ttadk <子命令> …`）。 */
export function isTtadkWrapper(wrapperCli: string | undefined): boolean {
  return !!wrapperCli && parseWrapperCli(wrapperCli)[0] === 'ttadk';
}

/** ttadk 该子命令是否接受 `-m <model>`（CoCo 等 requiresManagedModel=false 的不接受）。非 ttadk 前缀返回 false。 */
export function ttadkAcceptsModel(wrapperCli: string | undefined): boolean {
  if (!wrapperCli) return false;
  const tokens = parseWrapperCli(wrapperCli);
  return tokens[0] === 'ttadk' && !!tokens[1] && !TTADK_NO_MODEL_SUBCOMMANDS.has(tokens[1]);
}

/** buildWrappedLaunch 的可选项。 */
export interface WrappedLaunchOptions {
  /**
   * ttadk 网关专用：注入到 `ttadk <子命令> -m <model>` 的模型 id。空/未传时
   * 用 {@link TTADK_DEFAULT_MODEL} 兜底；不接受 -m 的子命令（CoCo）忽略此项。
   */
  readonly ttadkModel?: string;
}

/**
 * ttadk 前缀参数（不含 bin `ttadk` 本身）：`<子命令> [-m <model>] --skip-check`。
 *   - `-m <model>`：跳过 ttadk 交互式选模型菜单（CoCo 等 requiresManagedModel=false 的子命令不注入）
 *   - `--skip-check`：跳过 ttadk preflight，避免交互/卡顿
 * 单一事实源：spawn（{@link buildTtadkLaunch}）与 session-closed 卡片的手动 resume
 * 命令（{@link decorateResumeForWrapper}）都用它，保证两处的 ttadk 启动形态一致。
 */
function ttadkPrefixArgs(tokens: ReadonlyArray<string>, ttadkModel: string | undefined): string[] {
  // tokens = ['ttadk', '<子命令>', ...(罕见的额外前缀 token)]
  const sub = tokens[1];
  const out: string[] = [];
  if (sub) out.push(sub);
  if (sub && !TTADK_NO_MODEL_SUBCOMMANDS.has(sub)) {
    out.push('-m', (ttadkModel ?? '').trim() || TTADK_DEFAULT_MODEL);
  }
  out.push('--skip-check');
  return [...out, ...tokens.slice(2)];
}

/**
 * ttadk 启动构造：`ttadk <子命令> [-m <model>] --skip-check <CLI 参数…>`。
 * CLI 参数 bare 透传（ttadk code 命令 allowUnknownOption + enablePositionalOptions），无需 `--`。
 * 模型由调用方从 bot.model 传入（见 worker.ts），故不写死在 wrapperCli 里、可在 dashboard 动态改。
 */
function buildTtadkLaunch(
  tokens: ReadonlyArray<string>,
  cliArgs: ReadonlyArray<string>,
  binResolver: (bin: string) => string,
  ttadkModel: string | undefined,
): { bin: string; args: string[] } {
  return { bin: binResolver('ttadk'), args: [...ttadkPrefixArgs(tokens, ttadkModel), ...cliArgs] };
}

/**
 * /botconfig 等配置卡的 ttadk 模型候选：ttadk 网关 bot 返回 ttadk 模型候选
 * （{@link TTADK_MODEL_SUGGESTIONS}；CoCo 等不接受 -m 的返回 `[]` = 不渲染模型下拉）；
 * 非 ttadk 返回 `null`，调用方据此回落底层适配器自己的 modelChoices。
 */
export function ttadkConfigModelChoices(wrapperCli: string | undefined): string[] | null {
  if (!isTtadkWrapper(wrapperCli)) return null;
  return ttadkAcceptsModel(wrapperCli) ? [...TTADK_MODEL_SUGGESTIONS] : [];
}

/**
 * 由 wrapperCli 前缀 + 底层 CLI 的 args 构造实际 spawn 的 `{ bin, args }`。
 *   - bin = 前缀首 token（经 binResolver 走 PATH 解析）
 *   - args = 前缀其余 token + CLI 参数（aiden `aiden x <cli>` 形态会先经
 *     {@link stripWrapperUnsafeArgs} 剥掉 botmux 注入、aiden 拒收的 `--settings`/`-c`；
 *     cjadk `cjadk <agent>` 形态走 {@link rewriteCjadkCodexConfigArgs} 把 codex 注入的 `-c`
 *     改写成 cjadk 不会吞掉的 `--config`）
 *   - ttadk 网关走专门分支注入 `-m <model> --skip-check`（见 {@link buildTtadkLaunch}）
 * 前缀为空时返回 `{ bin: '', args }`，调用方据此跳过（不改写 spawn）。
 */
export function buildWrappedLaunch(
  wrapperCli: string,
  cliArgs: ReadonlyArray<string>,
  binResolver: (bin: string) => string = (b) => b,
  opts: WrappedLaunchOptions = {},
): { bin: string; args: string[] } {
  const tokens = parseWrapperCli(wrapperCli);
  if (tokens.length === 0) return { bin: '', args: [...cliArgs] };
  if (tokens[0] === 'ttadk') return buildTtadkLaunch(tokens, cliArgs, binResolver, opts.ttadkModel);
  let forwarded: string[];
  if (isAidenWrapper(tokens)) forwarded = stripWrapperUnsafeArgs(cliArgs);
  else if (isCjadkWrapper(tokens)) forwarded = rewriteCjadkCodexConfigArgs(cliArgs);
  else forwarded = [...cliArgs];
  return { bin: binResolver(tokens[0]), args: [...tokens.slice(1), ...forwarded] };
}

/**
 * 把适配器给出的「裸 CLI 恢复命令」改写成 wrapperCli 形态，供 session-closed 卡片里
 * 展示给用户手动 resume。例：`claude --resume <id>` + 前缀 `aiden x claude` →
 * `aiden x claude --resume <id>`。wrapperCli 未设时原样返回。
 *
 * ttadk 特例：必须带上 `-m <model> --skip-check`（与 {@link buildTtadkLaunch} 同），
 * 否则用户复制粘贴这条 resume 命令会卡在 ttadk 的交互式选模型菜单。模型从
 * `opts.ttadkModel`（= bot.model）取，空则用默认值（CoCo 不带 -m）。
 */
export function decorateResumeForWrapper(
  cmd: string,
  wrapperCli: string | undefined,
  opts: { ttadkModel?: string } = {},
): string {
  if (!wrapperCli || !wrapperCli.trim()) return cmd;
  const rest = cmd.replace(/^\S+\s*/, ''); // 去掉首个 token（底层 bin 名）
  if (isTtadkWrapper(wrapperCli)) {
    const prefix = ['ttadk', ...ttadkPrefixArgs(parseWrapperCli(wrapperCli), opts.ttadkModel)].join(' ');
    return `${prefix} ${rest}`.trimEnd();
  }
  return `${wrapperCli.trim()} ${rest}`.trimEnd();
}
