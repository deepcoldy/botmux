/**
 * cli-selection.ts
 *
 * 单一事实源：把「用户可选的 CLI 形态」从「原始 cliId 列表」抽象成一层
 * **可级联的选择项**。除了原生 CLI，额外提供两个 aiden 网关形态：
 *   - Aiden × Claude → 底层 cliId=claude-code，启动前缀 `aiden x claude`
 *   - Aiden × Codex  → 底层 cliId=codex，启动前缀 `aiden x codex`
 *
 * 这两个形态**不生成任何 wrapper 脚本**：通过 bot 配置的 `wrapperCli`（通用启动前缀）
 * 实现——worker 在 spawn 时把启动命令拼成 `<wrapperCli> <CLI 参数>`（纯 argv，跨系统）。
 * `wrapperCli` 是通用机制（也能承载 ccr / claude-w 等），不止 aiden。见 worker.ts 的
 * wrapperCli 处理与 {@link buildWrappedLaunch} / {@link stripSettingsArgs}。
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

// ─── 扁平 / 级联 视图（均派生自 bot-config-editor 的 CLI_OPTIONS，避免再抄一份）──

/**
 * 级联树（终端 TUI 用）：顺序同 CLI_OPTIONS；'aiden' 一项展开成 children。
 */
export const CLI_SELECT_TREE: ReadonlyArray<CliSelectGroup> = CLI_OPTIONS.map((o) =>
  o.id === 'aiden'
    ? { key: 'aiden', label: 'Aiden', children: AIDEN_VARIANTS }
    : { key: o.id, label: o.label, option: { key: o.id, label: o.label, cliId: o.id } },
);

/**
 * 扁平选项（web 下拉 + 非 TTY 回退用）：在 'aiden' 之后紧跟两个 aiden×* 项。
 */
export const CLI_SELECT_OPTIONS: ReadonlyArray<CliSelectOption> = CLI_OPTIONS.flatMap((o) =>
  o.id === 'aiden'
    ? AIDEN_VARIANTS
    : [{ key: o.id, label: o.label, cliId: o.id }],
);

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

/** 该前缀是否为 `aiden x claude`（仅它需要剥 --settings）。 */
function isAidenXClaude(tokens: ReadonlyArray<string>): boolean {
  return tokens[0] === 'aiden' && tokens[1] === 'x' && tokens[2] === 'claude';
}

/**
 * 该启动前缀是否会剥掉 botmux 注入的 `--settings`（目前 = aiden x claude）。
 * 剥了则 claude 收不到进程级 SessionStart ready hook，worker 据此**不武装 ready-gate**
 * （否则会空等 45s 超时兜底，拖慢首条 prompt 注入）——退回 readyPattern + quiescence。
 */
export function wrapperStripsSettings(wrapperCli: string | undefined): boolean {
  return !!wrapperCli && isAidenXClaude(parseWrapperCli(wrapperCli));
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
 * 由 wrapperCli 前缀 + 底层 CLI 的 args 构造实际 spawn 的 `{ bin, args }`。
 *   - bin = 前缀首 token（经 binResolver 走 PATH 解析）
 *   - args = 前缀其余 token + CLI 参数（aiden x claude 形态会先剥掉 --settings）
 * 前缀为空时返回 `{ bin: '', args }`，调用方据此跳过（不改写 spawn）。
 */
export function buildWrappedLaunch(
  wrapperCli: string,
  cliArgs: ReadonlyArray<string>,
  binResolver: (bin: string) => string = (b) => b,
): { bin: string; args: string[] } {
  const tokens = parseWrapperCli(wrapperCli);
  if (tokens.length === 0) return { bin: '', args: [...cliArgs] };
  const forwarded = isAidenXClaude(tokens) ? stripSettingsArgs(cliArgs) : [...cliArgs];
  return { bin: binResolver(tokens[0]), args: [...tokens.slice(1), ...forwarded] };
}

/**
 * 把适配器给出的「裸 CLI 恢复命令」改写成 wrapperCli 形态，供 session-closed 卡片里
 * 展示给用户手动 resume。例：`claude --resume <id>` + 前缀 `aiden x claude` →
 * `aiden x claude --resume <id>`。wrapperCli 未设时原样返回。
 */
export function decorateResumeForWrapper(cmd: string, wrapperCli: string | undefined): string {
  if (!wrapperCli || !wrapperCli.trim()) return cmd;
  const rest = cmd.replace(/^\S+\s*/, ''); // 去掉首个 token（底层 bin 名）
  return `${wrapperCli.trim()} ${rest}`.trimEnd();
}
