/**
 * Command handler — processes /slash commands from users.
 * Extracted from daemon.ts for modularity.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { config } from '../config.js';
import { getBot, getAllBots, getBotOpenId } from '../bot-registry.js';
import * as sessionStore from '../services/session-store.js';
import * as scheduleStore from '../services/schedule-store.js';
import * as scheduler from './scheduler.js';
import { scanProjects, scanMultipleProjects, describeProjectDir } from '../services/project-scanner.js';
import { buildRepoSelectCard, buildAdoptSelectCard, buildSessionClosedCard, getCliDisplayName } from '../im/lark/card-builder.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { deleteMessage, sendMessage, listChatBotMembers, getChatMode } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';
import { killWorker, forkWorker, forkAdoptWorker, getCurrentCliVersion, postFreshStreamingCard, postPrivateSnapshotCard, resolvePrivateCardAudience } from './worker-pool.js';
import { expandHome, getSessionWorkingDir, getProjectScanDir, getProjectScanDirs, rememberLastCliInput } from './session-manager.js';
import { validateWorkingDir } from './working-dir.js';
import { discoverAdoptableSessions, validateAdoptTarget, type AdoptableSession } from './session-discovery.js';
import { generateAuthUrl, getTokenStatus } from '../utils/user-token.js';
import { bindOncall, unbindOncall, getOncallStatus } from '../services/oncall-store.js';
import { invalidWorkingDirs } from '../utils/working-dir.js';
import { resolveRoleFile, writeRoleFile, deleteRoleFile } from './role-resolver.js';
import type { LarkMessage, DaemonToWorker } from '../types.js';
import { sessionKey, sessionAnchorId } from './types.js';
import type { DaemonSession } from './types.js';
import { t, localeForBot, type Locale } from '../i18n/index.js';

// ─── Exported constants ──────────────────────────────────────────────────────

export const DAEMON_COMMANDS = new Set(['/close', '/restart', '/status', '/help', '/cd', '/repo', '/skip', '/schedule', '/role', '/login', '/adopt', '/oncall', '/group', '/g', '/card']);

/**
 * Slash commands that are forwarded verbatim to the underlying CLI (e.g.
 * Claude Code's `/compact`, `/model`, `/usage`). The daemon does NOT handle
 * these — it just relays them to the worker via a raw_input IPC message,
 * bypassing the normal prompt-wrapping and bracketed-paste path so the CLI's
 * own slash-command parser sees them.
 */
export const PASSTHROUGH_COMMANDS = new Set([
  '/compact', '/model', '/clear', '/plugin', '/usage',
  // 只读 / 低副作用，飞书卡片里能直接吐文本：
  '/context', '/cost', '/mcp', '/diff',
  '/code-review', '/security-review', '/review',
  // Codex：/btw 向当前会话追加一条旁注/引导消息
  '/btw',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

export interface SlashCommandInvocation {
  cmd: string;
  content: string;
}

const MULTILINE_COMMANDS = new Set(['/schedule', '/role']);

// `validateWorkingDir` now lives in ./working-dir.js (leaf module the CLI can
// import without the daemon graph); re-exported here for existing callers.
export { validateWorkingDir };

/**
 * Resolve a non-numeric `/repo <arg>` into a concrete repo path + display name.
 * `arg` is either a path (absolute or relative) or a first-level project name
 * under one of the bot's scan dirs — letting the user skip the selection card.
 *
 * Resolution:
 *   1. Build candidate absolute paths — absolute / `~` taken as-is; relative or
 *      bare names resolved against each scan dir, then the daemon cwd (mirrors
 *      how the card's project list is rooted).
 *   2. Prefer a candidate matching a scanned git project (carries a branch label).
 *   3. For a bare name, also match a scanned project by basename (covers projects
 *      nested deeper than the scan-dir top level).
 *   4. Fall back to any existing directory — lenient like `/cd`, whose trust model
 *      is "owner explicitly chose a dir"; the CLI already runs with full FS access.
 * Returns null when nothing resolves to an existing directory.
 */
export function resolveRepoSelection(
  repoArg: string,
  scanDirs: string[],
): { path: string; displayName: string } | null {
  const existingScanDirs = scanDirs.filter((d) => existsSync(d));
  const projects = existingScanDirs.length > 0 ? scanMultipleProjects(existingScanDirs) : [];

  const isExplicitPath =
    repoArg.startsWith('/') ||
    repoArg.startsWith('~') ||
    repoArg.startsWith('.') ||
    repoArg.includes('/');

  const candidates: string[] = [];
  if (repoArg.startsWith('/') || repoArg.startsWith('~')) {
    candidates.push(resolve(expandHome(repoArg)));
  } else {
    for (const d of scanDirs) candidates.push(resolve(d, repoArg));
    candidates.push(resolve(expandHome(repoArg))); // daemon-cwd fallback (matches /cd)
  }

  // 1) Exact scanned-project match — preferred, gives the "name (branch)" label.
  for (const cand of candidates) {
    const proj = projects.find((p) => resolve(p.path) === cand);
    if (proj) return { path: proj.path, displayName: `${proj.name} (${proj.branch})` };
  }
  // 2) Bare name → match a scanned project by basename.
  if (!isExplicitPath) {
    const byName = projects.find((p) => p.name === repoArg);
    if (byName) return { path: byName.path, displayName: `${byName.name} (${byName.branch})` };
  }
  // 3) Lenient fallback: any existing directory. Label it with a git ref when
  //    it's a repo (covers explicit paths outside the scan roots), else basename.
  for (const cand of candidates) {
    try {
      if (!statSync(cand).isDirectory()) continue;
    } catch {
      continue; // missing / not a dir — try next candidate
    }
    const desc = describeProjectDir(cand);
    return desc
      ? { path: cand, displayName: `${desc.name} (${desc.branch})` }
      : { path: cand, displayName: basename(cand) };
  }
  return null;
}

/**
 * Parse a force-topic invocation: `/t [prompt]` or `/topic [prompt]`.
 *
 * This is a routing meta-command, distinct from `parseSlashCommandInvocation`
 * (which routes to daemon command handlers). The match conditions are
 * deliberately tighter than the regular slash parser:
 *
 * - exact-prefix match (`/t` / `/topic`, case-insensitive); `/tea` / `/topical`
 *   must NOT match, otherwise we'd false-trigger on common /-prefixed words.
 * - tolerates leading whitespace (mention-stripping can leave a space).
 * - prompt is whatever follows the prefix (verbatim, including newlines).
 * - `/t` alone (no args) is allowed → empty prompt; the user can fill it in
 *   while the repo selection card is still pending.
 *
 * Returns null for anything else, so callers can fall through to the regular
 * `parseSlashCommandInvocation` / message-handling path.
 */
export function parseForceTopicInvocation(content: string): { prompt: string } | null {
  const trimmed = content.replace(/^\s+/, '');
  const match = /^\/(t|topic)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return null;
  return { prompt: (match[2] ?? '').trim() };
}

/** Parse a user-authored slash command after leading @mentions have already
 *  been stripped. Messages that look like command examples or command lists
 *  are intentionally left for the CLI instead of being intercepted by the
 *  daemon; otherwise discussion text such as `/adopt <pane>` can accidentally
 *  trigger real daemon actions. */
export function parseSlashCommandInvocation(content: string): SlashCommandInvocation | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('/')) return null;

  const lines = trimmed.split(/\r?\n/);
  const firstLine = (lines[0] ?? '').trimEnd();
  const [cmdRaw] = firstLine.split(/\s+/);
  const cmd = cmdRaw?.toLowerCase();
  if (!cmd) return null;

  // Treat angle-bracket placeholders as documentation, not an invocation.
  if (/<[^>\r\n]+>/.test(firstLine)) return null;

  const restNonBlank = lines.slice(1).map(l => l.trim()).filter(Boolean);
  if (restNonBlank.length > 0) {
    // A list of slash commands is almost certainly discussion / planning text.
    if (restNonBlank.some(l => l.startsWith('/'))) return null;
    if (!MULTILINE_COMMANDS.has(cmd)) return null;
  }

  return { cmd, content: trimmed };
}

function tag(ds: DaemonSession): string {
  return ds.session.sessionId.substring(0, 8);
}

/**
 * Lowercased display names of ALL bots known to the deployment, read from the
 * shared bots-info.json. This is the only globally-complete, process-stable
 * source of "is this @-mention a bot?": production runs one daemon per bot, so
 * getAllBots() only sees this process's own bot, and the live chat-member roster
 * (listChatBotMembers) can transiently miss a bot — either would let competing
 * bot processes disagree on who the first @-mentioned bot is and double-create.
 * bots-info.json is a local file merge-written by every daemon at startup.
 */
function globalKnownBotNames(): Set<string> {
  try {
    const p = join(config.session.dataDir, 'bots-info.json');
    if (!existsSync(p)) return new Set();
    const entries: Array<{ botName?: string | null }> = JSON.parse(readFileSync(p, 'utf-8'));
    return new Set(entries.map(e => e.botName?.toLowerCase()).filter((n): n is string => !!n));
  } catch {
    return new Set();
  }
}

/** Human-friendly name for a bot larkAppId — Lark app display name, else cliId, else the raw id. */
function botDisplayName(larkAppId: string): string {
  try {
    const bot = getBot(larkAppId);
    return bot.botName ?? getCliDisplayName(bot.config.cliId) ?? larkAppId;
  } catch {
    return larkAppId;
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function invalidConfiguredWorkingDirs(ds: DaemonSession | undefined, larkAppId: string | undefined): string[] {
  if (ds?.workingDir) return invalidWorkingDirs({ workingDir: ds.workingDir });
  if (larkAppId) {
    const bot = getBot(larkAppId);
    return invalidWorkingDirs({
      workingDir: bot.config.workingDir ?? '~',
      workingDirs: bot.config.workingDirs,
    });
  }
  return invalidWorkingDirs({
    workingDir: config.daemon.workingDir ?? '~',
    workingDirs: config.daemon.workingDirs,
  });
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CommandHandlerDeps {
  activeSessions: Map<string, DaemonSession>;
  sessionReply: (rootId: string, content: string, msgType?: string, larkAppId?: string) => Promise<string>;
  getActiveCount: () => number;
  lastRepoScan: Map<string, import('../services/project-scanner.js').ProjectInfo[]>;
}

// ─── Schedule command ────────────────────────────────────────────────────────

async function handleRoleCommand(
  args: string,
  rootId: string,
  chatId: string,
  larkAppId: string,
  deps: CommandHandlerDeps,
): Promise<void> {
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const trimmed = args.trim();
  const loc = localeForBot(larkAppId);

  // /role → show current role
  if (!trimmed) {
    const content = resolveRoleFile(larkAppId, chatId);
    if (content) {
      const len = Buffer.byteLength(content, 'utf-8');
      await sessionReply(rootId, `${t('role.current', undefined, loc)}\n\`\`\`markdown\n${content}\n\`\`\`\n${t('role.byte_count', { bytes: len, max: 4096 }, loc)}`);
    } else {
      await sessionReply(rootId, t('role.empty', undefined, loc));
    }
    return;
  }

  // /role set <content> — write role file
  const setMatch = trimmed.match(/^set\s+([\s\S]+)/);
  if (setMatch) {
    const content = setMatch[1].trim();
    if (!content) {
      await sessionReply(rootId, t('role.set_empty', undefined, loc));
      return;
    }
    writeRoleFile(larkAppId, chatId, content);
    const len = Buffer.byteLength(content, 'utf-8');
    await sessionReply(rootId, t('role.saved_via_cmd', { bytes: len, max: 4096 }, loc));
    return;
  }

  // /role delete
  if (trimmed === 'delete' || trimmed === '删除') {
    const existed = deleteRoleFile(larkAppId, chatId);
    if (existed) {
      await sessionReply(rootId, t('role.deleted_via_cmd', undefined, loc));
    } else {
      await sessionReply(rootId, t('role.nothing_to_delete', undefined, loc));
    }
    return;
  }

  // /role help — fallback
  await sessionReply(rootId, t('role.help', undefined, loc));
}

async function handleScheduleCommand(
  args: string,
  rootId: string,
  chatId: string,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const { activeSessions } = deps;
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const trimmed = args.trim();
  const loc = localeForBot(larkAppId);
  // Format dates using a locale that matches the user's UI choice. Both
  // forms include the wall-clock components the user cares about; the
  // difference is just punctuation and digit order.
  const timeLocale = loc === 'en' ? 'en-US' : 'zh-CN';
  const timeZone = 'Asia/Shanghai';

  // /schedule list | /schedule 列表
  if (!trimmed || trimmed === 'list' || trimmed === '列表') {
    const tasks = scheduleStore.listTasks();
    if (tasks.length === 0) {
      await sessionReply(rootId, t('schedule.empty_with_examples', undefined, loc));
      return;
    }
    const lines = tasks.map(task => {
      const status = task.enabled ? '✅' : '⏸️';
      const next = task.enabled ? scheduler.getNextRun(task.id) : null;
      const nextStr = next ? t('schedule.next_label', { time: next.toLocaleString(timeLocale, { timeZone }) }, loc) : '';
      const lastStr = task.lastRunAt ? t('schedule.last_label', { time: new Date(task.lastRunAt).toLocaleString(timeLocale, { timeZone }) }, loc) : '';
      const display = task.parsed?.display ?? task.schedule;
      return `${status} [${task.id}] ${display} | ${task.name}\n   prompt: ${task.prompt.substring(0, 50)}${task.prompt.length > 50 ? '...' : ''}${nextStr}${lastStr}`;
    });
    await sessionReply(rootId, `${t('schedule.list_header', { count: tasks.length }, loc)}\n\n${lines.join('\n\n')}`);
    return;
  }

  // /schedule remove <id> | /schedule 删除 <id>
  const removeMatch = trimmed.match(/^(?:remove|删除)\s+(\S+)/);
  if (removeMatch) {
    const id = removeMatch[1];
    if (scheduler.removeTask(id)) {
      await sessionReply(rootId, t('schedule.removed', { id }, loc));
    } else {
      await sessionReply(rootId, t('schedule.not_found', { id }, loc));
    }
    return;
  }

  // /schedule enable <id> | /schedule 启用 <id>
  const enableMatch = trimmed.match(/^(?:enable|启用)\s+(\S+)/);
  if (enableMatch) {
    const id = enableMatch[1];
    if (scheduler.enableTask(id)) {
      await sessionReply(rootId, t('schedule.enabled', { id }, loc));
    } else {
      await sessionReply(rootId, t('schedule.not_found', { id }, loc));
    }
    return;
  }

  // /schedule disable <id> | /schedule 禁用 <id>
  const disableMatch = trimmed.match(/^(?:disable|禁用)\s+(\S+)/);
  if (disableMatch) {
    const id = disableMatch[1];
    if (scheduler.disableTask(id)) {
      await sessionReply(rootId, t('schedule.disabled', { id }, loc));
    } else {
      await sessionReply(rootId, t('schedule.not_found', { id }, loc));
    }
    return;
  }

  // /schedule run <id> | /schedule 执行 <id>
  const runMatch = trimmed.match(/^(?:run|执行)\s+(\S+)/);
  if (runMatch) {
    const id = runMatch[1];
    if (scheduler.runTaskNow(id)) {
      await sessionReply(rootId, t('schedule.triggered_now', { id }, loc));
    } else {
      await sessionReply(rootId, t('schedule.not_found', { id }, loc));
    }
    return;
  }

  // Natural language: /schedule 每日17:50给我"帮我看看AI新闻"
  const parsed = scheduler.parseNaturalSchedule(trimmed);
  if (parsed) {
    const ds = larkAppId ? activeSessions.get(sessionKey(rootId, larkAppId)) : undefined;
    const workingDir = ds?.workingDir ?? (ds?.larkAppId ? getBot(ds.larkAppId).config.workingDir ?? '~' : getAllBots()[0]?.config.workingDir ?? '~');
    const taskScope: 'thread' | 'chat' = ds?.scope === 'chat' ? 'chat' : 'thread';
    const task = scheduler.addTask({
      name: parsed.name,
      schedule: trimmed,
      parsed: parsed.parsed,
      prompt: parsed.prompt,
      workingDir,
      chatId,
      rootMessageId: taskScope === 'thread' ? rootId : undefined,
      scope: taskScope,
      chatType: ds?.chatType === 'p2p' ? 'p2p' : 'topic_group',
      larkAppId,
    });
    const next = scheduler.getNextRun(task.id);
    const nextStr = next ? next.toLocaleString(timeLocale, { timeZone }) : 'N/A';
    await sessionReply(rootId, t('schedule.created', {
      id: task.id,
      name: task.name,
      rule: parsed.parsed.display,
      prompt: task.prompt,
      dir: expandHome(workingDir),
      next: nextStr,
    }, loc));
    return;
  }

  // Unrecognized format
  await sessionReply(rootId, t('schedule.parse_failed', undefined, loc));
}

// ─── Main command handler ────────────────────────────────────────────────────

export async function handleCommand(
  cmd: string,
  rootId: string,
  message: LarkMessage,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const { activeSessions, getActiveCount, lastRepoScan } = deps;
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const ds = larkAppId ? activeSessions.get(sessionKey(rootId, larkAppId)) : undefined;
  const logTag = ds ? tag(ds) : rootId.substring(0, 12);
  const loc: Locale = localeForBot(ds?.larkAppId ?? larkAppId);

  logger.info(`[${logTag}] Command: ${cmd}`);
  logger.debug(`repo command`, message);

  try {
    switch (cmd) {
      case '/close': {
        if (ds) {
          const closedSessionId = ds.session.sessionId;
          const closedTitle = ds.session.title;
          const botCfg = getBot(ds.larkAppId).config;
          const closedCliId = ds.session.cliId ?? botCfg.cliId;
          const closedAnchor = sessionAnchorId(ds);
          const closedWorkingDir = ds.session.workingDir;
          const cliResumeCommand = (() => {
            try {
              const adapter = createCliAdapterSync(closedCliId, botCfg.cliPathOverride);
              return adapter.buildResumeCommand?.({
                sessionId: closedSessionId,
                cliSessionId: ds.session.cliSessionId,
              }) ?? null;
            } catch { return null; }
          })();
          killWorker(ds);
          sessionStore.closeSession(closedSessionId);
          activeSessions.delete(sessionKey(rootId, larkAppId!));
          const card = buildSessionClosedCard(
            closedSessionId,
            closedAnchor,
            closedTitle,
            closedCliId,
            closedWorkingDir,
            cliResumeCommand,
            loc,
          );
          await sessionReply(rootId, card, 'interactive');
          logger.info(`[${logTag}] Session closed by /close command`);
        } else {
          await sessionReply(rootId, t('cmd.no_active_session', undefined, loc));
        }
        break;
      }

      case '/restart': {
        if (ds) {
          if (ds.worker && !ds.worker.killed) {
            ds.worker.send({ type: 'restart' } as DaemonToWorker);
            const cliName = getCliDisplayName(getBot(ds.larkAppId).config.cliId);
            await sessionReply(rootId, t('cmd.restart.in_progress', { cliName }, loc));
          } else {
            killWorker(ds);
            const cliName = getCliDisplayName(getBot(ds.larkAppId).config.cliId);
            await sessionReply(rootId, t('cmd.restart.terminated', { cliName }, loc));
          }
          logger.info(`[${logTag}] Restart by /restart command`);
        } else {
          await sessionReply(rootId, t('cmd.no_active_session', undefined, loc));
        }
        break;
      }

      case '/cd': {
        const targetPath = message.content.replace(/^\/cd\s*/, '').trim();
        if (!targetPath) {
          await sessionReply(rootId, t('cmd.cd.usage', undefined, loc));
          break;
        }
        if (!ds) {
          await sessionReply(rootId, t('cmd.no_active_session', undefined, loc));
          break;
        }
        const validation = validateWorkingDir(targetPath, loc);
        if (!validation.ok) {
          await sessionReply(rootId, validation.error);
          break;
        }
        const resolvedPath = validation.resolvedPath;
        killWorker(ds);
        ds.workingDir = targetPath;
        ds.session.workingDir = targetPath;
        sessionStore.updateSession(ds.session);
        await sessionReply(rootId, t('cmd.cd.switched', { path: resolvedPath }, loc));
        logger.info(`[${logTag}] Working directory changed to ${resolvedPath} by /cd command`);
        break;
      }

      case '/repo': {
        const repoArg = message.content.replace(/^\/repo\s*/, '').trim();

        // Shared commit path for an already-resolved repo: update the session's
        // working dir, then either fork into the pending CLI (first spawn) or
        // close + recreate the session (mid-session switch). Used by both the
        // numeric `/repo <N>` form and the `/repo <path|name>` form.
        const commitRepoSelection = async (selectedPath: string, displayName: string, how: string) => {
          ds!.workingDir = selectedPath;
          ds!.session.workingDir = selectedPath;
          sessionStore.updateSession(ds!.session);

          if (ds!.pendingRepo) {
            const selfBot = getBot(ds!.larkAppId);
            const botCfg = selfBot.config;
            ds!.pendingRepo = false;
            const { buildNewTopicPrompt, getAvailableBots } = await import('./session-manager.js');
            const pendingPrompt = ds!.pendingPrompt ?? '';
            const prompt = buildNewTopicPrompt(
              pendingPrompt,
              ds!.session.sessionId,
              botCfg.cliId,
              botCfg.cliPathOverride,
              ds!.pendingAttachments,
              ds!.pendingMentions,
              await getAvailableBots(ds!.larkAppId, ds!.chatId),
              ds!.pendingFollowUps,
              { name: selfBot.botName, openId: selfBot.botOpenId },
              loc,
              ds!.pendingSender,
              { larkAppId, chatId: ds!.chatId },
            );
            rememberLastCliInput(ds!, pendingPrompt, prompt);
            ds!.pendingPrompt = undefined;
            ds!.pendingAttachments = undefined;
            ds!.pendingMentions = undefined;
            ds!.pendingSender = undefined;
            ds!.pendingFollowUps = undefined;
            forkWorker(ds!, prompt);
            await sessionReply(rootId, t('cmd.repo.selected_in_pending', { name: displayName }, loc));
          } else {
            killWorker(ds!);
            sessionStore.closeSession(ds!.session.sessionId);
            const session = sessionStore.createSession(ds!.chatId, rootId, displayName, ds!.chatType);
            ds!.session = session;
            ds!.lastUserPrompt = undefined;
            ds!.lastCliInput = undefined;
            ds!.session.workingDir = selectedPath;
            ds!.session.larkAppId = ds!.larkAppId;
            sessionStore.updateSession(ds!.session);
            ds!.hasHistory = false;
            forkWorker(ds!, '', false);
            await sessionReply(rootId, t('cmd.repo.switched_to', { name: displayName }, loc));
          }
          if (ds!.repoCardMessageId) {
            deleteMessage(ds!.larkAppId, ds!.repoCardMessageId);
            ds!.repoCardMessageId = undefined;
          }
          logger.info(`[${logTag}] Repo selected via ${how}: ${selectedPath}`);
        };

        // Numeric arg → pick by 1-based index from the last scan.
        if (repoArg && ds && /^\d+$/.test(repoArg)) {
          const repoIndex = parseInt(repoArg, 10);
          const cached = lastRepoScan.get(ds.chatId);
          if (!cached || cached.length === 0) {
            await sessionReply(rootId, t('cmd.repo.no_prior_scan', undefined, loc));
            break;
          }
          if (repoIndex < 1 || repoIndex > cached.length) {
            await sessionReply(rootId, t('cmd.repo.index_out_of_range', { max: cached.length }, loc));
            break;
          }
          const project = cached[repoIndex - 1];
          await commitRepoSelection(project.path, `${project.name} (${project.branch})`, `/repo ${repoIndex}`);
          break;
        }

        // Non-numeric arg → a path (relative/absolute) or first-level project
        // name under workingDir; resolve it directly and skip the card.
        if (repoArg && ds) {
          const resolved = resolveRepoSelection(repoArg, getProjectScanDirs(ds));
          if (!resolved) {
            await sessionReply(rootId, t('cmd.repo.path_not_found', { arg: repoArg }, loc));
            break;
          }
          await commitRepoSelection(resolved.path, resolved.displayName, `/repo ${repoArg}`);
          break;
        }

        if (ds?.worker && !ds.worker.killed) {
          await sessionReply(rootId, t('cmd.repo.warning_running', undefined, loc));
        }

        const scanDirs = getProjectScanDirs(ds);
        const invalidDirs = invalidConfiguredWorkingDirs(ds, ds?.larkAppId ?? larkAppId);
        if (invalidDirs.length > 0) {
          await sessionReply(rootId, t('cmd.repo.working_dir_not_exist', { dirs: invalidDirs.map(d => `\`${d}\``).join(', ') }, loc));
          break;
        }
        const validDirs = scanDirs.filter(d => existsSync(d));
        if (validDirs.length === 0) {
          await sessionReply(rootId, t('cmd.repo.scan_dir_not_exist', { dirs: scanDirs.join(', ') }, loc));
          break;
        }
        const projects = scanMultipleProjects(validDirs);
        if (projects.length === 0) {
          await sessionReply(rootId, t('cmd.repo.no_git_repos', { dirs: validDirs.join(', ') }, loc));
          break;
        }
        if (ds) lastRepoScan.set(ds.chatId, projects);
        const currentCwd = getSessionWorkingDir(ds);
        const cardJson = buildRepoSelectCard(projects, currentCwd, rootId, loc);
        const repoCardMsgId = await sessionReply(rootId, cardJson, 'interactive');
        if (ds) ds.repoCardMessageId = repoCardMsgId;
        logger.info(`[${logTag}] Sent repo card with ${projects.length} project(s)`);
        break;
      }

      case '/skip': {
        if (ds?.pendingRepo) {
          const selfBot = getBot(ds.larkAppId);
          const botCfg = selfBot.config;
          ds.pendingRepo = false;
          const { buildNewTopicPrompt, getAvailableBots } = await import('./session-manager.js');
          const pendingPrompt = ds.pendingPrompt ?? '';
          const prompt = buildNewTopicPrompt(
            pendingPrompt,
            ds.session.sessionId,
            botCfg.cliId,
            botCfg.cliPathOverride,
            ds.pendingAttachments,
            ds.pendingMentions,
            await getAvailableBots(ds.larkAppId, ds.chatId),
            ds.pendingFollowUps,
            { name: selfBot.botName, openId: selfBot.botOpenId },
            loc,
            ds.pendingSender,
            { larkAppId, chatId: ds.chatId },
          );
          rememberLastCliInput(ds, pendingPrompt, prompt);
          ds.pendingPrompt = undefined;
          ds.pendingAttachments = undefined;
          ds.pendingMentions = undefined;
          ds.pendingSender = undefined;
          ds.pendingFollowUps = undefined;
          forkWorker(ds, prompt);
          const cwd = getSessionWorkingDir(ds);
          await sessionReply(rootId, t('cmd.skip.opened', { cwd }, loc));
          if (ds.repoCardMessageId) {
            deleteMessage(ds.larkAppId, ds.repoCardMessageId);
            ds.repoCardMessageId = undefined;
          }
          logger.info(`[${logTag}] Skip repo via /skip, spawning CLI in ${cwd}`);
        } else {
          await sessionReply(rootId, t('cmd.skip.no_pending', undefined, loc));
        }
        break;
      }

      case '/status': {
        if (ds) {
          const alive = ds.worker && !ds.worker.killed;
          const idle = formatUptime(Date.now() - ds.lastMessageAt);
          const termUrl = ds.workerPort ? `http://${config.web.externalHost}:${ds.workerPort}` : '-';
          const lines = [
            `Session: ${ds.session.sessionId}`,
            `Status: ${alive ? t('cmd.status.running', undefined, loc) : t('cmd.status.waiting', undefined, loc)}`,
            `Terminal: ${termUrl}`,
            `CWD: ${getSessionWorkingDir(ds)}`,
            `${getCliDisplayName(getBot(ds.larkAppId).config.cliId)}: v${ds.cliVersion}${ds.cliVersion !== getCurrentCliVersion() ? ` (latest: v${getCurrentCliVersion()})` : ''}`,
            ...(alive ? [`Uptime: ${formatUptime(Date.now() - ds.spawnedAt)}`] : []),
            `Last message: ${idle} ago`,
            `Active sessions: ${getActiveCount()}`,
          ];
          await sessionReply(rootId, lines.join('\n'));
        } else {
          const fallbackCliName = larkAppId ? getCliDisplayName(getBot(larkAppId).config.cliId) : 'CLI';
          await sessionReply(rootId, t('cmd.status.fallback_no_session', {
            count: getActiveCount(),
            cliName: fallbackCliName,
            version: getCurrentCliVersion(),
          }, loc));
        }
        break;
      }

      case '/schedule': {
        const scheduleArgs = message.content.replace(/^\/schedule\s*/, '');
        const chatId = ds?.chatId!;
        await handleScheduleCommand(scheduleArgs, rootId, chatId, deps, larkAppId);
        logger.info(`[${logTag}] Schedule command handled`);
        break;
      }

      case '/role': {
        const chatId = ds?.chatId;
        if (!chatId || !larkAppId) {
          await sessionReply(rootId, t('role.no_chat', undefined, loc));
          break;
        }
        const roleArgs = message.content.replace(/^\/role\s*/, '');
        await handleRoleCommand(roleArgs, rootId, chatId, larkAppId, deps);
        logger.info(`[${logTag}] Role command handled`);
        break;
      }

      case '/login': {
        const subCmd = message.content.replace(/^\/login\s*/, '').trim();
        if (subCmd === 'status' || subCmd === '状态') {
          await sessionReply(rootId, getTokenStatus());
          break;
        }
        const botCfg2 = ds ? getBot(ds.larkAppId).config : (larkAppId ? getBot(larkAppId).config : getAllBots()[0]?.config);
        if (!botCfg2?.larkAppId || !botCfg2?.larkAppSecret) {
          await sessionReply(rootId, t('cmd.login.no_credentials', undefined, loc));
          break;
        }
        const { authUrl } = generateAuthUrl(botCfg2.larkAppId, botCfg2.larkAppSecret);
        await sessionReply(rootId, [
          t('cmd.login.title', undefined, loc),
          '',
          t('cmd.login.step1', undefined, loc),
          authUrl,
          '',
          t('cmd.login.step2', undefined, loc),
          t('cmd.login.step3', undefined, loc),
          '',
          t('cmd.login.footer', undefined, loc),
          t('cmd.login.status_hint', undefined, loc),
        ].join('\n'));
        break;
      }

      case '/adopt': {
        const adoptArgs = message.content.replace(/^\/adopt\s*/i, '').trim();
        if (ds?.adoptedFrom) {
          const adopted = ds.adoptedFrom;
          const cliName = getCliDisplayName(adopted.cliId ?? 'claude-code');
          const project = adopted.cwd ? (adopted.cwd.split('/').pop() || adopted.cwd) : '';
          const label = project ? `${cliName} · ${project}` : cliName;
          await sessionReply(rootId, t('cmd.adopt.already_adopted', { label, pane: adopted.tmuxTarget }, loc));
          break;
        }
        const botCliId = ds ? getBot(ds.larkAppId).config.cliId : undefined;
        const sessions = discoverAdoptableSessions(botCliId);

        if (sessions.length === 0) {
          await sessionReply(rootId, t('cmd.adopt.no_sessions', undefined, loc));
          break;
        }

        const directTarget = adoptArgs;
        if (directTarget) {
          const target = sessions.find(s => s.tmuxTarget === directTarget);
          if (!target) {
            await sessionReply(rootId, t('cmd.adopt.pane_not_found', { pane: directTarget }, loc));
            break;
          }
          if (ds) await startAdoptSession(target, ds, deps, larkAppId);
          break;
        }

        const cardJson = buildAdoptSelectCard(sessions, rootId, loc);
        await sessionReply(rootId, cardJson, 'interactive');
        break;
      }

      case '/oncall': {
        const args = message.content.replace(/^\/oncall\s*/i, '').trim();
        const [sub, ...rest] = args.length > 0 ? args.split(/\s+/) : [];
        const appId = larkAppId ?? ds?.larkAppId;
        const chatId = ds?.chatId;

        if (!appId || !chatId) {
          await sessionReply(rootId, t('cmd.oncall.need_group', undefined, loc));
          break;
        }

        if (!sub || sub === 'status' || sub === '状态') {
          const entry = getOncallStatus(appId, chatId);
          if (!entry) {
            await sessionReply(rootId, t('cmd.oncall.not_bound', undefined, loc));
          } else {
            await sessionReply(rootId, t('cmd.oncall.bound', { dir: entry.workingDir }, loc));
          }
          break;
        }

        if (sub === 'bind' || sub === '绑定') {
          const target = rest.join(' ').trim();
          if (!target) {
            await sessionReply(rootId, t('cmd.oncall.bind_usage', undefined, loc));
            break;
          }
          const validation = validateWorkingDir(target, loc);
          if (!validation.ok) {
            await sessionReply(rootId, validation.error);
            break;
          }
          const resolvedPath = validation.resolvedPath;
          const result = await bindOncall(appId, chatId, target);
          if (!result.ok) {
            if (result.reason === 'bot_not_in_config') {
              await sessionReply(rootId, t('cmd.oncall.bind_failed_no_bot', undefined, loc));
            } else {
              await sessionReply(rootId, t('cmd.oncall.bind_failed', { reason: result.reason }, loc));
            }
            break;
          }
          const verb = result.created
            ? t('cmd.oncall.verb_bound', undefined, loc)
            : t('cmd.oncall.verb_updated', undefined, loc);
          await sessionReply(rootId, t('cmd.oncall.bind_success', {
            verb,
            chatId,
            target,
            resolved: resolvedPath,
          }, loc));
          logger.info(`[${logTag}] /oncall bind chat=${chatId} dir=${target}`);
          break;
        }

        if (sub === 'unbind' || sub === '解绑') {
          const result = await unbindOncall(appId, chatId);
          if (!result.ok) {
            await sessionReply(rootId, t('cmd.oncall.unbind_failed', { reason: result.reason }, loc));
            break;
          }
          if (!result.wasBound) {
            await sessionReply(rootId, t('cmd.oncall.unbind_not_bound', undefined, loc));
          } else {
            await sessionReply(rootId, t('cmd.oncall.unbind_success', undefined, loc));
          }
          logger.info(`[${logTag}] /oncall unbind chat=${chatId} wasBound=${result.wasBound}`);
          break;
        }

        await sessionReply(rootId, t('cmd.oncall.unknown_sub', { sub }, loc));
        break;
      }

      case '/group':
      case '/g': {
        const creatorAppId = larkAppId ?? ds?.larkAppId;
        if (!creatorAppId) {
          await sessionReply(rootId, t('cmd.group.no_bot', undefined, loc));
          break;
        }

        const senderOpenId = message.senderId;
        if (!senderOpenId) {
          await sessionReply(rootId, t('cmd.group.no_sender', undefined, loc));
          break;
        }

        // Each @-mentioned bot independently receives this same event and reaches
        // this handler, so exactly one must create the group and the rest must
        // stay silent. Intent: pull every @-mentioned bot into a new group, with
        // the FIRST mentioned bot doing the creating.
        //
        // Two distinct sources, each used for what it's reliable at:
        //   • DETECTION ("is this @-mention a bot, and which is first?") uses
        //     globalKnownBotNames() from bots-info.json — process-stable and
        //     complete. getAllBots() can't be used (one daemon per bot ⇒ it only
        //     sees self), and the live roster can transiently miss a bot; either
        //     would let competing processes disagree on the first bot → split
        //     brain. The name set + my own open_id give every process the same
        //     leadership verdict with no API/cross-ref dependency.
        //   • RESOLUTION (bot → larkAppId for the invite) uses the live roster
        //     listChatBotMembers(), failing CLOSED on any miss.
        const mentions = message.mentions ?? [];
        const sourceChatId = ds?.chatId;
        const knownBotNames = globalKnownBotNames();

        // Degraded-state guard: if the user @-mentioned someone but the global bot
        // registry is empty (bots-info.json missing/corrupt/not-yet-written), we
        // can't tell bots from users — so we can't elect a creator. Fail CLOSED
        // rather than fall through to "no bot mentions" → per-bot solo group,
        // which would let every @-mentioned bot create its own group.
        if (knownBotNames.size === 0 && mentions.some(m => !!m.name)) {
          logger.warn(`[${logTag}] /group: global bot registry empty (bots-info.json missing/corrupt); cannot elect a creator`);
          await sessionReply(rootId, t('cmd.group.resolve_failed', undefined, loc));
          break;
        }

        // The @-mentioned bots, in mention order. The first one is the creator.
        const botMentions = mentions.filter(m => m.name && knownBotNames.has(m.name.toLowerCase()));

        // ── Leader election ──────────────────────────────────────────────────
        const mentionedBotAppIds: string[] = [];
        const appIdToName = new Map<string, string>();
        if (botMentions.length > 0) {
          const firstBot = botMentions[0];
          const myOpenId = getBotOpenId(creatorAppId);
          // Am I the first @-mentioned bot? My own open_id is always reliable in
          // my own app scope (Lark reports a bot its own open_id consistently),
          // so this needs no cross-ref. Name fallback only when my open_id isn't
          // probed yet AND my display name is globally unambiguous.
          const myName = getBot(creatorAppId).botName?.toLowerCase();
          const myNameAmbiguous = !!myName && botMentions.filter(m => m.name?.toLowerCase() === myName).length > 1;
          const iAmFirstBot =
            (!!myOpenId && firstBot.openId === myOpenId) ||
            (!myOpenId && !!myName && !myNameAmbiguous && firstBot.name?.toLowerCase() === myName);
          if (!iAmFirstBot) {
            logger.info(`[${logTag}] /group: not the first @-mentioned bot (first="${firstBot.name}"), staying silent`);
            break;
          }
          // I'm the creator. Resolving invitees needs the chat roster — fail
          // CLOSED if it's missing rather than fall through to a per-bot solo
          // group (which would let every mentioned bot create one).
          if (!sourceChatId) {
            logger.warn(`[${logTag}] /group: missing source chatId, cannot resolve @-mentioned bots`);
            await sessionReply(rootId, t('cmd.group.resolve_failed', undefined, loc));
            break;
          }
          let members: Awaited<ReturnType<typeof listChatBotMembers>> = [];
          try {
            members = await listChatBotMembers(creatorAppId, sourceChatId);
          } catch (e: any) {
            logger.warn(`[${logTag}] /group failed to list chat bot members: ${e?.message ?? e}`);
          }
          const memberByOpenId = new Map(members.map(m => [m.openId, m]));
          for (const m of members) {
            if (m.larkAppId && m.displayName) appIdToName.set(m.larkAppId, m.displayName);
          }
          // Resolve each bot mention → larkAppId by open_id (our scope; reliable
          // for distinct bots, and disambiguates duplicate display names), in
          // mention order, deduped. Fail CLOSED on any unresolved bot rather than
          // build a group missing an intended one.
          const seen = new Set<string>();
          let unresolved: string | undefined;
          for (const bm of botMentions) {
            const mem = bm.openId ? memberByOpenId.get(bm.openId) : undefined;
            if (!mem || !mem.larkAppId) { unresolved = bm.name; break; }
            if (!seen.has(mem.larkAppId)) { seen.add(mem.larkAppId); mentionedBotAppIds.push(mem.larkAppId); }
          }
          if (unresolved) {
            logger.warn(`[${logTag}] /group: could not resolve @-mentioned bot "${unresolved}" to an app id; aborting`);
            await sessionReply(rootId, t('cmd.group.resolve_failed', undefined, loc));
            break;
          }
        }

        // Extract the requested group name. Strip whichever alias was used, then
        // remove any `@<name>` mention tokens that leaked into the body (Lark
        // renders mentions as literal `@Name` text in content), then take the
        // first non-blank line so multi-line pastes don't smear into the name.
        let rawArgs = message.content.replace(/^\/(group|g)\s*/i, '');
        for (const m of mentions) {
          if (m.name) rawArgs = rawArgs.split(`@${m.name}`).join(' ');
        }
        const firstLine = rawArgs.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? '';
        const MAX_NAME = 50; // Lark group names cap around 60; leave headroom for '…'
        let groupName: string;
        if (firstLine) {
          groupName = firstLine.length > MAX_NAME ? firstLine.slice(0, MAX_NAME) + '…' : firstLine;
        } else {
          const now = new Date();
          const ts = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          groupName = t('cmd.group.empty_fallback', { ts }, loc);
        }

        // Bots to invite: every @-mentioned bot (creator filtered out internally
        // by the service). Empty mentions → solo group (creator only).
        const larkAppIdsForGroup = mentionedBotAppIds.length > 0 ? mentionedBotAppIds : [creatorAppId];

        try {
          const { createGroupWithBots } = await import('../services/group-creator.js');
          const result = await createGroupWithBots({
            creatorLarkAppId: creatorAppId,
            larkAppIds: larkAppIdsForGroup,
            name: groupName,
            userOpenIds: [senderOpenId],
            transferOwnerTo: senderOpenId,
            notifyOwnerOpenId: senderOpenId,
          });
          // Prefer the shareable join link (others can click to *join*); fall
          // back to the member-only applink URL when Lark's link API failed.
          const applink = `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(result.chatId)}`;
          const link = result.shareLink ?? applink;
          // Partial failures are non-fatal — the chat exists; surface them as
          // hints so the user knows whether to expect to be auto-invited.
          const hints: string[] = [];
          if (result.invalidUserIds.includes(senderOpenId)) {
            hints.push(t('cmd.group.warn_invite_rejected', undefined, loc));
          } else if (result.transferError) {
            hints.push(t('cmd.group.warn_transfer_failed', { reason: result.transferError }, loc));
          }
          // Share-link fetch failed → the displayed link is the member-only
          // applink; warn the user so they don't expect non-members to join via it.
          if (!result.shareLink && result.shareLinkError) {
            logger.warn(`[${logTag}] /group share-link unavailable, using applink: ${result.shareLinkError}`);
            hints.push(t('cmd.group.warn_share_link_failed', undefined, loc));
          }
          // List every bot in the new group (creator included), and warn about
          // any Feishu rejected. Names come from the chat roster (members) since
          // getBot() only knows this process's own bot in the one-daemon-per-bot
          // model; fall back to the registry/raw id for anything not in the map.
          const nameOf = (id: string) => appIdToName.get(id) ?? botDisplayName(id);
          const groupBotIds = larkAppIdsForGroup.filter(id => !result.invalidBotIds.includes(id));
          if (groupBotIds.length > 1) {
            hints.push(t('cmd.group.bots_invited', { bots: groupBotIds.map(nameOf).join('、') }, loc));
          }
          if (result.invalidBotIds.length > 0) {
            hints.push(t('cmd.group.warn_bots_rejected', { bots: result.invalidBotIds.map(nameOf).join('、') }, loc));
          }
          const hintsText = hints.length > 0 ? '\n' + hints.join('\n') : '';
          await sessionReply(rootId, t('cmd.group.created', { name: groupName, link, hints: hintsText }, loc));
          logger.info(`[${logTag}] /group created chat=${result.chatId} name="${groupName}" bots=[${larkAppIdsForGroup.join(',')}] invitee=${senderOpenId}`);
          // Intentionally NO auto-bootstrap (repo-select card / chat-scope
          // session) here: the group name rarely carries enough context to seed
          // a useful prompt. The user starts a real conversation with the bot in
          // the new group, which spawns the session on first message.
        } catch (err: any) {
          logger.error(`[${logTag}] /group failed: ${err?.message ?? err}`);
          await sessionReply(rootId, t('cmd.group.failed', { error: err?.message ?? String(err) }, loc));
        }
        break;
      }

      case '/card': {
        if (!ds) {
          await sessionReply(rootId, t('cmd.no_active_session', undefined, loc));
          break;
        }
        // Private mode (`privateCard`): send a one-shot snapshot only to the
        // explicit talk-grant audience via the ephemeral API, instead of the
        // group-visible live card. Ephemeral cards only work in plain `group`
        // chats and can't be patched — so no live updates, and we fail closed
        // (never fall back to a group-visible card) since not leaking is the
        // entire point of this mode.
        if (getBot(ds.larkAppId).config.privateCard) {
          const mode = await getChatMode(ds.larkAppId, ds.chatId);
          if (mode !== 'group') {
            await sessionReply(rootId, t('cmd.card.private_not_group', undefined, loc));
            break;
          }
          const audience = resolvePrivateCardAudience(ds);
          if (audience.length === 0) {
            await sessionReply(rootId, t('cmd.card.private_no_audience', undefined, loc));
            break;
          }
          const r = await postPrivateSnapshotCard(ds, audience);
          if (r.notReady) {
            await sessionReply(rootId, t('cmd.card.private_not_ready', undefined, loc));
          } else if (r.sent === 0) {
            // Total failure — surface a non-sensitive error (no terminal content,
            // no open_id list). Most likely cause: missing send permission / bot
            // not in chat / topic-thread chat.
            await sessionReply(rootId, t('cmd.card.private_failed', undefined, loc));
          } else if (r.sent < r.total) {
            // Partial — report counts only, never the audience identities.
            await sessionReply(rootId, t('cmd.card.private_partial', { sent: r.sent, total: r.total }, loc));
          }
          break;
        }
        // Manual summon. Force the live card on for the rest of this session —
        // even when the bot has `disableStreamingCard` set — then post a fresh
        // card. If the worker terminal isn't up yet, the force flag still sticks
        // so the card appears (and live-updates) as soon as the worker is ready.
        ds.streamingCardForced = true;
        const posted = await postFreshStreamingCard(ds, deps.sessionReply);
        if (!posted) {
          await sessionReply(rootId, t('cmd.card.not_ready', undefined, loc));
        }
        break;
      }

      case '/help': {
        const botCfg = ds ? getBot(ds.larkAppId).config : getAllBots()[0]?.config;
        const cliName = getCliDisplayName(botCfg?.cliId ?? 'claude-code');
        const help = [
          t('help.heading_session', undefined, loc),
          t('help.close', { cliName }, loc),
          t('help.restart', { cliName }, loc),
          t('help.cd', { cliName }, loc),
          t('help.repo_list', undefined, loc),
          t('help.repo_n', undefined, loc),
          t('help.repo_path', undefined, loc),
          t('help.status', undefined, loc),
          t('help.card', undefined, loc),
          '',
          t('help.heading_passthrough', { cliName }, loc),
          // 直接从集合渲染，保证文案与 PASSTHROUGH_COMMANDS 不漂移
          [...PASSTHROUGH_COMMANDS].join(' '),
          '',
          t('help.heading_schedule', undefined, loc),
          t('help.schedule_create', undefined, loc),
          t('help.schedule_list', undefined, loc),
          t('help.schedule_remove', undefined, loc),
          t('help.schedule_toggle', undefined, loc),
          t('help.schedule_run', undefined, loc),
          '',
          t('help.schedule_formats', undefined, loc),
          '',
          t('help.heading_adopt', undefined, loc),
          t('help.adopt', undefined, loc),
          t('help.adopt_pane', undefined, loc),
          '',
          t('help.heading_login', undefined, loc),
          t('help.login', undefined, loc),
          t('help.login_status', undefined, loc),
          '',
          t('help.heading_oncall', undefined, loc),
          t('help.oncall_bind', undefined, loc),
          t('help.oncall_unbind', undefined, loc),
          t('help.oncall_status', undefined, loc),
          '',
          t('help.heading_grant', undefined, loc),
          t('help.grant', undefined, loc),
          t('help.revoke', undefined, loc),
          '',
          t('help.heading_group', undefined, loc),
          t('help.group', undefined, loc),
          '',
          t('help.help', undefined, loc),
        ];
        await sessionReply(rootId, help.join('\n'));
        break;
      }
    }
  } catch (err: any) {
    logger.error(`[${logTag}] Command ${cmd} error: ${err.message}`);
  }
}

// ─── Adopt session helper ────────────────────────────────────────────────────

export async function startAdoptSession(
  target: AdoptableSession,
  ds: DaemonSession,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const loc: Locale = localeForBot(ds.larkAppId ?? larkAppId);

  if (!validateAdoptTarget(target.tmuxTarget, target.cliPid)) {
    await sessionReply(sessionAnchorId(ds), t('cmd.adopt.target_exited', undefined, loc));
    return;
  }

  const project = target.cwd.split('/').pop() || target.cwd;

  ds.workingDir = target.cwd;
  ds.session.workingDir = target.cwd;
  ds.session.title = `Adopt: ${project}`;
  ds.adoptedFrom = {
    tmuxTarget: target.tmuxTarget,
    originalCliPid: target.cliPid,
    sessionId: target.sessionId,
    cliId: target.cliId,
    cwd: target.cwd,
    paneCols: target.paneCols,
    paneRows: target.paneRows,
  };
  ds.session.adoptedFrom = { ...ds.adoptedFrom };
  sessionStore.updateSession(ds.session);

  forkAdoptWorker(ds);

  const cliName = getCliDisplayName(target.cliId);
  await sessionReply(sessionAnchorId(ds), t('cmd.adopt.success', { cliName, project, pane: target.tmuxTarget }, loc));
}
