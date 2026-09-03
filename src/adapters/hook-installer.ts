/**
 * hook-installer.ts
 *
 * 把 botmux 的 askUserQuestion hook 写入各 CLI 的配置文件。
 * 幂等：写前比对内容，相同则跳过；展开 ~ 路径；出错只 warn 不抛。
 */
import { readFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { hookCommandParts } from './hook-command.js';

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface HookInstallConfig {
  readonly configPath: string;
  readonly format: 'claude-settings' | 'opencode-plugin' | 'opencode2-plugin' | 'grok-hooks';
  /** Claude read-isolation: merge the shared settings `env` map into a
   *  per-bot settings file before installing hooks. Shared values win so
   *  rotated auth/provider/proxy settings refresh on every cold spawn; global
   *  hooks and unrelated top-level settings are deliberately not inherited. */
  readonly inheritClaudeEnvFrom?: string;
  /** 可选：SessionStart 就绪 hook 命令。
   *  - claude-settings：写全局 settings.json
   *  - grok-hooks：写 `~/.grok/hooks/*.json` 的 SessionStart
   *  见 adapters/cli/types.ts 同名字段。 */
  readonly sessionStartCommand?: string;
  /** 可选：UserPromptSubmit per-turn 上下文 hook 命令（#794）。
   *  仅 claude-settings：写全局 settings.json 的 hooks.UserPromptSubmit。 */
  readonly userPromptSubmitCommand?: string;
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/** 展开路径中的 ~ 为当前用户 home 目录。 */
function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/** 读 JSON 文件，失败返回 null。 */
function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 幂等写文件：若内容与现有相同则跳过；自动创建目录。 */
function writeIfChanged(filePath: string, content: string, mode?: number): boolean {
  try {
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf-8');
      if (existing === content) {
        if (mode !== undefined) chmodSync(filePath, mode);
        return false; // 内容相同，无需写入
      }
    }
    mkdirSync(dirname(filePath), { recursive: true });
    // 原子写：目标是 ~/.claude/settings.json 这类被 CLI 并发读写的热配置，
    // 裸写半截会让并发读者拿到坏 JSON 再整文件覆写回来（cjadk 事故同类）。
    atomicWriteFileSync(filePath, content, mode !== undefined ? { mode } : {});
    return true;
  } catch (err: any) {
    throw new Error(`写入 ${filePath} 失败：${err.message}`);
  }
}

// ─── Claude settings.json 格式 ───────────────────────────────────────────────

interface ClaudeHookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

interface ClaudeHookGroup {
  matcher?: string;
  hooks: ClaudeHookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookGroup[]>;
  [key: string]: unknown;
}

interface InheritedClaudeEnvState {
  version: 1;
  keys: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 从完整 hookCommand 中提取 `hook <cliId>` 尾签名。
 * hookCommand 形如：`"<node>" "<...dist/cli.js>" hook claude-code`，
 * 尾部 `hook <cliId>` 不随 node / cli.js 安装路径变化。
 */
function botmuxHookSuffix(hookCommand: string): string {
  const idx = hookCommand.lastIndexOf(' hook ');
  return idx === -1 ? hookCommand : hookCommand.slice(idx + 1); // "hook <cliId>"
}

/**
 * 判断一条命令字符串是否是「botmux 自己发起的 hook 调用」。
 *
 * ⚠️ 旧实现用 `command.includes('cli.js')` 来识别 botmux hook——这在 Node 态成立
 * （命令是 `"<node>" "<...>/dist/cli.js" <subcommand>`），但**编译态（单文件二进制）**
 * 下 `renderShellCommand` 写的是打包二进制路径 `"<...>/botmux-linux-x64/botmux" <subcommand>`，
 * 根本不含 `cli.js`。旧判据因此把已装 hook 误判为「未安装」。
 *
 * 后果分两种，别记成「三条一起失效」（实测口径）：
 *   - `session-ready` / `user-prompt-hook`：**每次安装都追加一条**。而 installHook 在
 *     read-isolation 路径下**每次冷 spawn 都会跑**（worker.ts `provisionIsolatedBotHome`），
 *     所以编译态盒子每开一个会话就 +1、无上限；已堆坏的盒子再装一次只会继续涨。
 *   - ask（`hook <cliId>`）：**通常不叠**——`isBotmuxAskHookGroup` 还有一条
 *     `e.command === hookCommand` 精确匹配分支，命令字符串不变时由它兜住；只有命令
 *     形态发生变化（如二进制↔Node 互切）时才会叠加。
 *
 * 稳定、与运行时形态无关的信号是 **子命令尾签名**（`hook <cliId>` / `session-ready` /
 * `user-prompt-hook`），加上调用目标名：Node 态是脚本 `cli.js`，编译态是可执行文件
 * `botmux`（`botmux-linux-x64/botmux` 的 basename 同为 `botmux`；Windows 上为 `botmux.exe`）。
 * 两者取其一即视为同一条 botmux hook，无论它指向哪个安装路径、由 node 还是打包二进制执行。
 *
 * ⚠️ basename 白名单**故意只认这三个字面量**，不要放宽成 `botmux-*` 前缀匹配：那会把
 * 第三方同前缀程序（`botmux-helper` / `botmux-wrapper` 等）也当成自己的 hook 删掉。
 * 已知未覆盖形态：本地 `bun run use:here --binary` 指向的 `dist-bin/botmux-<plat>-<arch>`
 * （basename 带平台后缀）。生产两条安装路径都落在 `botmux` 上（npm 平台子包
 * `…/node_modules/botmux-<plat>-<arch>/botmux`、install.sh 的 `~/.botmux/bin/botmux`），
 * 故仅影响开发机；真要覆盖须**枚举死平台后缀**而非放宽为任意后缀。
 */
function isBotmuxHookCommand(command: string, suffix: string): boolean {
  const trimmed = command.trimEnd();
  if (!trimmed.endsWith(suffix)) return false;
  // 子命令之前紧邻的是调用目标（脚本/可执行名），去掉可能包裹它的尾部引号。
  const target = trimmed.slice(0, trimmed.length - suffix.length).trimEnd().replace(/["']+$/, '');
  if (!target) return false;
  const slash = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  const basename = target.slice(slash + 1);
  return basename === 'cli.js' || basename === 'botmux' || basename === 'botmux.exe';
}

/**
 * 判断某个 hook group 是否是 botmux ask hook（用于幂等替换）。
 *
 * 不能只按命令字符串完全相等比对：同一台机器上 dev 源码 checkout 与 npm global
 * 安装的 cli.js 绝对路径不同，命令字符串就不同，会导致两条 botmux hook 同时残留、
 * 同一次 AskUserQuestion 触发两次 → 飞书发出两张卡。
 * 因此结构化识别：命令是 botmux 自己发起的调用（cli.js 脚本或打包二进制 `botmux`）、
 * 且尾部是相同的 `hook <cliId>` 签名，即视为 botmux hook，无论它指向哪个安装路径、
 * 由 node 还是打包二进制执行。
 */
function isBotmuxAskHookGroup(group: ClaudeHookGroup, hookCommand: string): boolean {
  const suffix = botmuxHookSuffix(hookCommand); // e.g. "hook claude-code"
  return group.hooks.some(
    (e) =>
      e.type === 'command' &&
      (e.command === hookCommand || isBotmuxHookCommand(e.command, suffix)),
  );
}

function removeBotmuxAskHookGroups(
  hooks: Record<string, ClaudeHookGroup[]>,
  eventName: string,
  hookCommand: string,
): void {
  const existing = hooks[eventName] ?? [];
  const filtered = existing.filter((g) => !isBotmuxAskHookGroup(g, hookCommand));
  if (filtered.length === 0) {
    delete hooks[eventName];
  } else {
    hooks[eventName] = filtered;
  }
}

function isBotmuxTraexAskHookEntry(entry: unknown): boolean {
  return !!entry
    && typeof entry === 'object'
    && (entry as ClaudeHookEntry).type === 'command'
    && typeof (entry as ClaudeHookEntry).command === 'string'
    && isBotmuxHookCommand((entry as ClaudeHookEntry).command, 'hook traex');
}

/**
 * TRAE now routes native user-input through its RPC app-server. Remove only
 * legacy botmux `hook traex` entries so they cannot race the RPC bridge and
 * emit a duplicate Ask card. A hook group may contain multiple commands, so
 * strip only the botmux entry and preserve unrelated user hooks in that group.
 */
export function cleanupTraexAskHooks(configPaths: readonly string[]): void {
  for (const candidatePath of configPaths) {
    const configPath = expandHome(candidatePath);
    const settings = readJsonFile<ClaudeSettings>(configPath);
    if (!settings || !isRecord(settings.hooks)) continue;
    const hooks = settings.hooks as Record<string, ClaudeHookGroup[]>;

    let changed = false;
    for (const eventName of ['PreToolUse', 'PermissionRequest']) {
      const existing = hooks[eventName] ?? [];
      if (!Array.isArray(existing)) continue;
      const filtered: ClaudeHookGroup[] = [];
      for (const group of existing) {
        if (!group || !Array.isArray(group.hooks)) {
          filtered.push(group);
          continue;
        }
        const retainedEntries = group.hooks.filter((entry) => !isBotmuxTraexAskHookEntry(entry));
        if (retainedEntries.length === group.hooks.length) {
          filtered.push(group);
        } else {
          changed = true;
          if (retainedEntries.length > 0) filtered.push({ ...group, hooks: retainedEntries });
        }
      }
      if (!changed) continue;
      if (filtered.length === 0) delete hooks[eventName];
      else hooks[eventName] = filtered;
    }
    if (!changed) continue;

    const content = JSON.stringify(settings, null, 2) + '\n';
    writeIfChanged(configPath, content);
    logger.info(`[hook] Removed legacy TRAE ask hook → ${configPath}`);
  }
}

/**
 * 判断某 hook group 是否是 botmux SessionStart 就绪 hook（用于幂等替换）。
 * 同 ask hook：结构化识别（命令是 botmux 自己发起的调用且尾部是 `session-ready`），
 * 不按完整字符串比对——dev checkout 与 npm global 的 cli.js 绝对路径不同。
 */
function isBotmuxReadyHookGroup(group: ClaudeHookGroup): boolean {
  return Array.isArray(group?.hooks) && group.hooks.some(
    (e) =>
      !!e &&
      e.type === 'command' &&
      typeof e.command === 'string' &&
      isBotmuxHookCommand(e.command, 'session-ready'),
  );
}

function removeBotmuxReadyHookGroups(hooks: Record<string, ClaudeHookGroup[]>, eventName: string): void {
  const existing = hooks[eventName] ?? [];
  const filtered = existing.filter((g) => !isBotmuxReadyHookGroup(g));
  if (filtered.length === 0) delete hooks[eventName];
  else hooks[eventName] = filtered;
}

/**
 * 判断某 hook group 是否是 botmux UserPromptSubmit 上下文 hook（用于幂等替换）。
 * 与 ready hook 同策略：结构化识别（命令是 botmux 自己发起的调用且尾部是
 * `user-prompt-hook`），不按完整字符串比对。
 */
function isBotmuxPromptHookGroup(group: ClaudeHookGroup): boolean {
  return Array.isArray(group?.hooks) && group.hooks.some(
    (e) =>
      !!e &&
      e.type === 'command' &&
      typeof e.command === 'string' &&
      isBotmuxHookCommand(e.command, 'user-prompt-hook'),
  );
}

function removeBotmuxPromptHookGroups(hooks: Record<string, ClaudeHookGroup[]>, eventName: string): void {
  const existing = hooks[eventName] ?? [];
  const filtered = existing.filter((g) => !isBotmuxPromptHookGroup(g));
  if (filtered.length === 0) delete hooks[eventName];
  else hooks[eventName] = filtered;
}

/**
 * Read-only preflight used by the worker before it arms the ready gate.
 * Installation is intentionally best-effort, so the gate must not assume that
 * a requested SessionStart hook actually reached the CLI's effective config.
 */
export function hasInstalledSessionReadyHook(hookInstall: HookInstallConfig): boolean {
  if (!hookInstall.sessionStartCommand) return false;
  if (hookInstall.format !== 'claude-settings' && hookInstall.format !== 'grok-hooks') {
    return false;
  }
  const settings = readJsonFile<ClaudeSettings>(expandHome(hookInstall.configPath));
  const groups = settings?.hooks?.SessionStart;
  return Array.isArray(groups) && groups.some(group =>
    Array.isArray(group?.hooks) && group.hooks.some(entry =>
      entry?.type === 'command'
      && entry.command === hookInstall.sessionStartCommand,
    ),
  );
}

/**
 * Read-only preflight: is the botmux UserPromptSubmit hook present in the
 * settings file the CLI actually reads? 结构化匹配（不像
 * hasInstalledSessionReadyHook 那样按完整字符串相等——dev checkout 与 npm global
 * 的 cli.js 路径不同，精确匹配会把已安装的 hook 误判为未安装）。
 */
export function hasInstalledPromptHook(hookInstall: HookInstallConfig): boolean {
  if (!hookInstall.userPromptSubmitCommand) return false;
  if (hookInstall.format !== 'claude-settings') return false;
  return hasInstalledPromptHookAtPath(hookInstall.configPath);
}

/** 按实际 settings 路径做 preflight。read-isolation 下 CLI 经 CLAUDE_CONFIG_DIR
 *  实际读的是 per-bot BOT_HOME/claude/settings.json，不是全局那份——调用方需传入
 *  effective 路径（与 worker 的 effectiveReadyHookInstall 改写同逻辑）。 */
export function hasInstalledPromptHookAtPath(configPath: string): boolean {
  const settings = readJsonFile<ClaudeSettings>(expandHome(configPath));
  const groups = settings?.hooks?.UserPromptSubmit;
  return Array.isArray(groups) && groups.some((group) => isBotmuxPromptHookGroup(group));
}

/**
 * 带 60s TTL 缓存的 preflight——每个 follow-up turn 都会判定一次模式，读文件虽便宜
 * 也没必要每 turn 读。缓存按 configPath 键控（全局 vs per-bot 自然分键）；安装发生在
 * daemon 启动时（ensureCliSkills），60s 内的滞后可接受（最坏情况是新装 hook 后
 * 60s 内仍走 inline）。
 */
const promptHookPreflightCache = new Map<string, { at: number; ok: boolean }>();
const PROMPT_HOOK_PREFLIGHT_TTL_MS = 60_000;

export function hasInstalledPromptHookCached(configPath: string): boolean {
  const now = Date.now();
  const cached = promptHookPreflightCache.get(configPath);
  if (cached && now - cached.at < PROMPT_HOOK_PREFLIGHT_TTL_MS) return cached.ok;
  const ok = hasInstalledPromptHookAtPath(configPath);
  promptHookPreflightCache.set(configPath, { at: now, ok });
  return ok;
}

/**
 * 向 Claude settings.json 的 hooks.PreToolUse 合并 botmux ask hook entry。
 * AskUserQuestion 在 bypassPermissions 模式下不会经过 PermissionRequest，
 * 但 PreToolUse 仍会在工具执行前触发，因此这里必须挂 PreToolUse。
 * 保留其他事件和 entry，不破坏无关配置。
 *
 * 若提供 sessionStartCommand，再把 SessionStart「真就绪」hook 写进 settings.json。
 * 这是 Claude-family 的单一 ready-hook 来源，也覆盖会剥掉进程级 --settings 的
 * wrapperCli=`aiden x claude`。
 */
function installClaudeSettings(
  configPath: string,
  hookCommand: string,
  sessionStartCommand?: string,
  inheritClaudeEnvFrom?: string,
  userPromptSubmitCommand?: string,
): void {
  const settings: ClaudeSettings = readJsonFile<ClaudeSettings>(configPath) ?? {};
  let inheritedEnvState: { path: string; content: string } | undefined;
  if (inheritClaudeEnvFrom) {
    const source = readJsonFile<ClaudeSettings>(expandHome(inheritClaudeEnvFrom));
    // A malformed/unreadable shared file is treated as a transient failure: do
    // not erase the last known-good inherited env. A valid file with no `env`,
    // however, is an authoritative deletion and must remove previously copied
    // keys from the per-bot settings.
    if (source) {
      const inheritedStatePath = `${configPath}.botmux-inherited-env.json`;
      const previousState = readJsonFile<InheritedClaudeEnvState>(inheritedStatePath);
      const previousInheritedKeys = previousState?.version === 1 && Array.isArray(previousState.keys)
        ? previousState.keys.filter((key): key is string => typeof key === 'string')
        : [];
      const localEnv = isRecord(settings.env) ? { ...settings.env } : {};
      for (const key of previousInheritedKeys) delete localEnv[key];

      const sharedEnv = isRecord(source.env) ? source.env : {};
      const mergedEnv = { ...localEnv, ...sharedEnv };
      if (Object.keys(mergedEnv).length > 0) settings.env = mergedEnv;
      else delete settings.env;

      // Track exactly which keys came from the shared file so a later cold
      // spawn can propagate deletions without discarding per-bot-only entries.
      inheritedEnvState = {
        path: inheritedStatePath,
        content: `${JSON.stringify({ version: 1, keys: Object.keys(sharedEnv).sort() }, null, 2)}\n`,
      };
    }
  }
  const existingHooks = settings.hooks ?? {};

  // 构造 botmux PreToolUse hook group（只拦截 AskUserQuestion）
  const newEntry: ClaudeHookEntry = { type: 'command', command: hookCommand, timeout: 86400 };
  const newGroup: ClaudeHookGroup = { matcher: 'AskUserQuestion', hooks: [newEntry] };

  // 过滤掉旧的 botmux ask hook group（幂等 + 从 PermissionRequest 迁移到 PreToolUse）
  removeBotmuxAskHookGroups(existingHooks, 'PermissionRequest', hookCommand);
  removeBotmuxAskHookGroups(existingHooks, 'PreToolUse', hookCommand);
  existingHooks['PreToolUse'] = [...(existingHooks['PreToolUse'] ?? []), newGroup];

  // SessionStart 就绪 hook（幂等替换旧的 botmux 条目）
  if (sessionStartCommand) {
    removeBotmuxReadyHookGroups(existingHooks, 'SessionStart');
    existingHooks['SessionStart'] = [
      ...(existingHooks['SessionStart'] ?? []),
      { hooks: [{ type: 'command', command: sessionStartCommand }] },
    ];
  }

  // UserPromptSubmit per-turn 上下文 hook（#794，幂等替换旧的 botmux 条目）。
  // timeout 10s：hook 本身是纯文件读，10s 足够；防任何意外挂起。
  if (userPromptSubmitCommand) {
    removeBotmuxPromptHookGroups(existingHooks, 'UserPromptSubmit');
    existingHooks['UserPromptSubmit'] = [
      ...(existingHooks['UserPromptSubmit'] ?? []),
      { hooks: [{ type: 'command', command: userPromptSubmitCommand, timeout: 10 }] },
    ];
  }

  settings.hooks = existingHooks;
  const content = JSON.stringify(settings, null, 2) + '\n';
  // An inherited env can contain provider credentials. Keep the per-bot copy
  // owner-only even if the pre-existing hook-only file was created as 0644.
  const changed = writeIfChanged(configPath, content, inheritClaudeEnvFrom ? 0o600 : undefined);
  if (inheritedEnvState) {
    // Publish the ownership record only after the corresponding settings write
    // succeeds, so a failed settings update cannot claim per-bot keys as shared.
    writeIfChanged(inheritedEnvState.path, inheritedEnvState.content, 0o600);
  }
  if (changed) {
    logger.info(`[hook] 已写入 Claude hook → ${configPath}`);
  } else {
    logger.info(`[hook] Claude hook 已是最新，跳过写入 → ${configPath}`);
  }
}

// ─── OpenCode plugin 格式 ─────────────────────────────────────────────────────

/**
 * 构造 botmux ask 的 OpenCode 插件内容。
 *
 * 机制（已在 OpenCode 1.17.x 实机验证）：
 *   - OpenCode 自带原生 `question` 工具（= Claude AskUserQuestion 等价物），模型会原生
 *     调用，无需我们注入。它被调用时，服务端发布 `question.asked` 事件并阻塞，等客户端
 *     把答案提交到 `/question/{id}/reply`（body `{ answers }`）后才解阻塞、返回给模型。
 *   - OpenCode 插件 API 没有 `question.asked` 这种专用钩子；要拦截只能用通用 `event` 钩子
 *     按 `event.type === 'question.asked'` 过滤（plugin 导出必须是「函数」而非对象）。
 *
 * 事件 payload 形状：
 *   { type:'question.asked', properties:{ id:'que_…', sessionID:'ses_…',
 *     questions:[{ question, header, options:[{label,description}], multiple? }] } }
 *
 * 转发策略：把 questions 规范成 `botmux hook opencode` 认识的 payload 喂给它（复用现有
 * 飞书问答链路：daemon /api/asks → 飞书卡片 → 用户作答 → directive），拿到 stdout 里的
 * `{ answers }` 后回传给 OpenCode 解阻塞。
 *   - **回传必须走 OpenCode 注入给插件的 client（`client._client`）**，不能用裸 fetch：
 *     OpenCode 是「单 server 多 worktree 实例」模型，client 自带 `x-opencode-directory`
 *     头把 reply 路由到发起 question 的那个实例，且其传输在 daemon 里实际可达
 *     （裸 fetch 到 `localhost:4096` 在 daemon 里连不上 + 缺 directory 头 → 永远卡 picker）。
 *   - **异步**作答：飞书侧作答可能耗时很久（默认上限 1h），绝不能用 spawnSync 同步阻塞
 *     OpenCode 的单线程事件总线（会冻结整个 TUI）。改用异步 spawn + fire-and-forget。
 *   - stdout 为空（passthrough：daemon 不可达 / 超时 / 非 botmux 会话）→ 不 reply，把问题
 *     留给 OpenCode 原生 picker（botmux web 终端里仍可人工作答）。
 */
/**
 * Injected into BOTH generated plugin templates (V1 and V2).
 *
 * ⚠️ Emit this wherever `loopbackSafeFetch` is CALLED. It was first added to the
 * V2 template only, while the V1 fallback call was switched over too — the V1
 * plugin then died with `ReferenceError: loopbackSafeFetch is not defined` the
 * moment it took that path. "Changed the call, forgot the definition" is the
 * classic generated-template defect, so the definition lives in one constant and
 * is interpolated into every template that uses it.
 *
 * Why it exists at all: these plugins run inside OpenCode's **Bun** process, and
 * Bun's `fetch` auto-uses `$http_proxy` while `no_proxy` is literal-match only
 * (no CIDR, and `localhost` does not cover `127.0.0.1`). On a corporate dev box a
 * request to the LOCAL serve is handed to the proxy — the ask reply fails AND the
 * Basic password from the registration file is sent to the proxy. A generated file
 * cannot import repo helpers, so this is a minimal inline version; remote,
 * user-configurable URLs still use the native fetch.
 */
const LOOPBACK_SAFE_FETCH_SNIPPET = `
// 本机 loopback 请求绝不能走全局 fetch。这段代码跑在 OpenCode 的 **Bun** 进程里，
// 而 Bun 的 fetch 会自动使用 $http_proxy，且 no_proxy 只做字面量匹配（不解析 CIDR，
// 也不把 localhost 当作覆盖 127.0.0.1）。公司内网开发机普遍 export 这种组合，于是
// 打本机 serve 的请求被交给公司代理：不只是回答 ask 失败，注册文件里的 Basic 口令
// 也会随请求发给代理。这里不能 import 仓库里的 helper（本文件是**生成**到插件目录的
// 独立脚本），所以内联一份最小实现；远端可配置 URL 仍走原生 fetch，只有字面量
// loopback 才切到 node:http（它完全无视代理 env）。
function isLiteralLoopback(u) {
  try {
    const p = new URL(u);
    // http: only — this helper is node:http, so claiming an https: URL is
    // loopback-safe would pick a transport that cannot serve it.
    if (p.protocol !== "http:") return false;
    // URL.hostname keeps IPv6 bracketed; node:http wants the bare address.
    const h = p.hostname.startsWith("[") && p.hostname.endsWith("]")
      ? p.hostname.slice(1, -1) : p.hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch { return false; }
}
async function loopbackSafeFetch(url, init) {
  if (!isLiteralLoopback(url)) return fetch(url, init);
  const http = await import("node:http");
  const t = new URL(url);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      { host: (() => {
          const h = t.hostname.startsWith("[") && t.hostname.endsWith("]")
            ? t.hostname.slice(1, -1) : t.hostname;
          return h === "localhost" ? "127.0.0.1" : h;
        })(),
        port: t.port || 80, path: t.pathname + t.search,
        method: (init && init.method) || "GET", headers: (init && init.headers) || {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: async () => buf.toString("utf8"),
            json: async () => JSON.parse(buf.toString("utf8")),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (init && init.body) req.end(init.body); else req.end();
  });
}
`;

function buildOpenCodePlugin(parts: { cmd: string; args: string[] }): string {
  // 用 argv 形式嵌入（不拼 shell 字符串、不 split）：含空格/引号的路径也不会被拆坏。
  const cmdLit = JSON.stringify(parts.cmd);
  const argsLit = JSON.stringify(parts.args);
  return `// botmux-ask opencode plugin
// 监听 OpenCode 原生 \`question\` 工具触发的 \`question.asked\` 事件，转发到
// \`botmux hook opencode\`（飞书问答），再把答案 POST 回 OpenCode 解阻塞。
import { spawn } from "child_process";
import { appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CMD = ${cmdLit};
const ARGS = ${argsLit};

// 诊断日志：默认关闭，设 BOTMUX_OPENCODE_ASK_DEBUG=1 后每步落盘到
// ~/.botmux/opencode-ask-debug.log，用于排查 ask 链路（事件→转发→reply）。
const DBG_ON = !!process.env.BOTMUX_OPENCODE_ASK_DEBUG;
const DBG = join(homedir(), ".botmux", "opencode-ask-debug.log");
function dbg(m) {
  if (!DBG_ON) return;
  try { appendFileSync(DBG, new Date().toISOString() + " " + m + "\\n"); } catch {}
}

// 异步 spawn \`botmux hook opencode\`：stdin 喂 payload，收集 stdout。
// 任何失败都 resolve("")（= passthrough 放行）。child 自带超时（hook 客户端按
// BOTMUX_ASK_TIMEOUT_MS 自限），这里再加 25h 兜底 kill 防僵尸（unref 不拖住事件循环）。
function askBotmux(payload) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawn(CMD, ARGS, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return done("");
    }
    const backstop = setTimeout(() => { try { child.kill(); } catch {} done(""); }, 90000000);
    if (typeof backstop.unref === "function") backstop.unref();
    child.stdout.on("data", (d) => { out += d.toString("utf-8"); });
    child.on("error", () => { clearTimeout(backstop); done(""); });
    child.on("close", (code) => { clearTimeout(backstop); done(code === 0 ? out : ""); });
    try { child.stdin.write(payload); child.stdin.end(); } catch { clearTimeout(backstop); done(""); }
  });
}

// 把答案回传给 OpenCode 解阻塞。
// 必须走 OpenCode 自带的 client（client._client = 已配置的 hey-api client）——
// 它带着 \`x-opencode-directory\` 头与正确的 baseUrl/传输。OpenCode 用「单 server 多
// worktree 实例」模型，该头用于把 reply 路由到发起 question 的那个实例；裸 fetch 缺这个
// 头会打到错误实例（question 找不到 → 永远卡在 picker）。失败再回落裸 fetch（复制其 headers）。
function safeStr(x) {
  try { return String(JSON.stringify(x)).slice(0, 120); } catch { return String(x); }
}

${LOOPBACK_SAFE_FETCH_SNIPPET}
async function postReply(client, serverUrl, id, answers) {
  const body = { answers };
  // 1) 经 client._client（带 directory 头 + 正确传输）。这是 daemon 多实例下唯一可达的路径：
  //    裸 fetch 到 localhost:4096 在 daemon 里根本连不上（OpenCode 用 interceptor 传输）。
  try {
    const c = client && client._client;
    if (c && typeof c.post === "function") {
      const res = await c.post({ url: "/question/" + id + "/reply", body });
      const st = res && res.response && res.response.status;
      const success = (res && res.data === true) || (st && st >= 200 && st < 300);
      dbg("CLIENT_POST id=" + id + " status=" + st + " data=" + safeStr(res && res.data) + " err=" + safeStr(res && res.error));
      if (success) return true;
    } else {
      dbg("CLIENT_POST_UNAVAILABLE id=" + id);
    }
  } catch (e) { dbg("CLIENT_POST_THREW id=" + id + " err=" + String(e)); }
  // 2) 回落裸 fetch，尽量复制 client 的 headers（含 directory）与 baseUrl
  try {
    let base = String(serverUrl).replace(/\\/+$/, "");
    let headers = { "content-type": "application/json" };
    try {
      const cfg = client && client._client && client._client.getConfig && client._client.getConfig();
      if (cfg) {
        if (cfg.baseUrl) base = String(cfg.baseUrl).replace(/\\/+$/, "");
        if (cfg.headers) headers = Object.assign({}, cfg.headers, { "content-type": "application/json" });
      }
    } catch {}
    const url = base + "/question/" + id + "/reply";
    dbg("FETCH_POST url=" + url + " headers=" + Object.keys(headers).join(","));
    const r = await loopbackSafeFetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    let txt = ""; try { txt = await r.text(); } catch {}
    dbg("FETCH_POST_RESULT id=" + id + " status=" + r.status + " body=" + txt.slice(0, 150));
    return r.ok;
  } catch (e) { dbg("FETCH_POST_THREW id=" + id + " err=" + String(e)); return false; }
}

export const BotmuxAsk = async ({ client, serverUrl }) => {
  dbg("PLUGIN_LOADED serverUrl=" + serverUrl + " hasClient=" + !!(client && client._client));
  return {
    event: async ({ event }) => {
      if (!event || event.type !== "question.asked") return;
      const props = event.properties || {};
      const id = props.id;
      const questions = props.questions;
      dbg("EVENT question.asked id=" + id + " sessionID=" + props.sessionID + " nQ=" + (Array.isArray(questions) ? questions.length : "?"));
      if (!id || !Array.isArray(questions) || questions.length === 0) { dbg("SKIP missing id/questions"); return; }
      // fire-and-forget：不 await，避免阻塞事件总线（飞书作答可能很久）。
      // 问题在服务端独立阻塞，答案经 reply 回去即可解阻塞。
      (async () => {
        const payload = JSON.stringify({
          hook_event_name: "question.asked",
          question_id: id,
          session_id: props.sessionID,
          tool_input: { questions },
        });
        dbg("SPAWN botmux hook opencode id=" + id);
        const stdout = (await askBotmux(payload)).trim();
        dbg("HOOK_STDOUT id=" + id + " len=" + stdout.length + " body=" + stdout.slice(0, 300));
        if (!stdout) { dbg("PASSTHROUGH empty stdout id=" + id); return; } // passthrough/超时 → 不应答，留给原生 picker
        let directive;
        try { directive = JSON.parse(stdout); } catch (e) { dbg("PARSE_FAIL id=" + id + " err=" + String(e)); return; }
        const answers = directive && directive.answers;
        if (!Array.isArray(answers)) { dbg("NO_ANSWERS id=" + id + " directive=" + JSON.stringify(directive).slice(0, 200)); return; }
        dbg("REPLY id=" + id + " answers=" + JSON.stringify(answers));
        const ok = await postReply(client, serverUrl, id, answers);
        dbg("REPLY_DONE id=" + id + " ok=" + ok);
      })().catch((e) => { dbg("HANDLER_ERR id=" + id + " err=" + String(e)); });
    },
  };
};
`;
}

/**
 * 写入 OpenCode 插件文件。幂等：内容相同则跳过。
 */
function installOpenCodePlugin(configPath: string, parts: { cmd: string; args: string[] }): void {
  const content = buildOpenCodePlugin(parts);
  const changed = writeIfChanged(configPath, content);
  if (changed) {
    logger.info(`[hook] 已写入 OpenCode 插件 → ${configPath}`);
  } else {
    logger.info(`[hook] OpenCode 插件已是最新，跳过写入 → ${configPath}`);
  }
}

// ─── OpenCode 2.0（opencode2）插件 ───────────────────────────────────────────
//
// V2 插件 API 与 V1 完全不兼容（V1 插件格式在 V2 里会被 loader 拒绝，日志报
// `Missing key at ["default"]["setup"]`）：module 必须 default export
// `{ id, setup }`，事件监听走 `setup(ctx)` 里 `ctx.event.subscribe()` 返回的
// **异步迭代流**（不是回调！回调会被静默忽略）。V2 插件文件放在全局发现目录
// `~/.config/opencode/plugins/`（复数）。
//
// V2 事件形状：`{ id:'evt_…', created, type:'question.asked',
//   location:{ directory:'…' }, data:{ id:'que_…', sessionID:'ses_…', questions:[…], tool } }`
// （openapi 的 question.asked 变体；questions 结构与 V1 相同）。
//
// 回传答案与 V1 不同：
//   - 端点是 **session-scoped** 的 `POST {base}/api/session/{sessionID}/question/{requestID}/reply`
//     （body `{ answers: string[][] }`，成功 204）。
//   - 服务地址/凭证从注册文件发现：`$XDG_STATE_HOME/opencode/service.json`（默认
//     `~/.local/state/opencode/service.json`）→ `{ url, password }`，Basic auth
//     用户名固定 `opencode`。opencode2 的托管后台服务（`serve --service`）会写这个
//     文件；`--standalone` 私有服务不注册，此时插件读不到 → 放行给原生 picker。
//   - 必须带 `x-opencode-directory` 头（= 事件 location.directory）：共享服务是
//     「单 server 多 worktree 实例」，缺该头 reply 会路由到 process.cwd() 的实例，
//     找不到 request → 永远卡 picker。
function buildOpenCode2Plugin(parts: { cmd: string; args: string[] }): string {
  const cmdLit = JSON.stringify(parts.cmd);
  const argsLit = JSON.stringify(parts.args);
  return `// botmux-ask opencode2 plugin
// 监听 OpenCode 2.0 原生 \`question\` 工具触发的 \`question.asked\` 事件（事件流
// ctx.event.subscribe() 异步迭代），转发到 \`botmux hook opencode2\`（飞书问答），
// 再把答案 POST 回 session-scoped reply 端点解阻塞。
import { spawn } from "child_process";
import { readFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CMD = ${cmdLit};
const ARGS = ${argsLit};

// 诊断日志：默认关闭，设 BOTMUX_OPENCODE_ASK_DEBUG=1 后每步落盘到
// ~/.botmux/opencode2-ask-debug.log，用于排查 ask 链路（事件→转发→reply）。
const DBG_ON = !!process.env.BOTMUX_OPENCODE_ASK_DEBUG;
const DBG = join(homedir(), ".botmux", "opencode2-ask-debug.log");
function dbg(m) {
  if (!DBG_ON) return;
  try { appendFileSync(DBG, new Date().toISOString() + " " + m + "\\n"); } catch {}
}

// 异步 spawn \`botmux hook opencode2\`：stdin 喂 payload，收集 stdout。
// 任何失败都 resolve("")（= passthrough 放行）。child 自带超时（hook 客户端按
// BOTMUX_ASK_TIMEOUT_MS 自限），这里再加 25h 兜底 kill 防僵尸（unref 不拖住事件循环）。
function askBotmux(payload) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawn(CMD, ARGS, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return done("");
    }
    const backstop = setTimeout(() => { try { child.kill(); } catch {} done(""); }, 90000000);
    if (typeof backstop.unref === "function") backstop.unref();
    child.stdout.on("data", (d) => { out += d.toString("utf-8"); });
    child.on("error", () => { clearTimeout(backstop); done(""); });
    child.on("close", (code) => { clearTimeout(backstop); done(code === 0 ? out : ""); });
    try { child.stdin.write(payload); child.stdin.end(); } catch { clearTimeout(backstop); done(""); }
  });
}

// 服务注册文件发现：托管后台服务（serve --service）把 { url, password } 写进
// $XDG_STATE_HOME/opencode/service.json（默认 ~/.local/state/opencode/service.json）
// —— 只认这一个位置，无其它 fallback。插件运行在服务进程内，同一宿主直接读文件
// 即可；读不到（--standalone 私有服务/首次启动）→ null → 放行给原生 picker。
function readRegistration() {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  try {
    const raw = readFileSync(join(state, "opencode", "service.json"), "utf8");
    const j = JSON.parse(raw);
    if (typeof j.url === "string" && j.url) return j;
  } catch {}
  return null;
}

// 把答案回传给 OpenCode 2.0 解阻塞。必须带 x-opencode-directory 头（多 worktree
// 路由），带注册文件里的 Basic auth。
${LOOPBACK_SAFE_FETCH_SNIPPET}
async function postReply(directory, sessionID, requestID, answers) {
  const reg = readRegistration();
  if (!reg) { dbg("NO_REGISTRATION id=" + requestID); return; }
  const headers = { "content-type": "application/json" };
  try {
    if (reg.password) headers.authorization = "Basic " + Buffer.from("opencode:" + reg.password, "utf-8").toString("base64");
  } catch {}
  if (directory) headers["x-opencode-directory"] = directory;
  const base = String(reg.url).replace(/\\/+$/, "");
  const url = base + "/api/session/" + encodeURIComponent(sessionID) + "/question/" + encodeURIComponent(requestID) + "/reply";
  dbg("POST_REPLY id=" + requestID + " url=" + url);
  try {
    const r = await loopbackSafeFetch(url, { method: "POST", headers, body: JSON.stringify({ answers }) });
    let txt = ""; try { txt = await r.text(); } catch {}
    dbg("REPLY_DONE id=" + requestID + " status=" + r.status + " body=" + txt.slice(0, 150));
    if (!r.ok) dbg("REPLY_NON_OK id=" + requestID + " status=" + r.status + " body=" + txt.slice(0, 150));
  } catch (e) { dbg("REPLY_ERR id=" + requestID + " err=" + String(e)); }
}

export default {
  id: "botmux.ask",
  setup: async (ctx) => {
    dbg("PLUGIN_LOADED hasEvent=" + !!(ctx && ctx.event && typeof ctx.event.subscribe === "function"));
    if (!ctx || !ctx.event || typeof ctx.event.subscribe !== "function") return;
    const iterator = ctx.event.subscribe();
    const consume = async () => {
      for await (const ev of iterator) {
        if (!ev || ev.type !== "question.asked") continue;
        const data = ev.data || {};
        const id = data.id;
        const sessionID = data.sessionID;
        const questions = data.questions;
        const directory = (ev.location && ev.location.directory) || "";
        dbg("EVENT question.asked id=" + id + " sessionID=" + sessionID + " nQ=" + (Array.isArray(questions) ? questions.length : "?"));
        if (!id || !sessionID || !Array.isArray(questions) || questions.length === 0) { dbg("SKIP missing id/sessionID/questions"); continue; }
        // fire-and-forget：不 await，避免阻塞事件消费（飞书作答可能很久）。
        // 问题在服务端独立阻塞，答案经 reply 回去即可解阻塞。
        (async () => {
          const payload = JSON.stringify({
            hook_event_name: "question.asked",
            question_id: id,
            session_id: sessionID,
            tool_input: { questions },
          });
          dbg("SPAWN botmux hook opencode2 id=" + id);
          const stdout = (await askBotmux(payload)).trim();
          dbg("HOOK_STDOUT id=" + id + " len=" + stdout.length + " body=" + stdout.slice(0, 300));
          if (!stdout) { dbg("PASSTHROUGH empty stdout id=" + id); return; } // passthrough/超时 → 不应答，留给原生 picker
          let directive;
          try { directive = JSON.parse(stdout); } catch (e) { dbg("PARSE_FAIL id=" + id + " err=" + String(e)); return; }
          const answers = directive && directive.answers;
          if (!Array.isArray(answers)) { dbg("NO_ANSWERS id=" + id + " directive=" + JSON.stringify(directive).slice(0, 200)); return; }
          await postReply(directory, sessionID, id, answers);
        })().catch((e) => { dbg("HANDLER_ERR id=" + id + " err=" + String(e)); });
      }
    };
    consume().catch((e) => { dbg("STREAM_ERR " + String(e)); });
  },
};
`;
}

/**
 * 写入 OpenCode 2.0 插件文件（V2 插件 API）。幂等：内容相同则跳过。
 */
function installOpenCode2Plugin(configPath: string, parts: { cmd: string; args: string[] }): void {
  const content = buildOpenCode2Plugin(parts);
  const changed = writeIfChanged(configPath, content);
  if (changed) {
    logger.info(`[hook] 已写入 OpenCode 2.0 插件 → ${configPath}`);
  } else {
    logger.info(`[hook] OpenCode 2.0 插件已是最新，跳过写入 → ${configPath}`);
  }
}

// ─── Grok hooks/*.json 格式 ───────────────────────────────────────────────────
//
// Grok discovers global hooks from `~/.grok/hooks/*.json` (always trusted).
// Schema:
//   { "hooks": { "SessionStart": [ { "hooks": [ { "type":"command", "command":"..." } ] } ] } }
// We only install SessionStart → `botmux session-ready` for the ready-gate.
// Grok has no AskUserQuestion-equivalent hook today, so ask still uses the
// botmux-ask skill / prompt catalog path.

function installGrokHooks(configPath: string, sessionStartCommand: string | undefined): void {
  if (!sessionStartCommand) {
    logger.info(`[hook] grok-hooks 未提供 sessionStartCommand，跳过 → ${configPath}`);
    return;
  }
  const doc = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: sessionStartCommand,
              // Fail-open: Grok ignores hook failures for lifecycle events.
              // Exit 0 when BOTMUX_* env is missing so standalone `grok` is quiet.
            },
          ],
        },
      ],
    },
  };
  const content = JSON.stringify(doc, null, 2) + '\n';
  const changed = writeIfChanged(configPath, content);
  if (changed) {
    logger.info(`[hook] 已写入 Grok SessionStart ready hook → ${configPath}`);
  } else {
    logger.info(`[hook] Grok ready hook 已是最新，跳过写入 → ${configPath}`);
  }
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

/**
 * 幂等地将 botmux ask hook 安装到指定 CLI 的配置文件。
 *
 * @param cliId - CLI 标识符（用于日志）
 * @param hookInstall - adapter 提供的安装描述（configPath + format）
 * @param hookCommand - botmux hook 子命令的完整调用字符串
 *                      例如："/usr/bin/node /path/to/cli.js hook claude-code"
 */
export function installHook(
  cliId: string,
  hookInstall: HookInstallConfig,
  hookCommand: string,
): void {
  try {
    const configPath = expandHome(hookInstall.configPath);
    switch (hookInstall.format) {
      case 'claude-settings':
        installClaudeSettings(
          configPath,
          hookCommand,
          hookInstall.sessionStartCommand,
          hookInstall.inheritClaudeEnvFrom,
          hookInstall.userPromptSubmitCommand,
        );
        break;
      case 'opencode-plugin':
        // OpenCode 插件走 argv parts（异步 spawn），不复用 shell 字符串，避免被 split 拆坏。
        installOpenCodePlugin(configPath, hookCommandParts(cliId));
        break;
      case 'opencode2-plugin':
        // OpenCode 2.0 插件走 argv parts（异步 spawn），新插件 API（见 buildOpenCode2Plugin）。
        installOpenCode2Plugin(configPath, hookCommandParts(cliId));
        break;
      case 'grok-hooks':
        // Grok has no ask-hook surface yet; only SessionStart ready-gate.
        installGrokHooks(configPath, hookInstall.sessionStartCommand);
        break;
      default: {
        // TypeScript exhaustiveness（编译时保障，运行时防御）
        const _exhaustive: never = hookInstall.format;
        logger.warn(`[hook] 未知 format：${_exhaustive}，跳过 ${cliId}`);
      }
    }
  } catch (err: any) {
    logger.warn(`[hook] install failed for ${cliId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
