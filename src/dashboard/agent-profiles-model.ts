/**
 * Agent 配置模板的纯模型（浏览器与 Dashboard 服务端共用，不得 import node 模块）。
 *
 * Agent 只是**配置模板**：真正生效的值始终物化在每个 Bot 的 bots.json 条目里，
 * 由现有逐字段 daemon IPC（`PUT /api/bots/:appId/<segment>`）写入。本模块负责三件
 * 「必须只有一处定义」的事：
 *   1. agents.json 的结构与归一化；
 *   2. 一个 Agent 分组 → 下发请求（{@link agentPushRequests}）；
 *   3. 一个 Agent 分组 ↔ Bot 当前值的比较（{@link agentBotDrift}）。
 * 2 与 3 读同一份 {@link botSectionValues} 投影，保证「比较什么」与「下发什么」一致。
 *
 * 设计见 docs/design/2026-10-15-agent-profiles.md。
 */

import { normalizeCliConfigDir } from '../core/cli-config-dir.js';
import { normalizeStartupCommandList, parseStartupCommandsInput } from '../core/startup-commands.js';
import { isRemoteCliId, resolvePairedBackendId } from '../core/remote-cli-ids.js';
import { supportsZeroPromptInjection } from '../core/zero-prompt-support.js';
import { lookupCliSelection } from '../setup/cli-selection.js';

export const AGENT_PROFILES_VERSION = 1;

/**
 * 每个分组对应一个现有 daemon IPC；未设置的分组不下发、不比较。顺序即下发顺序，零注入
 * 例外（见 {@link agentPushRequests}）：开启要排在 CLI / 沙箱 / 后端之后，关闭要排在它们之前。
 */
export const AGENT_SECTIONS = ['exec', 'workspace', 'sandbox', 'backend', 'startup', 'promptInjection'] as const;
export type AgentSection = (typeof AGENT_SECTIONS)[number];

export const AGENT_WORKSPACE_MODES = ['off', 'default', 'oncall'] as const;
export type AgentWorkspaceMode = (typeof AGENT_WORKSPACE_MODES)[number];

export const AGENT_SANDBOX_MODES = ['off', 'oncall', 'scratch'] as const;
export type AgentSandboxMode = (typeof AGENT_SANDBOX_MODES)[number];

export const AGENT_PROMPT_INJECTION_MODES = ['default', 'none'] as const;
export type AgentPromptInjectionMode = (typeof AGENT_PROMPT_INJECTION_MODES)[number];

/** 与 services/backend-type-store.ts 的 EDITABLE_BACKEND_TYPES 保持一致（有测试守护）。 */
export const AGENT_BACKEND_TYPES = ['pty', 'tmux', 'herdr', 'zellij', 'zmx'] as const;
export type AgentBackendType = (typeof AGENT_BACKEND_TYPES)[number];

export const AGENT_NAME_MAX = 64;
export const AGENT_DESCRIPTION_MAX = 2000;
export const AGENT_STARTUP_COMMANDS_MAX = 32;
export const AGENT_WORKING_DIR_MAX = 1024;
export const AGENTS_MAX = 200;
const AGENT_ID_RE = /^ag_[A-Za-z0-9_-]{4,40}$/;

export interface AgentExecConfig {
  /** Dashboard 的 CLI 选择键（含 wrapper 网关形态，如 aiden×claude）。 */
  cliId: string;
  /** '' = CLI 默认模型。 */
  model: string;
  /** '' = CLI 默认推理强度。 */
  reasoningEffort: string;
  /** CLI 配置目录（claude-code: CLAUDE_CONFIG_DIR）；'' = CLI 默认目录。 */
  configDir: string;
}

export interface AgentWorkspaceConfig {
  mode: AgentWorkspaceMode;
  /** mode 为 off 时忽略。原样保存用户输入（可含 `~`），与 Bot 侧存储口径一致。 */
  workingDir: string;
  /** 仅 mode 为 default 时有意义。 */
  autoWorktree: boolean;
}

export interface AgentSandboxConfig { mode: AgentSandboxMode }
/** '' = 跟随 daemon 全局默认后端。 */
export interface AgentBackendConfig { backendType: '' | AgentBackendType }
export interface AgentStartupConfig { commands: string[] }
/** 零注入：`none` = 新会话不附带 Botmux 提示词（见 core/prompt-injection）。 */
export interface AgentPromptInjectionConfig { mode: AgentPromptInjectionMode }

export interface AgentSectionsConfig {
  exec?: AgentExecConfig;
  workspace?: AgentWorkspaceConfig;
  sandbox?: AgentSandboxConfig;
  backend?: AgentBackendConfig;
  startup?: AgentStartupConfig;
  promptInjection?: AgentPromptInjectionConfig;
}

export interface AgentProfile extends AgentSectionsConfig {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentProfilesDoc {
  version: typeof AGENT_PROFILES_VERSION;
  agents: AgentProfile[];
  /** larkAppId → agentId。一个 Bot 至多关联一个 Agent。 */
  links: Record<string, string>;
}

export type NormalizeResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function emptyAgentProfilesDoc(): AgentProfilesDoc {
  return { version: AGENT_PROFILES_VERSION, agents: [], links: {} };
}

export function isAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 启动命令归一化直接复用 daemon 的实现（core/startup-commands.ts）：补 `/` 前缀、去重、
 * 超长丢弃都与 daemon 写入 bots.json 时完全一致，否则同步后 Bot 侧的归一化结果与 Agent
 * 定义永远不相等，关联边会一直显示偏差。文本（输入框 / daemon 回显）按逗号或换行切分；
 * 数组（agents.json 存储形态）逐条归一化，不再二次切分。
 */
export function parseStartupCommands(value: unknown): string[] {
  if (Array.isArray(value)) return normalizeStartupCommandList(value);
  return parseStartupCommandsInput(typeof value === 'string' ? value : '');
}

function normalizeExec(raw: unknown): NormalizeResult<AgentExecConfig> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_exec' };
  const cliId = str(raw.cliId);
  if (!cliId) return { ok: false, error: 'cli_required' };
  let configDir: string;
  try {
    configDir = normalizeCliConfigDir(raw.configDir) ?? '';
  } catch {
    return { ok: false, error: 'invalid_config_dir' };
  }
  return { ok: true, value: { cliId, model: str(raw.model), reasoningEffort: str(raw.reasoningEffort), configDir } };
}

function normalizeWorkspace(raw: unknown): NormalizeResult<AgentWorkspaceConfig> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_workspace' };
  const mode = raw.mode;
  if (!(AGENT_WORKSPACE_MODES as readonly unknown[]).includes(mode)) return { ok: false, error: 'invalid_workspace_mode' };
  const workingDir = str(raw.workingDir);
  if (workingDir.length > AGENT_WORKING_DIR_MAX) return { ok: false, error: 'working_dir_too_long' };
  if (mode !== 'off' && !workingDir) return { ok: false, error: 'working_dir_required' };
  return {
    ok: true,
    value: {
      mode: mode as AgentWorkspaceMode,
      workingDir: mode === 'off' ? '' : workingDir,
      autoWorktree: mode === 'default' && raw.autoWorktree === true,
    },
  };
}

function normalizeSandbox(raw: unknown): NormalizeResult<AgentSandboxConfig> {
  if (!isRecord(raw) || !(AGENT_SANDBOX_MODES as readonly unknown[]).includes(raw.mode)) {
    return { ok: false, error: 'invalid_sandbox_mode' };
  }
  return { ok: true, value: { mode: raw.mode as AgentSandboxMode } };
}

function normalizeBackend(raw: unknown): NormalizeResult<AgentBackendConfig> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_backend' };
  const backendType = str(raw.backendType);
  if (backendType && !(AGENT_BACKEND_TYPES as readonly string[]).includes(backendType)) {
    return { ok: false, error: 'invalid_backend_type' };
  }
  return { ok: true, value: { backendType: backendType as AgentBackendConfig['backendType'] } };
}

function normalizeStartup(raw: unknown): NormalizeResult<AgentStartupConfig> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_startup' };
  const commands = parseStartupCommands(raw.commands);
  if (commands.length > AGENT_STARTUP_COMMANDS_MAX) return { ok: false, error: 'too_many_startup_commands' };
  return { ok: true, value: { commands } };
}

function normalizePromptInjection(raw: unknown): NormalizeResult<AgentPromptInjectionConfig> {
  if (!isRecord(raw) || !(AGENT_PROMPT_INJECTION_MODES as readonly unknown[]).includes(raw.mode)) {
    return { ok: false, error: 'invalid_prompt_injection' };
  }
  return { ok: true, value: { mode: raw.mode as AgentPromptInjectionMode } };
}

const SECTION_NORMALIZERS: { [K in AgentSection]: (raw: unknown) => NormalizeResult<NonNullable<AgentSectionsConfig[K]>> } = {
  exec: normalizeExec,
  workspace: normalizeWorkspace,
  sandbox: normalizeSandbox,
  backend: normalizeBackend,
  startup: normalizeStartup,
  promptInjection: normalizePromptInjection,
};

/**
 * 归一化可编辑部分（名称、说明、各分组）。`null` / 缺省的分组表示「不设置」。
 * 任一已给出的分组非法即整体拒绝，不做静默丢弃。
 */
export function normalizeAgentInput(raw: unknown): NormalizeResult<Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'>> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_agent' };
  const name = str(raw.name);
  if (!name) return { ok: false, error: 'name_required' };
  if (name.length > AGENT_NAME_MAX) return { ok: false, error: 'name_too_long' };
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (description.length > AGENT_DESCRIPTION_MAX) return { ok: false, error: 'description_too_long' };
  const out: Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'> = { name, description };
  for (const section of AGENT_SECTIONS) {
    const value = raw[section];
    if (value === undefined || value === null) continue;
    const normalized = SECTION_NORMALIZERS[section](value);
    if (!normalized.ok) return { ok: false, error: `${section}:${normalized.error}` };
    (out as Record<string, unknown>)[section] = normalized.value;
  }
  return { ok: true, value: out };
}

function finiteTime(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 读盘时的宽松归一化：单个非法 Agent 丢弃（记入 `dropped`），不连累其它 Agent；
 * 指向不存在 Agent 的 link 一并丢弃。
 */
export function normalizeAgentProfilesDoc(raw: unknown): { doc: AgentProfilesDoc; dropped: string[] } {
  const doc = emptyAgentProfilesDoc();
  const dropped: string[] = [];
  if (!isRecord(raw)) return { doc, dropped: raw === undefined ? [] : ['<root>'] };
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw.agents) ? raw.agents : []) {
    const id = isRecord(entry) ? entry.id : undefined;
    if (!isAgentId(id) || seen.has(id)) { dropped.push(String(id)); continue; }
    const normalized = normalizeAgentInput(entry);
    if (!normalized.ok) { dropped.push(id); continue; }
    seen.add(id);
    const createdAt = finiteTime((entry as Record<string, unknown>).createdAt, 0);
    doc.agents.push({
      id,
      ...normalized.value,
      createdAt,
      updatedAt: finiteTime((entry as Record<string, unknown>).updatedAt, createdAt),
    });
    if (doc.agents.length >= AGENTS_MAX) break;
  }
  if (isRecord(raw.links)) {
    for (const [appId, agentId] of Object.entries(raw.links)) {
      if (appId && typeof agentId === 'string' && seen.has(agentId)) doc.links[appId] = agentId;
    }
  }
  return { doc, dropped };
}

export function agentLinkedBots(doc: Pick<AgentProfilesDoc, 'links'>, agentId: string): string[] {
  return Object.entries(doc.links).filter(([, id]) => id === agentId).map(([appId]) => appId);
}

// ─── Bot 当前值投影 ──────────────────────────────────────────────────────────

/** `/api/bots` 行里与 Agent 相关的字段子集（BotDefaultsRow 结构兼容）。 */
export interface AgentBotSnapshot {
  larkAppId: string;
  online?: boolean;
  error?: string;
  cliId?: string;
  agentSelectionKey?: string;
  model?: string;
  reasoningEffort?: string;
  cliConfigDir?: string | null;
  defaultOncall?: { enabled?: boolean; workingDir?: string };
  defaultWorkingDir?: string | null;
  defaultWorkingDirAutoWorktree?: boolean;
  sandbox?: boolean;
  sandboxMode?: string | null;
  backendType?: string | null;
  /** daemon 的默认后端（`backendType` 没有覆盖时生效）。 */
  defaultBackendType?: string | null;
  startupCommands?: string;
  promptInjection?: string;
}

/** 把 Bot 当前配置投影成 Agent 分组形状。用于「从 Bot 生成 Agent」与偏差比较。 */
export function botSectionValues(bot: AgentBotSnapshot): Required<AgentSectionsConfig> {
  const oncall = bot.defaultOncall ?? {};
  const mode: AgentWorkspaceMode = oncall.enabled ? 'oncall' : (bot.defaultWorkingDir ? 'default' : 'off');
  const sandboxMode: AgentSandboxMode = bot.sandboxMode === 'oncall' || bot.sandboxMode === 'scratch' || bot.sandboxMode === 'off'
    ? bot.sandboxMode
    : bot.sandbox ? 'oncall' : 'off';
  const backendType = str(bot.backendType);
  return {
    exec: {
      cliId: str(bot.agentSelectionKey) || str(bot.cliId),
      model: str(bot.model),
      reasoningEffort: str(bot.reasoningEffort),
      configDir: str(bot.cliConfigDir),
    },
    workspace: {
      mode,
      workingDir: mode === 'off' ? '' : str(mode === 'oncall' ? oncall.workingDir : bot.defaultWorkingDir),
      autoWorktree: mode === 'default' && bot.defaultWorkingDirAutoWorktree === true,
    },
    sandbox: { mode: sandboxMode },
    backend: {
      backendType: (AGENT_BACKEND_TYPES as readonly string[]).includes(backendType)
        ? backendType as AgentBackendType
        : '',
    },
    startup: { commands: parseStartupCommands(bot.startupCommands ?? '') },
    promptInjection: { mode: bot.promptInjection === 'none' ? 'none' : 'default' },
  };
}

// ─── 偏差检测 ────────────────────────────────────────────────────────────────

export type AgentDiffField =
  | 'cliId' | 'model' | 'reasoningEffort' | 'configDir'
  | 'workspaceMode' | 'workingDir' | 'autoWorktree'
  | 'sandboxMode' | 'backendType' | 'startupCommands' | 'promptInjection';

export interface AgentFieldDiff {
  section: AgentSection;
  field: AgentDiffField;
  /** 展示用字符串；'' 表示「默认 / 未设置」。 */
  agent: string;
  bot: string;
}

/** 目录比较只忽略首尾空白与末尾斜杠；`~` 与绝对路径不互相展开（两侧都是原样保存）。 */
function sameDir(a: string, b: string): boolean {
  const trim = (s: string) => s.trim().replace(/(.)\/+$/, '$1');
  return trim(a) === trim(b);
}

/**
 * 远程 CLI（riff / mojo / remote-runner）在远端执行：本地文件沙盒与终端后端对它不适用
 * （Bot 配置页也隐藏这两块，daemon 会自动配对远程后端），不比较、因而也不下发，否则会
 * 留下一条永远同步不掉的偏差边。目标 CLI 以 Agent 的执行分组为准（关联后会切过去）。
 */
function sectionAppliesTo(section: AgentSection, agent: AgentSectionsConfig, current: Required<AgentSectionsConfig>): boolean {
  if (section !== 'sandbox' && section !== 'backend') return true;
  return !isRemoteCliId(agent.exec?.cliId ?? current.exec.cliId);
}

export function diffAgentSections(agent: AgentSectionsConfig, bot: AgentBotSnapshot): AgentFieldDiff[] {
  const current = botSectionValues(bot);
  const diffs: AgentFieldDiff[] = [];
  const push = (section: AgentSection, field: AgentDiffField, a: string, b: string) => {
    diffs.push({ section, field, agent: a, bot: b });
  };
  if (agent.exec) {
    const cur = current.exec;
    if (agent.exec.cliId !== cur.cliId) push('exec', 'cliId', agent.exec.cliId, cur.cliId);
    if (agent.exec.model !== cur.model) push('exec', 'model', agent.exec.model, cur.model);
    if (agent.exec.reasoningEffort !== cur.reasoningEffort) {
      push('exec', 'reasoningEffort', agent.exec.reasoningEffort, cur.reasoningEffort);
    }
    if (!sameDir(agent.exec.configDir, cur.configDir)) push('exec', 'configDir', agent.exec.configDir, cur.configDir);
  }
  if (agent.workspace) {
    const cur = current.workspace;
    if (agent.workspace.mode !== cur.mode) push('workspace', 'workspaceMode', agent.workspace.mode, cur.mode);
    if (agent.workspace.mode !== 'off' && !sameDir(agent.workspace.workingDir, cur.workingDir)) {
      push('workspace', 'workingDir', agent.workspace.workingDir, cur.workingDir);
    }
    if (agent.workspace.mode === 'default' && agent.workspace.autoWorktree !== cur.autoWorktree) {
      push('workspace', 'autoWorktree', String(agent.workspace.autoWorktree), String(cur.autoWorktree));
    }
  }
  if (agent.sandbox && sectionAppliesTo('sandbox', agent, current) && agent.sandbox.mode !== current.sandbox.mode) {
    push('sandbox', 'sandboxMode', agent.sandbox.mode, current.sandbox.mode);
  }
  if (agent.backend && sectionAppliesTo('backend', agent, current) && agent.backend.backendType !== current.backend.backendType) {
    push('backend', 'backendType', agent.backend.backendType, current.backend.backendType);
  }
  if (agent.startup) {
    const a = agent.startup.commands.join('\n');
    const b = current.startup.commands.join('\n');
    if (a !== b) push('startup', 'startupCommands', a, b);
  }
  if (agent.promptInjection && agent.promptInjection.mode !== current.promptInjection.mode) {
    push('promptInjection', 'promptInjection', agent.promptInjection.mode, current.promptInjection.mode);
  }
  return diffs;
}

/** 会改变零注入能否成立的分组。 */
export const ZERO_PROMPT_SECTIONS: readonly AgentSection[] = ['exec', 'sandbox', 'backend', 'promptInjection'];

/**
 * Bot 应用了 Agent 的分组后，零注入会不会落在不支持的 CLI / 后端 / 沙盒组合上。
 * `applied` 缺省 = Agent 的全部分组（同步完成后的组合）；给出时只把这些分组视为已写入、
 * 其余仍取 Bot 当前值（逐步下发时的中间组合）。
 *
 * daemon 只有零注入自己的写入接口会按当前组合校验；CLI / 沙箱 / 后端的写入接口不检查
 * 零注入，所以这几组的每一步写入都要由调用方先判断（见 agents-api 的 syncAgentToBot）。
 */
export function agentZeroPromptConflict(
  agent: AgentSectionsConfig,
  bot: AgentBotSnapshot,
  applied?: readonly AgentSection[],
): boolean {
  const use = (section: AgentSection) => !applied || applied.includes(section);
  const current = botSectionValues(bot);
  const mode = use('promptInjection') && agent.promptInjection ? agent.promptInjection.mode : current.promptInjection.mode;
  if (mode !== 'none') return false;
  // 不管 CLI 时沿用 Bot 的真实 CLI（与 Bot 配置页的零注入开关同一口径）。
  const exec = use('exec') ? agent.exec : undefined;
  const cliId = exec ? (lookupCliSelection(exec.cliId)?.cliId ?? exec.cliId) : str(bot.cliId);
  // 后端按新会话 spawn 时的生效值：覆盖值（空 = 清除覆盖），否则 daemon 默认后端，再按
  // CLI 配对（与 daemon 写入校验、spawn 时的强制校验同一规则）。
  const backendType = resolvePairedBackendId(
    cliId,
    use('backend') && agent.backend ? agent.backend.backendType : current.backend.backendType,
    str(bot.defaultBackendType),
  );
  const sandbox = use('sandbox') && agent.sandbox ? agent.sandbox.mode : current.sandbox.mode;
  return !supportsZeroPromptInjection(cliId, { backendType, sandbox });
}

export type AgentLinkState = 'synced' | 'drift' | 'offline';

export interface AgentLinkStatus {
  state: AgentLinkState;
  diffs: AgentFieldDiff[];
  /** 有偏差的分组（去重、按 AGENT_SECTIONS 顺序）。 */
  sections: AgentSection[];
}

/**
 * 关联边的状态。离线 / 读取失败的 Bot 拿不到可信的当前值，判为 offline，
 * 不拿 bots.json 回落值硬比（回落行缺字段，会误报偏差）。
 */
export function agentBotDrift(agent: AgentSectionsConfig, bot: AgentBotSnapshot): AgentLinkStatus {
  if (bot.online === false || bot.error) return { state: 'offline', diffs: [], sections: [] };
  const diffs = diffAgentSections(agent, bot);
  const sections = AGENT_SECTIONS.filter(section => diffs.some(diff => diff.section === section));
  return { state: diffs.length ? 'drift' : 'synced', diffs, sections };
}

// ─── 下发计划 ────────────────────────────────────────────────────────────────

export interface AgentPushRequest {
  section: AgentSection;
  method: 'PUT';
  /** Dashboard 现有的 Bot 写入路由（经 daemon-proxy-routes 转发给目标 daemon）。 */
  url: string;
  body: Record<string, unknown>;
}

/**
 * Agent 已设置分组 → 现有逐字段写入请求。`only` 限定分组（如「只同步有偏差的」）。
 * 顺序按 AGENT_SECTIONS：先切 CLI 再动沙箱，与手动在 Bot 设置页操作的常见顺序一致；
 * 关闭零注入例外地排在最前（见函数内注释）。
 */
export function agentPushRequests(
  agent: AgentSectionsConfig,
  larkAppId: string,
  only?: readonly AgentSection[],
): AgentPushRequest[] {
  const base = `/api/bots/${encodeURIComponent(larkAppId)}`;
  const want = (section: AgentSection) => !only || only.includes(section);
  const out: AgentPushRequest[] = [];
  // 零注入开着时，CLI / 沙箱 / 后端不能切到不支持零注入的组合（同步时逐步拦下，见
  // agentZeroPromptConflict）；开启时 daemon 按 Bot 当前组合校验。所以关闭零注入要最先
  // 下发，开启则最后下发。
  const promptInjection: AgentPushRequest | null = agent.promptInjection && want('promptInjection')
    ? {
      section: 'promptInjection',
      method: 'PUT',
      url: `${base}/prompt-injection`,
      body: { promptInjection: agent.promptInjection.mode },
    }
    : null;
  if (promptInjection && agent.promptInjection!.mode === 'default') out.push(promptInjection);
  if (agent.exec && want('exec')) {
    out.push({
      section: 'exec',
      method: 'PUT',
      url: `${base}/agent`,
      // reasoningEffort / cliConfigDir 恒带上：'' / null 表示显式清回 CLI 默认，
      // 而不是「保留 Bot 原值」。不支持配置目录的 CLI 收到 null 时 daemon 直接丢弃。
      body: {
        cliId: agent.exec.cliId,
        model: agent.exec.model,
        reasoningEffort: agent.exec.reasoningEffort,
        cliConfigDir: agent.exec.configDir || null,
      },
    });
  }
  if (agent.workspace && want('workspace')) {
    out.push({
      section: 'workspace',
      method: 'PUT',
      url: `${base}/working-dir-mode`,
      body: {
        mode: agent.workspace.mode,
        workingDir: agent.workspace.workingDir,
        autoWorktree: agent.workspace.mode === 'default' && agent.workspace.autoWorktree,
      },
    });
  }
  if (agent.sandbox && want('sandbox')) {
    out.push({ section: 'sandbox', method: 'PUT', url: `${base}/sandbox`, body: { mode: agent.sandbox.mode } });
  }
  if (agent.backend && want('backend')) {
    out.push({ section: 'backend', method: 'PUT', url: `${base}/backend-type`, body: { backendType: agent.backend.backendType } });
  }
  if (agent.startup && want('startup')) {
    out.push({
      section: 'startup',
      method: 'PUT',
      url: `${base}/startup-commands`,
      body: { startupCommands: agent.startup.commands.join('\n') },
    });
  }
  if (promptInjection && agent.promptInjection!.mode === 'none') out.push(promptInjection);
  return out;
}
