/**
 * Command handler — processes /slash commands from users.
 * Extracted from daemon.ts for modularity.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { config } from '../config.js';
import { getBot, getAllBots } from '../bot-registry.js';
import * as sessionStore from '../services/session-store.js';
import * as scheduleStore from '../services/schedule-store.js';
import * as scheduler from './scheduler.js';
import { scanProjects, scanMultipleProjects } from '../services/project-scanner.js';
import { buildRepoSelectCard, getCliDisplayName } from '../im/lark/card-builder.js';
import { deleteMessage } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';
import { getSessionCost, formatNumber } from './cost-calculator.js';
import { killWorker, forkWorker, getCurrentCliVersion } from './worker-pool.js';
import { expandHome, getSessionWorkingDir, getProjectScanDir, getProjectScanDirs } from './session-manager.js';
import type { LarkMessage, DaemonToWorker } from '../types.js';
import { sessionKey } from './types.js';
import type { DaemonSession } from './types.js';

// ─── Exported constants ──────────────────────────────────────────────────────

export const DAEMON_COMMANDS = new Set(['/close', '/clear', '/restart', '/status', '/help', '/cd', '/repo', '/skip', '/cost', '/schedule']);

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

  // /schedule list | /schedule 列表
  if (!trimmed || trimmed === 'list' || trimmed === '列表') {
    const tasks = scheduleStore.listTasks();
    if (tasks.length === 0) {
      await sessionReply(rootId, '暂无定时任务。\n\n用法示例：\n/schedule 每日17:50 帮我看看今天AI圈有什么新闻\n/schedule 工作日每天9:00 检查服务状态\n/schedule 每周一10:00 生成周报');
      return;
    }
    const lines = tasks.map(t => {
      const status = t.enabled ? '✅' : '⏸️';
      const next = t.enabled ? scheduler.getNextRun(t.id) : null;
      const nextStr = next ? ` → 下次: ${next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : '';
      const lastStr = t.lastRunAt ? ` | 上次: ${new Date(t.lastRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : '';
      return `${status} [${t.id}] ${t.schedule} | ${t.name}\n   prompt: ${t.prompt.substring(0, 50)}${t.prompt.length > 50 ? '...' : ''}${nextStr}${lastStr}`;
    });
    await sessionReply(rootId, `定时任务列表 (${tasks.length})：\n\n${lines.join('\n\n')}`);
    return;
  }

  // /schedule remove <id> | /schedule 删除 <id>
  const removeMatch = trimmed.match(/^(?:remove|删除)\s+(\S+)/);
  if (removeMatch) {
    const id = removeMatch[1];
    if (scheduler.removeTask(id)) {
      await sessionReply(rootId, `已删除定时任务 ${id}`);
    } else {
      await sessionReply(rootId, `未找到任务 ${id}`);
    }
    return;
  }

  // /schedule enable <id> | /schedule 启用 <id>
  const enableMatch = trimmed.match(/^(?:enable|启用)\s+(\S+)/);
  if (enableMatch) {
    const id = enableMatch[1];
    if (scheduler.enableTask(id)) {
      await sessionReply(rootId, `已启用定时任务 ${id}`);
    } else {
      await sessionReply(rootId, `未找到任务 ${id}`);
    }
    return;
  }

  // /schedule disable <id> | /schedule 禁用 <id>
  const disableMatch = trimmed.match(/^(?:disable|禁用)\s+(\S+)/);
  if (disableMatch) {
    const id = disableMatch[1];
    if (scheduler.disableTask(id)) {
      await sessionReply(rootId, `已禁用定时任务 ${id}`);
    } else {
      await sessionReply(rootId, `未找到任务 ${id}`);
    }
    return;
  }

  // /schedule run <id> | /schedule 执行 <id>
  const runMatch = trimmed.match(/^(?:run|执行)\s+(\S+)/);
  if (runMatch) {
    const id = runMatch[1];
    if (scheduler.runTaskNow(id)) {
      await sessionReply(rootId, `已触发定时任务 ${id} 立即执行`);
    } else {
      await sessionReply(rootId, `未找到任务 ${id}`);
    }
    return;
  }

  // Natural language: /schedule 每日17:50给我"帮我看看AI新闻"
  const parsed = scheduler.parseNaturalSchedule(trimmed);
  if (parsed) {
    const ds = larkAppId ? activeSessions.get(sessionKey(rootId, larkAppId)) : undefined;
    const workingDir = ds?.workingDir ?? (ds?.larkAppId ? getBot(ds.larkAppId).config.workingDir ?? '~' : getAllBots()[0]?.config.workingDir ?? '~');
    const task = scheduler.addTask({
      name: parsed.name,
      type: parsed.type,
      schedule: parsed.cron,
      prompt: parsed.prompt,
      workingDir,
      chatId,
    });
    const next = scheduler.getNextRun(task.id);
    const nextStr = next ? next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : 'N/A';
    await sessionReply(rootId, `✅ 定时任务已创建！\n\nID: ${task.id}\n名称: ${task.name}\nCron: ${task.schedule}\nPrompt: ${task.prompt}\n工作目录: ${expandHome(workingDir)}\n下次执行: ${nextStr}`);
    return;
  }

  // Unrecognized format
  await sessionReply(rootId, `无法解析定时任务，请使用自然语言格式：\n\n/schedule 每日17:50 帮我看看今天AI圈有什么新闻\n/schedule 工作日每天9:00 检查服务状态\n/schedule 每周一10:00 生成周报\n/schedule 每小时 检查服务健康状态\n/schedule 每30分钟 ping一下服务\n/schedule 每月1号9:00 生成月报\n\n管理命令：\n/schedule list — 查看所有任务\n/schedule remove <id> — 删除任务\n/schedule enable <id> — 启用任务\n/schedule disable <id> — 禁用任务\n/schedule run <id> — 立即执行一次`);
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
  const t = ds ? tag(ds) : rootId.substring(0, 12);

  logger.info(`[${t}] Command: ${cmd}`);
  logger.debug(`repo command`, message);

  try {
    switch (cmd) {
      case '/close': {
        if (ds) {
          killWorker(ds);
          sessionStore.closeSession(ds.session.sessionId);
          activeSessions.delete(sessionKey(rootId, larkAppId!));
          const cliName = getCliDisplayName(getBot(ds.larkAppId).config.cliId);
          await sessionReply(rootId, `会话已关闭，${cliName} 进程已终止。`);
          logger.info(`[${t}] Session closed by /close command`);
        } else {
          await sessionReply(rootId, '当前话题没有活跃的会话。');
        }
        break;
      }

      case '/clear': {
        if (ds) {
          killWorker(ds);
          sessionStore.closeSession(ds.session.sessionId);
          const newSession = sessionStore.createSession(ds.chatId, rootId, ds.session.title, ds.chatType);
          ds.session = newSession;
          ds.cliVersion = getCurrentCliVersion();
          ds.hasHistory = false;
          await sessionReply(rootId, `上下文已清除，下次发消息时将使用新会话。\nNew Session: ${newSession.sessionId}`);
          logger.info(`[${t}] Context cleared by /clear command, new session: ${newSession.sessionId}`);
        } else {
          await sessionReply(rootId, '当前话题没有活跃的会话。');
        }
        break;
      }

      case '/restart': {
        if (ds) {
          if (ds.worker && !ds.worker.killed) {
            ds.worker.send({ type: 'restart' } as DaemonToWorker);
            const cliName = getCliDisplayName(getBot(ds.larkAppId).config.cliId);
            await sessionReply(rootId, `🔄 正在重启 ${cliName}...`);
          } else {
            killWorker(ds);
            const cliName = getCliDisplayName(getBot(ds.larkAppId).config.cliId);
            await sessionReply(rootId, `${cliName} 进程已终止，下次发消息时将自动恢复。`);
          }
          logger.info(`[${t}] Restart by /restart command`);
        } else {
          await sessionReply(rootId, '当前话题没有活跃的会话。');
        }
        break;
      }

      case '/cd': {
        const targetPath = message.content.replace(/^\/cd\s*/, '').trim();
        if (!targetPath) {
          await sessionReply(rootId, '用法：/cd <path>\n例如：/cd ~/projects/my-app');
          break;
        }
        const resolvedPath = resolve(expandHome(targetPath));
        if (!existsSync(resolvedPath)) {
          await sessionReply(rootId, `目录不存在：${resolvedPath}`);
          break;
        }
        // Ensure resolved path is under home directory to prevent traversal
        const homeDir = homedir();
        if (!resolvedPath.startsWith(homeDir)) {
          await sessionReply(rootId, `路径必须在用户主目录 (${homeDir}) 下`);
          break;
        }
        if (ds) {
          killWorker(ds);
          ds.workingDir = targetPath;
          ds.session.workingDir = targetPath;
          sessionStore.updateSession(ds.session);
          await sessionReply(rootId, `工作目录已切换到 ${resolvedPath}，下次发消息时将在新目录下恢复。`);
          logger.info(`[${t}] Working directory changed to ${resolvedPath} by /cd command`);
        } else {
          await sessionReply(rootId, '当前话题没有活跃的会话。');
        }
        break;
      }

      case '/repo': {
        const repoArg = message.content.replace(/^\/repo\s*/, '').trim();
        const repoIndex = repoArg ? parseInt(repoArg, 10) : NaN;

        // /repo <N> — quick select from last scan
        if (!isNaN(repoIndex) && ds) {
          const cached = lastRepoScan.get(ds.chatId);
          if (!cached || cached.length === 0) {
            await sessionReply(rootId, '请先执行 /repo 查看项目列表。');
            break;
          }
          if (repoIndex < 1 || repoIndex > cached.length) {
            await sessionReply(rootId, `序号超出范围，有效范围：1-${cached.length}`);
            break;
          }
          const project = cached[repoIndex - 1];
          const selectedPath = project.path;
          const displayName = `${project.name} (${project.branch})`;
          ds.workingDir = selectedPath;
          ds.session.workingDir = selectedPath;
          sessionStore.updateSession(ds.session);

          if (ds.pendingRepo) {
            const botCfg = getBot(ds.larkAppId).config;
            ds.pendingRepo = false;
            const { buildNewTopicPrompt, getAvailableBots } = await import('./session-manager.js');
            const prompt = buildNewTopicPrompt(
              ds.pendingPrompt ?? '',
              ds.session.sessionId,
              botCfg.cliId,
              botCfg.cliPathOverride,
              ds.pendingAttachments,
              ds.pendingMentions,
              await getAvailableBots(ds.larkAppId, ds.chatId),
            );
            const followUps = ds.pendingFollowUps;
            ds.pendingPrompt = undefined;
            ds.pendingAttachments = undefined;
            ds.pendingMentions = undefined;
            ds.pendingFollowUps = undefined;
            forkWorker(ds, prompt);
            if (followUps && followUps.length > 0 && ds.worker) {
              for (const msg of followUps) {
                ds.worker.send({ type: 'message', content: msg } as DaemonToWorker);
              }
              logger.info(`[${t}] Flushed ${followUps.length} buffered follow-up(s)`);
            }
            await sessionReply(rootId, `✅ 已选择 ${displayName}`);
          } else {
            killWorker(ds);
            sessionStore.closeSession(ds.session.sessionId);
            const session = sessionStore.createSession(ds.chatId, rootId, displayName, ds.chatType);
            ds.session = session;
            ds.hasHistory = false;
            forkWorker(ds, '', false);
            await sessionReply(rootId, `🔄 已切换到 ${displayName}`);
          }
          // Withdraw repo selection card
          if (ds.repoCardMessageId) {
            deleteMessage(ds.larkAppId, ds.repoCardMessageId);
            ds.repoCardMessageId = undefined;
          }
          logger.info(`[${t}] Repo selected via /repo ${repoIndex}: ${selectedPath}`);
          break;
        }

        // /repo — show project list card
        if (ds?.worker && !ds.worker.killed) {
          await sessionReply(rootId, '⚠️ 当前会话已在运行中，切换仓库将关闭当前会话并创建新会话。\n如需切换，请在下方卡片中选择新仓库。');
        }

        const scanDirs = getProjectScanDirs(ds);
        const validDirs = scanDirs.filter(d => existsSync(d));
        if (validDirs.length === 0) {
          await sessionReply(rootId, `扫描目录不存在：${scanDirs.join(', ')}\n请设置 PROJECT_SCAN_DIR 或 WORKING_DIR 环境变量。`);
          break;
        }
        const projects = scanMultipleProjects(validDirs);
        if (projects.length === 0) {
          await sessionReply(rootId, `在 ${validDirs.join(', ')} 下未找到 git 仓库。`);
          break;
        }
        if (ds) lastRepoScan.set(ds.chatId, projects);
        const currentCwd = getSessionWorkingDir(ds);
        const cardJson = buildRepoSelectCard(projects, currentCwd, rootId);
        const repoCardMsgId = await sessionReply(rootId, cardJson, 'interactive');
        if (ds) ds.repoCardMessageId = repoCardMsgId;
        logger.info(`[${t}] Sent repo card with ${projects.length} project(s)`);
        break;
      }

      case '/skip': {
        if (ds?.pendingRepo) {
          const botCfg = getBot(ds.larkAppId).config;
          ds.pendingRepo = false;
          const { buildNewTopicPrompt, getAvailableBots } = await import('./session-manager.js');
          const prompt = buildNewTopicPrompt(
            ds.pendingPrompt ?? '',
            ds.session.sessionId,
            botCfg.cliId,
            botCfg.cliPathOverride,
            ds.pendingAttachments,
            ds.pendingMentions,
            await getAvailableBots(ds.larkAppId, ds.chatId),
          );
          const followUps2 = ds.pendingFollowUps;
          ds.pendingPrompt = undefined;
          ds.pendingAttachments = undefined;
          ds.pendingMentions = undefined;
          ds.pendingFollowUps = undefined;
          forkWorker(ds, prompt);
          if (followUps2 && followUps2.length > 0 && ds.worker) {
            for (const msg of followUps2) {
              ds.worker.send({ type: 'message', content: msg } as DaemonToWorker);
            }
            logger.info(`[${t}] Flushed ${followUps2.length} buffered follow-up(s)`);
          }
          const cwd = getSessionWorkingDir(ds);
          await sessionReply(rootId, `▶️ 已直接开启会话（工作目录：${cwd}）`);
          if (ds.repoCardMessageId) {
            deleteMessage(ds.larkAppId, ds.repoCardMessageId);
            ds.repoCardMessageId = undefined;
          }
          logger.info(`[${t}] Skip repo via /skip, spawning CLI in ${cwd}`);
        } else {
          await sessionReply(rootId, '当前没有待选择的仓库。');
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
            `Status: ${alive ? '运行中' : '等待中'}`,
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
          await sessionReply(rootId, `当前话题没有活跃的会话。\nDaemon active sessions: ${getActiveCount()}\n${fallbackCliName}: v${getCurrentCliVersion()}`);
        }
        break;
      }

      case '/cost': {
        if (ds) {
          const cwd = getSessionWorkingDir(ds);
          const cost = getSessionCost(ds.session.sessionId, cwd);
          if (cost) {
            const lines = [
              `Session: ${ds.session.sessionId}`,
              `Model: ${cost.model || 'unknown'}`,
              `Turns: ${cost.turns}`,
              `Input tokens: ${formatNumber(cost.inputTokens)}`,
              `Output tokens: ${formatNumber(cost.outputTokens)}`,
              `Cache read: ${formatNumber(cost.cacheReadTokens)}`,
              `Cache creation: ${formatNumber(cost.cacheCreateTokens)}`,
            ];
            await sessionReply(rootId, lines.join('\n'));
          } else {
            await sessionReply(rootId, `未找到会话 ${ds.session.sessionId} 的 token 数据。`);
          }
          logger.info(`[${t}] Cost queried for session ${ds.session.sessionId}`);
        } else {
          await sessionReply(rootId, '当前话题没有活跃的会话。');
        }
        break;
      }

      case '/schedule': {
        const scheduleArgs = message.content.replace(/^\/schedule\s*/, '');
        const chatId = ds?.chatId!;
        await handleScheduleCommand(scheduleArgs, rootId, chatId, deps, larkAppId);
        logger.info(`[${t}] Schedule command handled`);
        break;
      }

      case '/help': {
        const botCfg = ds ? getBot(ds.larkAppId).config : getAllBots()[0]?.config;
        const cliName = getCliDisplayName(botCfg?.cliId ?? 'claude-code');
        const help = [
          '📌 会话管理：',
          `/close      - 关闭当前会话，终止 ${cliName} 进程`,
          `/clear      - 清除上下文，重启 ${cliName} 进程`,
          `/restart    - 重启 ${cliName} 进程（保留 session）`,
          `/cd <path>  - 切换工作目录并重启 ${cliName} 进程`,
          '/repo       - 查看项目列表（交互式下拉 + 文本列表）',
          '/repo <N>   - 切换到第 N 个项目',
          '/cost       - 查看当前会话的 token 消耗和估算费用',
          '/status     - 查看当前会话状态（含终端链接）',
          '',
          '⏰ 定时任务：',
          '/schedule 每日17:50 帮我看AI新闻   - 创建定时任务（自然语言）',
          '/schedule list                     - 查看所有定时任务',
          '/schedule remove <id>              - 删除任务',
          '/schedule enable/disable <id>      - 启用/禁用任务',
          '/schedule run <id>                 - 立即执行一次',
          '',
          '支持的时间格式：每日/每天、每周X、每月X号、工作日每天、每N小时、每N分钟',
          '',
          '/help       - 显示此帮助',
        ];
        await sessionReply(rootId, help.join('\n'));
        break;
      }
    }
  } catch (err: any) {
    logger.error(`[${t}] Command ${cmd} error: ${err.message}`);
  }
}
