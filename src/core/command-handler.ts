/**
 * Command handler — processes /slash commands from users.
 * Extracted from daemon.ts for modularity.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { config } from '../config.js';
import { buildTerminalUrl } from './terminal-url.js';
import { getBot, getAllBots, getBotOpenId, getOwnerOpenId } from '../bot-registry.js';
import * as sessionStore from '../services/session-store.js';
import * as scheduleStore from '../services/schedule-store.js';
import * as scheduler from './scheduler.js';
import { scanProjects, scanMultipleProjects, describeProjectDir } from '../services/project-scanner.js';
import { buildRepoSelectCard, buildAdoptSelectCard, buildCodexAppThreadSelectCard, buildSessionClosedCard, getCliDisplayName } from '../im/lark/card-builder.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { deleteMessage, sendMessage, listChatBotMembers, resolveUserUnionId, getChatModeStrict } from '../im/lark/client.js';
import { claimPairing } from '../services/pairing-store.js';
import { logger } from '../utils/logger.js';
import { killWorker, forkWorker, forkAdoptWorker, getCurrentCliVersion, postFreshStreamingCard, postPrivateSnapshotCard, resolvePrivateCardAudience } from './worker-pool.js';
import { expandHome, getSessionWorkingDir, getProjectScanDir, getProjectScanDirs, rememberLastCliInput } from './session-manager.js';
import { validateWorkingDir } from './working-dir.js';
import { discoverAdoptableSessions, validateAdoptTarget, adoptTargetKey, adoptTargetLabel, type AdoptableSession } from './session-discovery.js';
import { discoverAdoptableZellijSessions, validateZellijAdoptTarget, type ZellijAdoptableSession } from './zellij-adopt-discovery.js';
import { listCodexAppThreads, type CodexAppThreadSummary } from '../services/codex-app-threads.js';
import { generateAuthUrl, getTokenStatus } from '../utils/user-token.js';
import { bindOncall, unbindOncall, getOncallStatus } from '../services/oncall-store.js';
import { setCardMode } from '../services/card-mode-store.js';
import { invalidWorkingDirs } from '../utils/working-dir.js';
import { writeRoleFile, deleteRoleFile, resolveRole, resolveTeamRoleFile, writeTeamRoleFile, deleteTeamRoleFile } from './role-resolver.js';
import { getBotCapability, setBotCapability, clearBotCapability } from '../services/bot-profile-store.js';
import type { LarkMessage, DaemonToWorker } from '../types.js';
import { sessionKey, sessionAnchorId } from './types.js';
import type { DaemonSession } from './types.js';
import { t, localeForBot, type Locale } from '../i18n/index.js';

// ─── Exported constants ──────────────────────────────────────────────────────

export const DAEMON_COMMANDS = new Set(['/close', '/restart', '/status', '/help', '/cd', '/repo', '/schedule', '/role', '/pair', '/login', '/adopt', '/oncall', '/group', '/g', '/relay', '/card']);

/**
 * Daemon commands that act on the chat itself rather than opening a
 * conversation. `/group` (`/g`) just creates a Lark group and replies once —
 * no follow-up turns, no CLI worker. The new-topic spawn path normally
 * pre-creates a sessionStore record so a command can attach state and keep
 * card buttons routable, but for these that record is a phantom conversation
 * that pollutes the dashboard's session list. Handle them without a session.
 */
export const SESSIONLESS_DAEMON_COMMANDS = new Set(['/group', '/g']);

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

function codexAppThreadTitle(thread: CodexAppThreadSummary): string {
  const raw = (thread.name || thread.preview || thread.threadId).replace(/\s+/g, ' ').trim();
  return raw.length > 80 ? raw.slice(0, 79) + '…' : raw;
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
  senderId: string | undefined,
  deps: CommandHandlerDeps,
): Promise<void> {
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const trimmed = args.trim();
  const loc = localeForBot(larkAppId);
  const dataDir = config.session.dataDir;

  // /role team [...] — manage the team-level (per-bot, cross-chat) role
  const teamMatch = trimmed.match(/^team\b([\s\S]*)$/);
  if (teamMatch) {
    const teamArgs = teamMatch[1].trim();
    const teamSet = teamArgs.match(/^set\s+([\s\S]+)/);
    if (teamSet) {
      const content = teamSet[1].trim();
      if (!content) { await sessionReply(rootId, t('role.set_empty', undefined, loc)); return; }
      writeTeamRoleFile(larkAppId, content);
      await sessionReply(rootId, t('role.team_saved', { bytes: Buffer.byteLength(content, 'utf-8'), max: 4096 }, loc));
      return;
    }
    if (teamArgs === 'delete' || teamArgs === '删除') {
      await sessionReply(rootId, deleteTeamRoleFile(larkAppId) ? t('role.team_deleted', undefined, loc) : t('role.team_nothing', undefined, loc));
      return;
    }
    const content = resolveTeamRoleFile(larkAppId);
    if (content) {
      await sessionReply(rootId, `${t('role.team_current', undefined, loc)}\n\`\`\`markdown\n${content}\n\`\`\`\n${t('role.byte_count', { bytes: Buffer.byteLength(content, 'utf-8'), max: 4096 }, loc)}`);
    } else {
      await sessionReply(rootId, t('role.team_empty', undefined, loc));
    }
    return;
  }

  // /role cap [...] — manage the short capability label shown in the roster
  const capMatch = trimmed.match(/^cap\b([\s\S]*)$/);
  if (capMatch) {
    const capArgs = capMatch[1].trim();
    const capSet = capArgs.match(/^set\s+([\s\S]+)/);
    if (capSet) {
      const label = capSet[1].trim();
      if (!label) { await sessionReply(rootId, t('role.cap_set_empty', undefined, loc)); return; }
      setBotCapability(dataDir, larkAppId, label, senderId);
      await sessionReply(rootId, t('role.cap_saved', { cap: getBotCapability(dataDir, larkAppId) ?? label }, loc));
      return;
    }
    if (capArgs === 'clear' || capArgs === '清除') {
      await sessionReply(rootId, clearBotCapability(dataDir, larkAppId) ? t('role.cap_cleared', undefined, loc) : t('role.cap_empty', undefined, loc));
      return;
    }
    const cap = getBotCapability(dataDir, larkAppId);
    await sessionReply(rootId, cap ? t('role.cap_current', { cap }, loc) : t('role.cap_empty', undefined, loc));
    return;
  }

  // /role → show the EFFECTIVE role + where it comes from (chat override > team > none)
  if (!trimmed) {
    const { content, source } = resolveRole(larkAppId, chatId);
    if (content) {
      const len = Buffer.byteLength(content, 'utf-8');
      const srcLabel = source === 'chat' ? t('role.src_chat', undefined, loc) : t('role.src_team', undefined, loc);
      await sessionReply(rootId, `${t('role.current', undefined, loc)} ${srcLabel}\n\`\`\`markdown\n${content}\n\`\`\`\n${t('role.byte_count', { bytes: len, max: 4096 }, loc)}`);
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

/**
 * Handle `/card` (owner-only). Resolves the active session itself, so off/on
 * work WITHOUT one -- they only toggle the per-chat `noCardChats` config. A
 * summon (show/bare) needs a live session.
 *
 * off  -> suppress the live streaming card for this chat (add to noCardChats);
 *         status falls back to master's pending-card morph.
 * on   -> restore cards for this chat (remove from noCardChats).
 * ''/show -> summon a live card. privateCard -> private ephemeral snapshot
 *         (fail closed on non-group); otherwise a group-visible live card.
 * off/on also clear `streamingCardForced` so a prior summon does not
 * short-circuit `streamingCardDisabled()`.
 */
export async function handleCardCommand(
  rootId: string,
  larkAppId: string,
  chatId: string,
  senderOpenId: string | undefined,
  content: string,
  deps: CommandHandlerDeps,
): Promise<void> {
  const loc = localeForBot(larkAppId);
  const reply = (c: string) => deps.sessionReply(rootId, c, undefined, larkAppId);

  const ownerOpenId = getOwnerOpenId(larkAppId);
  if (!ownerOpenId || !senderOpenId || senderOpenId !== ownerOpenId) {
    await reply(t('cmd.card.owner_only', undefined, loc));
    return;
  }

  const ds = deps.activeSessions.get(sessionKey(rootId, larkAppId));
  const sub = content.replace(/^\/card\s*/i, '').trim().toLowerCase();

  if (sub === 'off') {
    const r = await setCardMode(larkAppId, chatId, true);
    if (ds) ds.streamingCardForced = undefined;
    await reply(r.ok ? t('cmd.card.off_ok', undefined, loc) : t('cmd.card.fail', { reason: r.reason }, loc));
    return;
  }
  if (sub === 'on') {
    const r = await setCardMode(larkAppId, chatId, false);
    if (ds) ds.streamingCardForced = undefined;
    await reply(r.ok ? t('cmd.card.on_ok', undefined, loc) : t('cmd.card.fail', { reason: r.reason }, loc));
    return;
  }
  if (sub === '' || sub === 'show') {
    if (!ds) {
      await reply(t('cmd.no_active_session', undefined, loc));
      return;
    }
    if (getBot(ds.larkAppId).config.privateCard) {
      const mode = await getChatModeStrict(ds.larkAppId, ds.chatId);
      if (mode !== 'group') {
        await reply(t('cmd.card.private_not_group', undefined, loc));
        return;
      }
      const audience = resolvePrivateCardAudience(ds);
      if (audience.length === 0) {
        await reply(t('cmd.card.private_no_audience', undefined, loc));
        return;
      }
      const r = await postPrivateSnapshotCard(ds, audience);
      if (r.notReady) {
        await reply(t('cmd.card.private_not_ready', undefined, loc));
      } else if (r.sent === 0) {
        await reply(t('cmd.card.private_failed', undefined, loc));
      } else if (r.sent < r.total) {
        await reply(t('cmd.card.private_partial', { sent: r.sent, total: r.total }, loc));
      }
      return;
    }
    ds.streamingCardForced = true;
    const posted = await postFreshStreamingCard(ds, deps.sessionReply);
    if (!posted) await reply(t('cmd.card.not_ready', undefined, loc));
    return;
  }

  await reply(t('cmd.card.usage', undefined, loc));
}

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

        // First-spawn fork: consume the buffered prompt/attachments and start the
        // CLI in whatever workingDir is currently set on the session. Shared by
        // `commitRepoSelection` (a repo was named) and the bare-`/repo` launch
        // (use the default workingDir) — both only run while `pendingRepo`.
        const forkPendingCli = async (replyText: string) => {
          const selfBot = getBot(ds!.larkAppId);
          const botCfg = selfBot.config;
          ds!.pendingRepo = false;
          const pendingPrompt = ds!.pendingPrompt ?? '';
          // Was there an actual buffered user message to deliver? A session
          // launched *via* `/repo` (the command itself is the first message) has
          // none — so boot the CLI idle and let the user's NEXT message be the
          // first prompt, instead of submitting an empty/boilerplate user_message.
          const hasBufferedInput =
            pendingPrompt.trim().length > 0 ||
            (ds!.pendingAttachments?.length ?? 0) > 0 ||
            (ds!.pendingFollowUps?.length ?? 0) > 0;
          if (hasBufferedInput) {
            const { buildNewTopicPrompt, getAvailableBots } = await import('./session-manager.js');
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
            forkWorker(ds!, prompt);
          } else {
            // Empty initial prompt → worker spawns the CLI without submitting
            // anything (see worker.ts: the init prompt is only queued when truthy).
            forkWorker(ds!, '', false);
          }
          ds!.pendingPrompt = undefined;
          ds!.pendingAttachments = undefined;
          ds!.pendingMentions = undefined;
          ds!.pendingSender = undefined;
          ds!.pendingFollowUps = undefined;
          await sessionReply(rootId, replyText);
        };

        // Shared commit path for an already-resolved repo: update the session's
        // working dir, then either fork into the pending CLI (first spawn) or
        // close + recreate the session (mid-session switch). Used by both the
        // numeric `/repo <N>` form and the `/repo <path|name>` form.
        const commitRepoSelection = async (selectedPath: string, displayName: string, how: string) => {
          ds!.workingDir = selectedPath;
          ds!.session.workingDir = selectedPath;
          sessionStore.updateSession(ds!.session);

          if (ds!.pendingRepo) {
            await forkPendingCli(t('cmd.repo.selected_in_pending', { name: displayName }, loc));
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

        // Bare `/repo` while a repo card is pending → launch right away in the
        // default workingDir. This is the text-command twin of the card's
        // "start directly" button (and replaces the old `/skip` command).
        // Mid-session bare `/repo` (no pending) still falls through to the card.
        if (!repoArg && ds?.pendingRepo) {
          // Validate the configured workingDir before spawning — `forkWorker`
          // doesn't, so a dead cwd would otherwise spawn-and-fail silently. Same
          // guard the card path runs below. On failure we keep the pending state
          // so the user can recover with `/repo <valid-path>` (no card here).
          const invalidDirs = invalidConfiguredWorkingDirs(ds, ds.larkAppId ?? larkAppId);
          if (invalidDirs.length > 0) {
            await sessionReply(rootId, t('cmd.repo.working_dir_not_exist', { dirs: invalidDirs.map(d => `\`${d}\``).join(', ') }, loc));
            break;
          }
          const cwd = getSessionWorkingDir(ds);
          await forkPendingCli(t('cmd.skip.opened', { cwd }, loc));
          if (ds.repoCardMessageId) {
            deleteMessage(ds.larkAppId, ds.repoCardMessageId);
            ds.repoCardMessageId = undefined;
          }
          logger.info(`[${logTag}] Bare /repo while pending → launch in workingDir ${cwd}`);
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

      case '/status': {
        if (ds) {
          const alive = ds.worker && !ds.worker.killed;
          const idle = formatUptime(Date.now() - ds.lastMessageAt);
          const termUrl = ds.workerPort ? buildTerminalUrl(ds) : '-';
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
        await handleRoleCommand(roleArgs, rootId, chatId, larkAppId, message.senderId, deps);
        logger.info(`[${logTag}] Role command handled`);
        break;
      }

      case '/pair': {
        const code = message.content.replace(/^\/pair\s*/, '').trim();
        if (!larkAppId) { await sessionReply(rootId, t('role.no_chat', undefined, loc)); break; }
        if (!code) { await sessionReply(rootId, t('pair.usage', undefined, loc)); break; }
        // Resolve the sender's canonical union_id (best-effort) so the web
        // session is keyed stably across apps; degrade to open_id-only.
        const who = await resolveUserUnionId(larkAppId, message.senderId);
        const result = claimPairing(config.session.dataDir, code, { openId: message.senderId, unionId: who.unionId, name: who.name, larkAppId });
        if (result.ok) await sessionReply(rootId, t('pair.ok', undefined, loc));
        else if (result.reason === 'expired') await sessionReply(rootId, t('pair.expired', undefined, loc));
        else if (result.reason === 'already_claimed') await sessionReply(rootId, t('pair.already', undefined, loc));
        else await sessionReply(rootId, t('pair.not_found', undefined, loc));
        logger.info(`[${logTag}] Pair command handled: ${result.ok ? 'ok' : result.reason}`);
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
          await sessionReply(rootId, t('cmd.adopt.already_adopted', { label, pane: adoptTargetLabel(adopted) }, loc));
          break;
        }
        const botCfgForAdopt = ds ? getBot(ds.larkAppId).config : (larkAppId ? getBot(larkAppId).config : undefined);
        if (botCfgForAdopt?.cliId === 'codex-app') {
          if (!ds) {
            await sessionReply(rootId, t('cmd.no_active_session', undefined, loc));
            break;
          }
          await handleCodexAppAdoptCommand(adoptArgs, rootId, ds, deps, larkAppId);
          break;
        }

        const botCliId = botCfgForAdopt?.cliId;

        // Discover BOTH tmux AND zellij sessions, regardless of the bot's own
        // backend — a normal tmux bot should still be able to adopt a CLI the
        // user is running inside zellij (and vice-versa). The adopt itself
        // picks the right observe backend from the chosen target.
        // discoverAdoptableZellijSessions returns [] when zellij isn't
        // installed, so this is safe on tmux-only hosts.
        const sessions: Array<AdoptableSession | ZellijAdoptableSession> = [
          ...discoverAdoptableSessions(botCliId),
          ...discoverAdoptableZellijSessions(botCliId),
        ];

        if (sessions.length === 0) {
          await sessionReply(rootId, t('cmd.adopt.no_sessions', undefined, loc));
          break;
        }

        const directTarget = adoptArgs;
        if (directTarget) {
          // Match a tmux address ("session:window.pane") OR a zellij target
          // ("session:paneId" / "session/paneId") against the merged list.
          const zellijNorm = directTarget.replace('/', ':');
          const target = sessions.find(s =>
            'zellijPaneId' in s
              ? `${s.zellijSession}:${s.zellijPaneId}` === zellijNorm
              : adoptTargetLabel(s) === directTarget || adoptTargetKey(s) === directTarget || s.tmuxTarget === directTarget || s.herdrPaneId === directTarget,
          );
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
        // `/group` runs without a pre-created session (see
        // SESSIONLESS_DAEMON_COMMANDS), so the source chat comes from the
        // message; fall back to the active session when invoked mid-session.
        const sourceChatId = message.chatId ?? ds?.chatId;
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

      /**
       * `/relay --create <群名> @bot [@bot...]` — create a new chat, invite
       * the @-mentioned bots, then migrate every bot's session in this
       * thread (including the leader's) into the new chat.
       *
       * Two-path command:
       *   • `--create` (PR2) — implemented below; creates a new chat.
       *   • no flag (PR3)    — picker card listing user's relayable sessions
       *                         in OTHER chats so the user can pull one into
       *                         the current chat. Stubbed for now.
       *
       * Leader election is `mentions[0]` (identical to /group). The leader
       * is the only daemon that:
       *   1. Creates the new chat (createGroupWithBots)
       *   2. Sends the M1 announcement message (its message_id becomes the
       *      shared rootMessageId for all relayed sessions — multi-bot
       *      sessions co-anchor on the same root via different larkAppIds)
       *   3. Transfers its own session (if any) via local transferSession()
       *   4. POSTs /api/sessions/migrate-to-chat to every peer daemon to
       *      ask them to transfer their own session at the same anchor
       *   5. Aggregates results into a single reply in the source thread
       *
       * Owner-only: only the source session's `ownerOpenId` may invoke. Peers
       * enforce the same check independently inside the migrate endpoint.
       *
       * Failure mode: best-effort, no rollback. Peers that timeout / fail /
       * are offline simply appear in the report as "skipped". The new chat
       * and any successful transfers stand.
       */
      case '/relay': {
        const argsLine = message.content.replace(/^\/relay\s*/i, '').trim();
        if (!/^--create\b/i.test(argsLine)) {
          // ── Pull picker ───────────────────────────────────────────────────
          // /relay (no flag) lives in the *target* chat — list the operator's
          // own active sessions in OTHER chats so they can pull one in.
          //
          // Filter:
          //   • same bot (this larkAppId)
          //   • session is active (has a worker / appears in activeSessions)
          //   • session NOT in the current chat (can't relay to yourself)
          //   • operator IS the session owner (owner-only access)
          //
          // The button's `target_chat_id` / `target_root_id` are the chat we're
          // pulling INTO (the chat hosting this command). card-handler uses
          // them to invoke transferSession after sending the M1 announcement.
          const operatorOpenId = message.senderId;
          if (!operatorOpenId) {
            await sessionReply(rootId, t('cmd.relay.no_sender', undefined, loc));
            break;
          }
          const myAppId = larkAppId ?? ds?.larkAppId;
          if (!myAppId) {
            await sessionReply(rootId, t('cmd.group.no_bot', undefined, loc));
            break;
          }
          const targetChatId = ds?.chatId;
          if (!targetChatId) {
            await sessionReply(rootId, t('cmd.relay.no_session', undefined, loc));
            break;
          }
          // ── Chat-type guard ───────────────────────────────────────────────
          // Picker mode only makes sense in regular group chats. p2p (1:1 with
          // bot) has no relay concept — there's no other participant to
          // collaborate with — and topic chats route per-thread, so a chat-
          // scope session pulled in would have no thread anchor.
          //
          // p2p is detectable from `ds.chatType` locally (cheap). Topic vs
          // regular group is NOT captured in chatType — both record 'group'
          // — so we hit the Lark API (getChatNameAndMode) to resolve the
          // mode. One API call per /relay invocation; picker is user-
          // triggered so latency is acceptable.
          if (ds?.chatType === 'p2p') {
            await sessionReply(rootId, t('cmd.relay.picker_p2p_unsupported', undefined, loc));
            break;
          }
          {
            const { getChatNameAndMode } = await import('../im/lark/client.js');
            const info = await getChatNameAndMode(myAppId, targetChatId).catch(() => null);
            if (info?.mode === 'p2p') {
              await sessionReply(rootId, t('cmd.relay.picker_p2p_unsupported', undefined, loc));
              break;
            }
            if (info?.mode === 'topic') {
              await sessionReply(rootId, t('cmd.relay.picker_topic_unsupported', undefined, loc));
              break;
            }
          }
          // ── Existing-session guard ────────────────────────────────────────
          // If this bot already runs a real session in the target chat, pulling
          // another session in would collide on sessionKey(targetChatId, larkAppId)
          // — Map.set would silently overwrite, orphaning the existing worker.
          // Refuse upfront with an actionable message.
          //
          // Scratch sessions (the placeholder a `/relay` typed in a fresh chat
          // gets routed through) are filtered by `!!c.worker` — they have no
          // worker process. We do NOT exclude `ds` by sessionId: when `/relay`
          // rides an EXISTING real session (daemon.ts:2034's "existing-session
          // DAEMON_COMMANDS" path skips the scratch and binds `ds` to the
          // chat's real session), `ds` itself IS the conflict — excluding it
          // would let the picker render and the user pick a remote session
          // that the eventual transferSession would have to refuse anyway.
          const conflict = [...activeSessions.values()].find(c =>
            c.larkAppId === myAppId
            && c.chatId === targetChatId
            // chat-scope only: thread-scope sessions (e.g. a `/t` force-topic
            // session in a regular group) live at a different sessionKey
            // anchor (rootMessageId), so they don't collide on transfer.
            // transferSession's own pre-flight (worker-pool.ts) and card-
            // handler's confirm both filter the same way; align here so the
            // picker doesn't false-positive a thread-scope live session.
            && c.scope === 'chat'
            && !!c.worker   // real running session, not a placeholder
          );
          if (conflict) {
            await sessionReply(rootId, t('cmd.relay.target_has_session', { title: conflict.session.title || conflict.session.sessionId.substring(0, 8) }, loc));
            break;
          }
          // Shared candidate-collection logic — used here at initial render
          // and again in card-handler when the user clicks a card to switch
          // selection (the card re-render needs the same filtered list).
          // Filters out: other bots / current chat / non-owned / adopt
          // sessions. Resolves friendly chat names + modes in parallel.
          const { collectRelayPickerEntries } = await import('../services/relay-picker.js');
          const entries = await collectRelayPickerEntries(activeSessions, myAppId, targetChatId, operatorOpenId);
          const { buildRelayPickerCard } = await import('../im/lark/card-builder.js');
          const card = buildRelayPickerCard(entries, targetChatId, rootId, operatorOpenId, loc);
          await sessionReply(rootId, card, 'interactive');
          break;
        }
        const afterFlag = argsLine.replace(/^--create\s*/i, '').trim();

        const creatorAppId = larkAppId ?? ds?.larkAppId;
        if (!creatorAppId) {
          await sessionReply(rootId, t('cmd.group.no_bot', undefined, loc));
          break;
        }
        const senderOpenId = message.senderId;
        // Cross-app stable identity — peer daemons can't compare against
        // leader's open_id directly because the same user has a different
        // open_id in each bot's namespace. union_id is shared per tenant.
        // We pass it through the migrate-to-chat HTTP body; peers compare
        // against their session's `ownerUnionId` (with fallback to
        // open_id for sessions persisted before this field existed).
        const senderUnionId = message.senderUnionId;
        if (!senderOpenId) {
          await sessionReply(rootId, t('cmd.relay.no_sender', undefined, loc));
          break;
        }
        // `--create` must be invoked inside an existing thread — the source
        // anchor for peer transfers comes from `ds`. (Picker mode in PR3 is
        // allowed without a session.)
        if (!ds) {
          await sessionReply(rootId, t('cmd.relay.no_session', undefined, loc));
          break;
        }

        // Front-loaded guards — transferSession refuses adoptedFrom /
        // pendingRepo too, but only after createGroupWithBots has already
        // built a new chat. Failing here keeps relay clean and avoids
        // orphan-chat garbage when the operation can't possibly succeed.
        if (ds.session.adoptedFrom) {
          await sessionReply(rootId, t('cmd.relay.adopt_not_relayable', undefined, loc));
          break;
        }
        if (ds.pendingRepo) {
          await sessionReply(rootId, t('cmd.relay.not_started_yet', undefined, loc));
          break;
        }

        // ── Mention parsing & leader election (mirror of /group) ───────────
        const mentions = message.mentions ?? [];
        const knownBotNames = globalKnownBotNames();
        if (knownBotNames.size === 0 && mentions.some(m => !!m.name)) {
          logger.warn(`[${logTag}] /relay --create: global bot registry empty; cannot elect a creator`);
          await sessionReply(rootId, t('cmd.relay.resolve_failed', undefined, loc));
          break;
        }
        const botMentions = mentions.filter(m => m.name && knownBotNames.has(m.name.toLowerCase()));
        if (botMentions.length === 0) {
          await sessionReply(rootId, t('cmd.relay.no_mentions', undefined, loc));
          break;
        }

        // Am I `mentions[0]`?
        const firstBot = botMentions[0];
        const myOpenId = getBotOpenId(creatorAppId);
        const myName = getBot(creatorAppId).botName?.toLowerCase();
        const myNameAmbiguous = !!myName
          && botMentions.filter(m => m.name?.toLowerCase() === myName).length > 1;
        const iAmFirstBot =
          (!!myOpenId && firstBot.openId === myOpenId) ||
          (!myOpenId && !!myName && !myNameAmbiguous && firstBot.name?.toLowerCase() === myName);
        if (!iAmFirstBot) {
          logger.info(`[${logTag}] /relay --create: not the first @-mentioned bot, staying silent`);
          break;
        }

        // Owner-only — only the source session owner may relay this session.
        if (ds.session.ownerOpenId && ds.session.ownerOpenId !== senderOpenId) {
          await sessionReply(rootId, t('cmd.relay.not_owner', undefined, loc));
          break;
        }

        // ── Resolve @-bots to larkAppIds via the source chat's bot roster ──
        const sourceChatId = ds.chatId;
        let members: Awaited<ReturnType<typeof listChatBotMembers>> = [];
        try {
          members = await listChatBotMembers(creatorAppId, sourceChatId);
        } catch (e: any) {
          logger.warn(`[${logTag}] /relay --create: failed to list source chat members: ${e?.message ?? e}`);
        }
        const memberByOpenId = new Map(members.map(m => [m.openId, m]));
        const appIdToName = new Map<string, string>();
        for (const m of members) {
          if (m.larkAppId && m.displayName) appIdToName.set(m.larkAppId, m.displayName);
        }
        const mentionedBotAppIds: string[] = [];
        const seenApp = new Set<string>();
        let unresolved: string | undefined;
        for (const bm of botMentions) {
          const mem = bm.openId ? memberByOpenId.get(bm.openId) : undefined;
          if (!mem || !mem.larkAppId) { unresolved = bm.name; break; }
          if (!seenApp.has(mem.larkAppId)) {
            seenApp.add(mem.larkAppId);
            mentionedBotAppIds.push(mem.larkAppId);
          }
        }
        if (unresolved) {
          logger.warn(`[${logTag}] /relay --create: unresolved bot "${unresolved}"`);
          await sessionReply(rootId, t('cmd.relay.resolve_failed', undefined, loc));
          break;
        }

        // ── Group name extraction (mirror of /group) ───────────────────────
        let rawArgs = afterFlag;
        for (const m of mentions) {
          if (m.name) rawArgs = rawArgs.split(`@${m.name}`).join(' ');
        }
        const firstLine = rawArgs.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? '';
        const MAX_NAME = 50;
        let groupName: string;
        if (firstLine) {
          groupName = firstLine.length > MAX_NAME ? firstLine.slice(0, MAX_NAME) + '…' : firstLine;
        } else {
          const now = new Date();
          const ts = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          groupName = t('cmd.relay.empty_group_name', { ts }, loc);
        }

        // ── Create the new chat ────────────────────────────────────────────
        const nameOf = (id: string) => appIdToName.get(id) ?? botDisplayName(id);
        let newChatId: string;
        let inviteLink: string;
        try {
          const { createGroupWithBots } = await import('../services/group-creator.js');
          const result = await createGroupWithBots({
            creatorLarkAppId: creatorAppId,
            larkAppIds: mentionedBotAppIds,
            name: groupName,
            userOpenIds: [senderOpenId],
            transferOwnerTo: senderOpenId,
          });
          newChatId = result.chatId;
          const applink = `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(result.chatId)}`;
          inviteLink = result.shareLink ?? applink;
        } catch (err: any) {
          logger.error(`[${logTag}] /relay --create: createGroup failed: ${err?.message ?? err}`);
          await sessionReply(rootId, t('cmd.relay.failed', { error: err?.message ?? String(err) }, loc));
          break;
        }

        // Snapshot the pre-transfer source anchor — peers locate their own
        // session by this value, and `transferSession()` will overwrite
        // `ds.session.rootMessageId` once it runs. Must capture BEFORE the
        // leader transfer call (caught in review).
        const sourceAnchor = ds.session.rootMessageId;

        // ── M1 deferred: post the announcement AFTER all transfers settle ──
        // Previous flow sent an optimistic "已接力" M1 before running any
        // transfer. When leader/peers later failed, that M1 was a lie — and
        // the --create path had no orphan-cleanup (picker path did).
        //
        // New flow: pass `newChatId` as a placeholder for targetRootMessageId
        // into transferSession. Chat-scope routing ignores rootMessageId
        // (worker-pool transferSession only stores it for audit/UX), so the
        // placeholder doesn't break routing. Once all outcomes are in, we
        // post the real M1 with success/failure breakdown, then patch the
        // leader's session.rootMessageId to that final M1 id. Peer sessions
        // keep newChatId as a cosmetic placeholder — fixing them would
        // require another round-trip; chat-scope doesn't actually care.
        const placeholderRootMessageId = newChatId;

        // Resolve friendly source-chat label for the M1 body — falls back to
        // raw chatId if Lark can't return a name. Mirrors picker-path
        // (card-handler.ts:341) so the message reads the same in both UX
        // entry points.
        const { getChatName } = await import('../im/lark/client.js');
        const sourceLabel = (await getChatName(creatorAppId, sourceChatId).catch(() => null)) ?? sourceChatId;

        // ── Step 1: leader transfers its own session (if any) ───────────────
        // Empty-leader handling: daemon auto-creates a placeholder ds for any
        // DAEMON_COMMAND (worker:null + hasHistory:false). If the user typed
        // `/relay --create` in a chat where they never actually chatted with
        // the bot, ds IS that placeholder — there's no real session to
        // migrate. Pre-Codex-review we'd happily transferSession the empty
        // shell and report "已就绪：leader" as a lie. Now we detect this,
        // skip transferSession, mark leader as `no_session`, and close the
        // scratch so it doesn't linger as a ghost.
        //
        // The new chat is still created (createGroupWithBots already ran
        // above) — that itself is a valuable product outcome since the
        // mentioned bots were invited. Peers continue through their normal
        // path; the final M1 template adapts to "all_fresh" when no bot
        // actually had a session to bring along.
        const reportLines: string[] = [];
        const leaderName = nameOf(creatorAppId);
        const successBotNames: string[] = [];
        const failedBotNames: string[] = [];
        // Use the persisted-marker predicate, not runtime ds.hasHistory:
        // restoreActiveSessions sets hasHistory:true UNCONDITIONALLY on
        // restart (session-manager.ts:618), so a scratch that survives a
        // restart comes back with hasHistory:true and would defeat a
        // naive `!!ds.worker || ds.hasHistory` check. cliId / lastCliInput
        // are only written after a real worker started the CLI, so they
        // survive restart correctly.
        const { isRelayableRealSession } = await import('./worker-pool.js');
        const leaderHasRealSession = isRelayableRealSession(ds);
        if (leaderHasRealSession) {
          const { transferSession } = await import('./worker-pool.js');
          // Target chat was just built by createGroupWithBots — by
          // construction a regular group.
          const leaderResult = await transferSession(ds.session.sessionId, newChatId, placeholderRootMessageId, 'group');
          if (!leaderResult.ok) {
            // Real session, real failure (worker busy / unsupported target
            // / tmux issue). Abort the entire --create flow — the new chat
            // exists but is empty of any migrated session; we don't post
            // an M1 because there's nothing to announce.
            reportLines.push(t('cmd.relay.report_leader_failed', { bot: leaderName, error: leaderResult.error }, loc));
            await sessionReply(rootId, t('cmd.relay.created', { name: groupName, link: inviteLink, report: reportLines.join('\n') }, loc));
            break;
          }
          reportLines.push(t('cmd.relay.report_leader_ok', { bot: leaderName }, loc));
          successBotNames.push(leaderName);
        } else {
          // Empty leader: no real session to migrate.
          reportLines.push(t('cmd.relay.report_leader_no_session', { bot: leaderName }, loc));
          failedBotNames.push(leaderName);
          // Close the daemon-command scratch so it doesn't linger as a
          // ghost active row at the source anchor (same hygiene that
          // transferSession's pre-flight applies to target-chat scratches).
          const { closeSession } = await import('./worker-pool.js');
          await closeSession(ds.session.sessionId).catch(err => {
            logger.warn(`[${logTag}] /relay --create: failed to close empty-leader scratch: ${err instanceof Error ? err.message : err}`);
          });
        }

        // ── Step 2: coordinate peer daemons (parallel) ─────────────────────
        const { findOnlineDaemon } = await import('../utils/daemon-discovery.js');
        const peerAppIds = mentionedBotAppIds.filter(id => id !== creatorAppId);
        const peerOutcomes = await Promise.all(peerAppIds.map(async (peerAppId) => {
          const botName = nameOf(peerAppId);
          const daemon = findOnlineDaemon(peerAppId);
          if (!daemon) return { peerAppId, botName, status: 'offline' as const };
          try {
            const ctrl = new AbortController();
            const tt = setTimeout(() => ctrl.abort(), 5000);
            const res = await fetch(
              `http://127.0.0.1:${daemon.ipcPort}/api/sessions/migrate-to-chat`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  sourceAnchor,
                  targetChatId: newChatId,
                  targetRootMessageId: placeholderRootMessageId,
                  requesterLarkAppId: creatorAppId,
                  requestingUserOpenId: senderOpenId,
                  // union_id is cross-app stable within a tenant — peer
                  // compares against its own session.ownerUnionId rather
                  // than translating open_ids per bot. Optional for
                  // backward compat with daemons older than this commit.
                  requestingUserUnionId: senderUnionId,
                }),
                signal: ctrl.signal,
              },
            ).finally(() => clearTimeout(tt));
            const body = await res.json().catch(() => ({} as any));
            if (res.ok && body.ok) return { peerAppId, botName, status: 'ok' as const };
            if (body.error === 'no_session_at_anchor') return { peerAppId, botName, status: 'no_session' as const };
            if (body.error === 'not_session_owner') return { peerAppId, botName, status: 'not_owner' as const };
            if (body.error === 'worker_busy') return { peerAppId, botName, status: 'busy' as const };
            return { peerAppId, botName, status: 'failed' as const, error: body.error ?? `http_${res.status}` };
          } catch (err: any) {
            const reason = err?.name === 'AbortError' ? 'busy' : 'failed';
            return { peerAppId, botName, status: reason as 'busy' | 'failed', error: err?.message ?? String(err) };
          }
        }));

        // Bucket peer outcomes for the final M1 (success / failure) AND extend the
        // source-chat report with per-peer detail. Leader was already bucketed
        // above (real-success → successBotNames; real-fail or empty-leader →
        // failedBotNames), so we only iterate peers here.
        for (const r of peerOutcomes) {
          if (r.status === 'ok') {
            successBotNames.push(r.botName);
            reportLines.push(t('cmd.relay.report_peer_ok', { bot: r.botName }, loc));
          } else {
            failedBotNames.push(r.botName);
            switch (r.status) {
              case 'no_session': reportLines.push(t('cmd.relay.report_peer_no_session', { bot: r.botName },                             loc)); break;
              case 'not_owner':  reportLines.push(t('cmd.relay.report_peer_not_owner',  { bot: r.botName },                             loc)); break;
              case 'offline':    reportLines.push(t('cmd.relay.report_peer_offline',    { bot: r.botName },                             loc)); break;
              case 'busy':       reportLines.push(t('cmd.relay.report_peer_busy',       { bot: r.botName },                             loc)); break;
              case 'failed':     reportLines.push(t('cmd.relay.report_peer_failed',     { bot: r.botName, error: r.error ?? 'unknown' }, loc)); break;
            }
          }
        }

        // ── Step 3: post the real M1 with status breakdown ─────────────────
        // Three templates:
        //   - all_ok      : every bot migrated cleanly
        //   - partial     : some migrated, some didn't (failed list explains)
        //   - all_fresh   : nobody had a session to migrate (group's still
        //                   useful — bots were invited; user just @s to start)
        // Pass the raw text — sendMessage wraps `'text'` msgType bodies into
        // { text: content } itself.
        let finalM1Text: string;
        if (successBotNames.length === 0) {
          finalM1Text = t('cmd.relay.m1_final_all_fresh', { sourceChat: sourceLabel }, loc);
        } else if (failedBotNames.length === 0) {
          finalM1Text = t('cmd.relay.m1_final_all_ok', {
            sourceChat: sourceLabel,
            successBots: successBotNames.join('、'),
          }, loc);
        } else {
          finalM1Text = t('cmd.relay.m1_final_partial', {
            sourceChat: sourceLabel,
            successBots: successBotNames.join('、'),
            failedBots: failedBotNames.join('、'),
          }, loc);
        }
        try {
          const finalM1Id = await sendMessage(creatorAppId, newChatId, finalM1Text, 'text');
          // Patch the leader's session.rootMessageId to the real M1 id, but
          // only if the leader was actually transferred — for the empty-
          // leader / all_fresh path, ds was either closed or never moved,
          // so we don't touch it (would write to a closed/stale record).
          if (leaderHasRealSession && successBotNames.includes(leaderName)) {
            ds.session.rootMessageId = finalM1Id;
            sessionStore.updateSession(ds.session);
          }
        } catch (err: any) {
          // Non-fatal: transfers already succeeded. The source-chat report
          // (sessionReply below) is the user's authoritative status.
          logger.warn(`[${logTag}] /relay --create: final M1 send failed: ${err?.message ?? err}`);
        }

        await sessionReply(rootId, t('cmd.relay.created', { name: groupName, link: inviteLink, report: reportLines.join('\n') }, loc));
        logger.info(`[${logTag}] /relay --create completed: chat=${newChatId} leader=${creatorAppId} peers=[${peerAppIds.join(',')}]`);
        break;
      }

      case '/card': {
        // Existing-session path. New topics route /card via handleCardCommand at
        // the router (so no phantom session is created). off/on work without a
        // live worker; show/bare summons a card.
        const appId = ds?.larkAppId ?? larkAppId;
        const cardChatId = ds?.chatId;
        if (!appId || !cardChatId) {
          await sessionReply(rootId, t('cmd.no_active_session', undefined, loc));
          break;
        }
        await handleCardCommand(rootId, appId, cardChatId, message.senderId, message.content, deps);
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

async function handleCodexAppAdoptCommand(
  args: string,
  rootId: string,
  ds: DaemonSession,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const loc: Locale = localeForBot(ds.larkAppId ?? larkAppId);
  const botCfg = getBot(ds.larkAppId).config;

  let threads: CodexAppThreadSummary[];
  try {
    threads = await listCodexAppThreads({
      codexBin: botCfg.cliPathOverride,
      cwd: getSessionWorkingDir(ds),
      limit: 50,
    });
  } catch (err: any) {
    await sessionReply(rootId, t('cmd.codex_app_adopt.list_failed', { error: err?.message ?? String(err) }, loc));
    return;
  }

  if (threads.length === 0) {
    await sessionReply(rootId, t('cmd.codex_app_adopt.no_threads', undefined, loc));
    return;
  }

  if (args) {
    const target = threads.find(t => t.threadId === args || t.threadId.startsWith(args));
    if (!target) {
      await sessionReply(rootId, t('cmd.codex_app_adopt.thread_not_found', { threadId: args }, loc));
      return;
    }
    await startCodexAppThreadSession(target, ds, deps, larkAppId);
    return;
  }

  const cardJson = buildCodexAppThreadSelectCard(threads, rootId, loc);
  await sessionReply(rootId, cardJson, 'interactive');
}

// ─── Adopt session helper ────────────────────────────────────────────────────

/** Discriminate a zellij adopt candidate from tmux/herdr candidates. */
function isZellijTarget(t: AdoptableSession | ZellijAdoptableSession): t is ZellijAdoptableSession {
  return 'zellijPaneId' in t;
}

export async function startCodexAppThreadSession(
  thread: CodexAppThreadSummary,
  ds: DaemonSession,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const loc: Locale = localeForBot(ds.larkAppId ?? larkAppId);
  const title = codexAppThreadTitle(thread);

  ds.adoptedFrom = undefined;
  ds.workingDir = thread.cwd;
  ds.hasHistory = true;
  ds.currentTurnTitle = undefined;
  ds.lastScreenContent = undefined;
  ds.lastScreenStatus = undefined;

  ds.session.workingDir = thread.cwd;
  ds.session.title = `Codex App: ${title}`;
  ds.session.cliId = 'codex-app';
  ds.session.cliSessionId = thread.threadId;
  ds.session.adoptedFrom = undefined;
  sessionStore.updateSession(ds.session);

  forkWorker(ds, '', true);
  await sessionReply(sessionAnchorId(ds), t('cmd.codex_app_adopt.success', { title }, loc));
}

export async function startAdoptSession(
  target: AdoptableSession | ZellijAdoptableSession,
  ds: DaemonSession,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const loc: Locale = localeForBot(ds.larkAppId ?? larkAppId);

  const zellij = isZellijTarget(target);
  const valid = zellij
    ? validateZellijAdoptTarget(target.zellijSession, target.zellijPaneId, target.cliPid)
    : validateAdoptTarget(target);
  if (!valid) {
    await sessionReply(sessionAnchorId(ds), t('cmd.adopt.target_exited', undefined, loc));
    return;
  }

  const project = target.cwd.split('/').pop() || target.cwd;
  const pane = zellij ? `${target.zellijSession}/${target.zellijPaneId}` : adoptTargetLabel(target);

  ds.workingDir = target.cwd;
  ds.session.workingDir = target.cwd;
  ds.session.title = `Adopt: ${project}`;
  ds.adoptedFrom = {
    source: zellij ? 'zellij' : target.source,
    tmuxTarget: zellij ? undefined : target.tmuxTarget,
    zellijSession: zellij ? target.zellijSession : undefined,
    zellijPaneId: zellij ? target.zellijPaneId : undefined,
    herdrSessionName: zellij ? undefined : target.herdrSessionName,
    herdrTarget: zellij ? undefined : target.herdrTarget,
    herdrPaneId: zellij ? undefined : target.herdrPaneId,
    herdrAgentName: zellij ? undefined : target.herdrAgentName,
    herdrTerminalId: zellij ? undefined : target.herdrTerminalId,
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
  await sessionReply(sessionAnchorId(ds), t('cmd.adopt.success', { cliName, project, pane }, loc));
}
