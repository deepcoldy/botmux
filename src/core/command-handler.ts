/**
 * Command handler — processes /slash commands from users.
 * Extracted from daemon.ts for modularity.
 */
import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { getBot, getAllBots } from '../bot-registry.js';
import * as sessionStore from '../services/session-store.js';
import * as scheduleStore from '../services/schedule-store.js';
import * as scheduler from './scheduler.js';
import { scanProjects, scanMultipleProjects } from '../services/project-scanner.js';
import { buildRepoSelectCard, buildAdoptSelectCard, buildSessionClosedCard, getCliDisplayName } from '../im/lark/card-builder.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { deleteMessage } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';
import { killWorker, forkWorker, forkAdoptWorker, getCurrentCliVersion } from './worker-pool.js';
import { expandHome, getSessionWorkingDir, getProjectScanDir, getProjectScanDirs, rememberLastCliInput } from './session-manager.js';
import { validateWorkingDir } from './working-dir.js';
import { discoverAdoptableSessions, validateAdoptTarget, type AdoptableSession } from './session-discovery.js';
import { generateAuthUrl, getTokenStatus } from '../utils/user-token.js';
import { bindOncall, unbindOncall, getOncallStatus } from '../services/oncall-store.js';
import { invalidWorkingDirs } from '../utils/working-dir.js';
import type { LarkMessage, DaemonToWorker } from '../types.js';
import { sessionKey, sessionAnchorId } from './types.js';
import type { DaemonSession } from './types.js';
import { t, localeForBot, type Locale } from '../i18n/index.js';

// ─── Exported constants ──────────────────────────────────────────────────────

export const DAEMON_COMMANDS = new Set(['/close', '/restart', '/status', '/help', '/cd', '/repo', '/skip', '/schedule', '/login', '/adopt', '/oncall']);

/**
 * Slash commands that are forwarded verbatim to the underlying CLI (e.g.
 * Claude Code's `/compact`, `/model`, `/usage`). The daemon does NOT handle
 * these — it just relays them to the worker via a raw_input IPC message,
 * bypassing the normal prompt-wrapping and bracketed-paste path so the CLI's
 * own slash-command parser sees them.
 */
export const PASSTHROUGH_COMMANDS = new Set(['/compact', '/model', '/clear', '/plugin', '/usage', '/code-review', '/security-review', '/review']);

// ─── Helpers ─────────────────────────────────────────────────────────────────

export interface SlashCommandInvocation {
  cmd: string;
  content: string;
}

const MULTILINE_COMMANDS = new Set(['/schedule']);

// `validateWorkingDir` now lives in ./working-dir.js (leaf module the CLI can
// import without the daemon graph); re-exported here for existing callers.
export { validateWorkingDir };

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
        const repoIndex = repoArg ? parseInt(repoArg, 10) : NaN;

        if (!isNaN(repoIndex) && ds) {
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
          const selectedPath = project.path;
          const displayName = `${project.name} (${project.branch})`;
          ds.workingDir = selectedPath;
          ds.session.workingDir = selectedPath;
          sessionStore.updateSession(ds.session);

          if (ds.pendingRepo) {
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
            );
            rememberLastCliInput(ds, pendingPrompt, prompt);
            ds.pendingPrompt = undefined;
            ds.pendingAttachments = undefined;
            ds.pendingMentions = undefined;
            ds.pendingSender = undefined;
            ds.pendingFollowUps = undefined;
            forkWorker(ds, prompt);
            await sessionReply(rootId, t('cmd.repo.selected_in_pending', { name: displayName }, loc));
          } else {
            killWorker(ds);
            sessionStore.closeSession(ds.session.sessionId);
            const session = sessionStore.createSession(ds.chatId, rootId, displayName, ds.chatType);
            ds.session = session;
            ds.lastUserPrompt = undefined;
            ds.lastCliInput = undefined;
            ds.session.workingDir = selectedPath;
            ds.session.larkAppId = ds.larkAppId;
            sessionStore.updateSession(ds.session);
            ds.hasHistory = false;
            forkWorker(ds, '', false);
            await sessionReply(rootId, t('cmd.repo.switched_to', { name: displayName }, loc));
          }
          if (ds.repoCardMessageId) {
            deleteMessage(ds.larkAppId, ds.repoCardMessageId);
            ds.repoCardMessageId = undefined;
          }
          logger.info(`[${logTag}] Repo selected via /repo ${repoIndex}: ${selectedPath}`);
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
          t('help.status', undefined, loc),
          '',
          t('help.heading_passthrough', { cliName }, loc),
          '/compact /model /clear /plugin /usage /code-review /security-review /review',
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
