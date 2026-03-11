import { ChildProcess, execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, unlinkSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as Lark from '@larksuiteoapi/node-sdk';
import { config, validateConfig } from './config.js';
import { sendMessage, replyMessage, downloadMessageResource, sendUserMessage, updateMessage, getChatInfo, resolveAllowedUsers } from './services/lark-client.js';
import * as sessionStore from './services/session-store.js';
import * as messageQueue from './services/message-queue.js';
import { parseEventMessage } from './utils/message-parser.js';
import type { MessageResource } from './utils/message-parser.js';
import { logger } from './utils/logger.js';
import type { Session, LarkMessage, LarkAttachment, ScheduledTask, DaemonToWorker } from './types.js';
import * as scheduler from './scheduler.js';
import * as scheduleStore from './services/schedule-store.js';
import { scanProjects } from './services/project-scanner.js';
import { buildRepoSelectCard, buildSessionCard, buildStreamingCard } from './utils/card-builder.js';
import { createCliAdapterSync } from './adapters/cli/registry.js';
import {
  initWorkerPool,
  forkWorker,
  killWorker,
  killStalePids,
  setCurrentClaudeVersion,
  getCurrentClaudeVersion,
} from './core/worker-pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DaemonSession {
  session: Session;
  worker: ChildProcess | null;   // fork'd worker process
  workerPort: number | null;     // HTTP port for xterm.js
  workerToken: string | null;    // write token for xterm.js
  chatId: string;
  chatType: 'group' | 'p2p';    // p2p chats need reply_in_thread to create topics
  spawnedAt: number;
  claudeVersion: string;
  lastMessageAt: number;
  hasHistory: boolean;   // true after Claude has run at least once for this session
  workingDir?: string;
  initConfig?: DaemonToWorker;   // stored for restart
  pendingRepo?: boolean;         // waiting for repo selection before spawning Claude
  pendingPrompt?: string;        // original user message to send after repo is selected
  pendingAttachments?: import('./types.js').LarkAttachment[];
  ownerOpenId?: string;          // topic creator's open_id — receives write-enabled terminal link via DM
  streamCardId?: string;         // message_id of the streaming card in group (PATCHed with live output)
  streamCardPending?: boolean;    // true when a new turn started, next screen_update creates a new card
  lastScreenContent?: string;    // last screen_update content — used to freeze card at idle
  currentTurnTitle?: string;      // title for the current turn's streaming card
}

// ─── State ───────────────────────────────────────────────────────────────────

const activeSessions = new Map<string, DaemonSession>();
// Cache last /repo scan results per chat for /repo <number> fallback
const lastRepoScan = new Map<string, import('./services/project-scanner.js').ProjectInfo[]>();
let lastVersionCheckAt = 0;
const VERSION_CHECK_INTERVAL = 60_000; // cache 1 min
let botOpenId: string | undefined;  // filled at startup, used for @mention detection

const DAEMON_COMMANDS = new Set(['/close', '/clear', '/restart', '/status', '/help', '/cd', '/repo', '/cost', '/schedule']);

/**
 * Reply to a message, automatically using reply_in_thread for p2p sessions.
 * In p2p chats, Lark needs reply_in_thread=true to create/continue a thread.
 */
async function sessionReply(rootId: string, content: string, msgType: string = 'text'): Promise<string> {
  const ds = activeSessions.get(rootId);
  const inThread = ds?.chatType === 'p2p';
  return replyMessage(rootId, content, msgType, inThread);
}

// ─── PID file ────────────────────────────────────────────────────────────────

function getPidFile(): string {
  return join(config.session.dataDir, 'daemon.pid');
}

function writePidFile(): void {
  const dir = config.session.dataDir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getPidFile(), String(process.pid), 'utf-8');
  logger.info(`PID file written: ${getPidFile()} (pid: ${process.pid})`);
}

function removePidFile(): void {
  const pidFile = getPidFile();
  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
    logger.info('PID file removed');
  }
}

// ─── Version tracking ────────────────────────────────────────────────────────

function refreshClaudeVersion(): boolean {
  const now = Date.now();
  if (now - lastVersionCheckAt < VERSION_CHECK_INTERVAL) return false;
  lastVersionCheckAt = now;

  try {
    const adapter = createCliAdapterSync(
      config.daemon.cliId,
      config.daemon.cliPathOverride,
    );
    const raw = execFileSync(adapter.resolvedBin, ['--version'], {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    const newVersion = raw.replace(/^[^0-9]*/, '');

    if (newVersion === 'unknown' || !newVersion) return false;

    const curVer = getCurrentClaudeVersion();
    if (curVer !== 'unknown' && newVersion !== curVer) {
      setCurrentClaudeVersion(newVersion);
      logger.info(`CLI version updated: ${curVer} → ${newVersion} (${adapter.id})`);
      return true;
    }

    setCurrentClaudeVersion(newVersion);
    logger.info(`CLI version: ${getCurrentClaudeVersion()} (${adapter.id})`);
    return false;
  } catch (err: any) {
    logger.warn(`Failed to get CLI version: ${err.message}`);
    return false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

function getSessionWorkingDir(ds?: DaemonSession): string {
  return expandHome(ds?.workingDir ?? config.daemon.workingDir);
}

function getProjectScanDir(ds?: DaemonSession): string {
  // Priority: PROJECT_SCAN_DIR env > parent of current working dir
  if (config.daemon.projectScanDir) {
    return expandHome(config.daemon.projectScanDir);
  }
  const cwd = getSessionWorkingDir(ds);
  return resolve(cwd, '..');
}

function tag(ds: DaemonSession): string {
  return ds.session.sessionId.substring(0, 8);
}

function getActiveCount(): number {
  let count = 0;
  for (const [, ds] of activeSessions) {
    if (ds.worker && !ds.worker.killed) count++;
  }
  return count;
}

// killWorker() — moved to core/worker-pool.ts

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

// ─── Attachment download ─────────────────────────────────────────────────────

function getAttachmentsDir(messageId: string): string {
  return join(resolve(config.session.dataDir), 'attachments', messageId);
}

async function downloadResources(messageId: string, resources: MessageResource[]): Promise<LarkAttachment[]> {
  if (resources.length === 0) return [];

  const attachments: LarkAttachment[] = [];
  const dir = getAttachmentsDir(messageId);

  for (const res of resources) {
    const savePath = join(dir, res.name);
    try {
      await downloadMessageResource(messageId, res.key, res.type, savePath);
      attachments.push({ type: res.type, path: savePath, name: res.name });
    } catch (err: any) {
      logger.warn(`Failed to download ${res.type} ${res.key}: ${err.message}`);
    }
  }

  return attachments;
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

function formatAttachmentsHint(attachments?: LarkAttachment[]): string {
  if (!attachments || attachments.length === 0) return '';
  const lines = attachments.map(a => `- ${a.path}`);
  return `\n\n附件（使用 Read 工具查看）：\n${lines.join('\n')}`;
}

function buildNewTopicPrompt(userMessage: string, sessionId: string, attachments?: LarkAttachment[]): string {
  return `你已连接到飞书话题，用户发送了：
---
${userMessage}${formatAttachmentsHint(attachments)}
---

Session ID: ${sessionId}

请处理用户的请求，通过 send_to_thread 回复用户（session_id: "${sessionId}"）。

注意：
- 回复使用 send_to_thread（重要结论、方案确认、最终结果）
- 对于代码修改任务，先通过 send_to_thread 发送执行方案给用户确认后再执行
- 消息可能包含 attachments，每个有 path 字段，用 Read 工具查看
- 不要使用 EnterPlanMode / ExitPlanMode 工具`;
}

// ─── Worker management ──────────────────────────────────────────────────────
// forkWorker(), killWorker(), ensureMcpConfig(), restartCounts — moved to core/worker-pool.ts

// ─── Session cost ───────────────────────────────────────────────────────────

// Pricing per 1M tokens (USD) — Opus 4
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
  'claude-opus-4-6':           { input: 15, output: 75, cacheRead: 1.875, cacheCreate: 18.75 },
  'claude-opus-4-5-20251101':  { input: 15, output: 75, cacheRead: 1.875, cacheCreate: 18.75 },
  'claude-sonnet-4-5-20250929':{ input: 3,  output: 15, cacheRead: 0.30,  cacheCreate: 3.75 },
  'claude-haiku-4-5-20251001': { input: 0.8,output: 4,  cacheRead: 0.08,  cacheCreate: 1 },
};

interface SessionCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  model: string;
  costUSD: number;
  turns: number;
}

function getSessionJsonlPath(sessionId: string, cwd: string): string | null {
  const resolvedCwd = resolve(expandHome(cwd));
  // Claude stores sessions at ~/.claude/projects/<project-key>/<sessionId>.jsonl
  // where project-key = absolute path with / replaced by -
  const projectKey = resolvedCwd.replace(/\//g, '-');
  const jsonlPath = join(homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`);
  return existsSync(jsonlPath) ? jsonlPath : null;
}

function getSessionCost(sessionId: string, cwd: string): SessionCost | null {
  const jsonlPath = getSessionJsonlPath(sessionId, cwd);
  if (!jsonlPath) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let model = '';
  let turns = 0;

  try {
    const content = readFileSync(jsonlPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'assistant') continue;
        const msg = entry.message;
        if (!msg?.usage) continue;
        const u = msg.usage;
        inputTokens += u.input_tokens ?? 0;
        outputTokens += u.output_tokens ?? 0;
        cacheReadTokens += u.cache_read_input_tokens ?? 0;
        cacheCreateTokens += u.cache_creation_input_tokens ?? 0;
        if (msg.model && !model) model = msg.model;
        turns++;
      } catch { /* skip malformed lines */ }
    }
  } catch (err: any) {
    logger.error(`Failed to read session JSONL: ${err.message}`);
    return null;
  }

  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING['claude-opus-4-6'];
  const costUSD =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheReadTokens / 1_000_000) * pricing.cacheRead +
    (cacheCreateTokens / 1_000_000) * pricing.cacheCreate;

  return { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, model, costUSD, turns };
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

// ─── Scheduled task execution ────────────────────────────────────────────────

async function executeScheduledTask(task: ScheduledTask): Promise<void> {
  const { sendMessage } = await import('./services/lark-client.js');

  // Send a top-level message to create a thread
  const rootMessageId = await sendMessage(
    task.chatId,
    `🕐 定时任务「${task.name}」开始执行`,
  );

  // Create a session for this thread
  refreshClaudeVersion();
  const session = sessionStore.createSession(task.chatId, rootMessageId, `[定时] ${task.name}`);
  messageQueue.ensureQueue(rootMessageId);

  const prompt = buildNewTopicPrompt(task.prompt, session.sessionId);

  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    chatId: task.chatId,
    chatType: 'group',
    spawnedAt: Date.now(),
    claudeVersion: getCurrentClaudeVersion(),
    lastMessageAt: Date.now(),
    hasHistory: false,
    workingDir: task.workingDir,
  };
  activeSessions.set(rootMessageId, ds);
  forkWorker(ds, prompt);

  logger.info(`[scheduler] Task "${task.name}" spawned (session: ${session.sessionId})`);
}

// ─── Schedule command handling ──────────────────────────────────────────────

async function handleScheduleCommand(args: string, rootId: string, chatId: string): Promise<void> {
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
    const ds = activeSessions.get(rootId);
    const workingDir = ds?.workingDir ?? config.daemon.workingDir;
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

// ─── Command handling ────────────────────────────────────────────────────────

async function handleCommand(cmd: string, rootId: string, message: LarkMessage): Promise<void> {
  const ds = activeSessions.get(rootId);
  const t = ds ? tag(ds) : rootId.substring(0, 12);

  logger.info(`[${t}] Command: ${cmd}`);

  try {
    switch (cmd) {
      case '/close': {
        if (ds) {
          killWorker(ds);
          sessionStore.closeSession(ds.session.sessionId);
          activeSessions.delete(rootId);
          await sessionReply(rootId, '会话已关闭，Claude 进程已终止。');
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
          ds.claudeVersion = getCurrentClaudeVersion();
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
            await sessionReply(rootId, '🔄 正在重启 Claude...');
          } else {
            killWorker(ds);
            await sessionReply(rootId, 'Claude 进程已终止，下次发消息时将自动恢复。');
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
        // If Claude is already running, warn user — switching repo means closing the session
        if (ds?.worker && !ds.worker.killed) {
          await sessionReply(rootId, '⚠️ 当前会话已在运行中，切换仓库将关闭当前会话并创建新会话。\n如需切换，请在下方卡片中选择新仓库。');
        }

        // Show project list card (works both for pending-repo and mid-session switch)
        const scanDir = getProjectScanDir(ds);
        if (!existsSync(scanDir)) {
          await sessionReply(rootId, `扫描目录不存在：${scanDir}\n请设置 PROJECT_SCAN_DIR 环境变量。`);
          break;
        }
        const projects = scanProjects(scanDir);
        if (projects.length === 0) {
          await sessionReply(rootId, `在 ${scanDir} 下未找到 git 仓库。`);
          break;
        }
        if (ds) lastRepoScan.set(ds.chatId, projects);
        const currentCwd = getSessionWorkingDir(ds);
        const cardJson = buildRepoSelectCard(projects, currentCwd, rootId);
        await sessionReply(rootId, cardJson, 'interactive');
        logger.info(`[${t}] Sent repo card with ${projects.length} project(s)`);
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
            `Claude: v${ds.claudeVersion}${ds.claudeVersion !== getCurrentClaudeVersion() ? ` (latest: v${getCurrentClaudeVersion()})` : ''}`,
            ...(alive ? [`Uptime: ${formatUptime(Date.now() - ds.spawnedAt)}`] : []),
            `Last message: ${idle} ago`,
            `Active sessions: ${getActiveCount()}`,
          ];
          await sessionReply(rootId, lines.join('\n'));
        } else {
          await sessionReply(rootId, `当前话题没有活跃的会话。\nDaemon active sessions: ${getActiveCount()}\nClaude: v${getCurrentClaudeVersion()}`);
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
              `Estimated cost: $${cost.costUSD.toFixed(2)}`,
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
        const chatId = activeSessions.get(rootId)?.chatId!;
        await handleScheduleCommand(scheduleArgs, rootId, chatId);
        logger.info(`[${t}] Schedule command handled`);
        break;
      }

      case '/help': {
        const help = [
          '📌 会话管理：',
          '/close      - 关闭当前会话，终止 Claude 进程',
          '/clear      - 清除上下文，重启 Claude 进程',
          '/restart    - 重启 Claude 进程（保留 session）',
          '/cd <path>  - 切换工作目录并重启 Claude 进程',
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

// ─── Session restore ─────────────────────────────────────────────────────────

// killStalePids() — moved to core/worker-pool.ts

function restoreActiveSessions(): void {
  const sessions = sessionStore.listSessions();
  const active = sessions.filter(s => s.status === 'active');

  if (active.length === 0) {
    logger.info('No active sessions to restore');
    return;
  }

  // Kill any stale Claude processes from previous daemon run
  killStalePids(active);

  logger.info(`Registering ${active.length} active session(s) (no Claude spawn until new messages arrive)...`);

  for (const session of active) {
    messageQueue.ensureQueue(session.rootMessageId);

    activeSessions.set(session.rootMessageId, {
      session,
      worker: null,
      workerPort: null,
      workerToken: null,
      chatId: session.chatId,
      chatType: session.chatType ?? 'group',
      spawnedAt: Date.now(),
      claudeVersion: getCurrentClaudeVersion(),
      lastMessageAt: Date.now(),
      hasHistory: true,  // restored sessions have prior Claude history
      workingDir: session.workingDir,
    });

    logger.debug(`Registered session ${session.sessionId} (thread: ${session.rootMessageId})`);
  }

  logger.info(`Restored ${active.length} session(s), waiting for messages to resume`);
}

// ─── Card action handling ────────────────────────────────────────────────────

async function handleCardAction(data: any): Promise<void> {
  const action = data?.action;
  const value = action?.value;

  // Check ALLOWED_USERS for sensitive actions
  const operatorOpenId: string | undefined = data?.operator?.open_id;
  const allowedUsers = config.daemon.allowedUsers;
  const isSensitive = value?.action && ['restart', 'close', 'skip_repo', 'get_write_link'].includes(value.action);
  if (isSensitive && allowedUsers.length > 0) {
    if (!operatorOpenId || !allowedUsers.includes(operatorOpenId)) {
      logger.info(`Card action "${value.action}" blocked for non-allowed user: ${operatorOpenId}`);
      return;
    }
  }

  // Handle session card button actions (restart/close)
  if (value?.action) {
    const { action: actionType, root_id: rootId } = value;
    const ds = activeSessions.get(rootId);

    if (actionType === 'restart' && ds) {
      if (ds.worker) {
        // Worker alive — tell it to restart Claude
        logger.info(`[${tag(ds)}] Restart via card button`);
        ds.worker.send({ type: 'restart' } as DaemonToWorker);
        await sessionReply(rootId, '🔄 已重启 Claude');
      } else {
        // Worker gone (e.g. after daemon restart) — re-fork
        logger.info(`[${tag(ds)}] Re-forking worker via card button`);
        forkWorker(ds, '', ds.hasHistory);
        await sessionReply(rootId, '🔄 已重新启动 Claude');
        // DM card will be sent by the ready handler when worker starts
      }
    }

    if (actionType === 'close' && ds) {
      killWorker(ds);
      sessionStore.closeSession(ds.session.sessionId);
      activeSessions.delete(rootId);
      await sessionReply(rootId, '✅ 会话已关闭');
      logger.info(`[${tag(ds)}] Closed via card button`);
    }

    if (actionType === 'get_write_link' && ds && operatorOpenId) {
      if (ds.workerPort && ds.workerToken) {
        const writeUrl = `http://${config.web.externalHost}:${ds.workerPort}?token=${ds.workerToken}`;
        const dmCardJson = buildSessionCard(
          ds.session.sessionId,
          ds.session.rootMessageId,
          writeUrl,
          ds.session.title || 'Claude Code',
        );
        sendUserMessage(operatorOpenId, dmCardJson, 'interactive').catch(err =>
          logger.warn(`[${tag(ds)}] Failed to DM write link: ${err}`),
        );
        logger.info(`[${tag(ds)}] Sent write link via DM to ${operatorOpenId}`);
      } else {
        await sessionReply(rootId, '⚠️ 终端尚未就绪，请稍后再试。');
      }
    }

    if (actionType === 'skip_repo' && ds && ds.pendingRepo) {
      // Skip repo selection — spawn Claude with default working dir
      ds.pendingRepo = false;
      const prompt = buildNewTopicPrompt(
        ds.pendingPrompt ?? '',
        ds.session.sessionId,
        ds.pendingAttachments,
      );
      ds.pendingPrompt = undefined;
      ds.pendingAttachments = undefined;
      forkWorker(ds, prompt);
      const cwd = getSessionWorkingDir(ds);
      await sessionReply(rootId, `▶️ 已直接开启会话（工作目录：${cwd}）`);
      logger.info(`[${tag(ds)}] Skip repo, spawning Claude in ${cwd}`);
    }
    return;
  }

  // Handle repo select card (option-based dropdown)
  const option = action?.option;
  if (!option) {
    logger.warn('Card action received but no option or action value');
    return;
  }

  const selectedPath = option;
  const rootId = action?.value?.root_id;
  logger.info(`Card action: repo switch to ${selectedPath} (root_id: ${rootId})`);

  if (!rootId) {
    logger.warn('Card action: no root_id in action value');
    return;
  }

  const targetDs = activeSessions.get(rootId);
  if (!targetDs) {
    logger.warn(`Card action: no active session found for root ${rootId}`);
    return;
  }

  // Resolve the project name from cached scan
  const cached = lastRepoScan.get(targetDs.chatId);
  const project = cached?.find(p => p.path === selectedPath);
  const displayName = project ? `${project.name} (${project.branch})` : selectedPath;

  targetDs.workingDir = selectedPath;
  targetDs.session.workingDir = selectedPath;
  sessionStore.updateSession(targetDs.session);

  if (targetDs.pendingRepo) {
    // First-time repo selection — now spawn Claude with the original prompt
    targetDs.pendingRepo = false;
    const prompt = buildNewTopicPrompt(
      targetDs.pendingPrompt ?? '',
      targetDs.session.sessionId,
      targetDs.pendingAttachments,
    );
    targetDs.pendingPrompt = undefined;
    targetDs.pendingAttachments = undefined;
    forkWorker(targetDs, prompt);
    await sessionReply(rootId, `✅ 已选择 ${displayName}`);
    logger.info(`[${tag(targetDs)}] Repo selected: ${selectedPath}, spawning Claude`);
  } else {
    // Mid-session repo switch — close old session, start fresh
    killWorker(targetDs);
    sessionStore.closeSession(targetDs.session.sessionId);
    const session = sessionStore.createSession(targetDs.chatId, rootId, displayName, targetDs.chatType);
    targetDs.session = session;
    targetDs.hasHistory = false;
    forkWorker(targetDs, '', false);
    await sessionReply(rootId, `🔄 已切换到 ${displayName}\n旧会话已关闭，新会话已创建。`);
    logger.info(`[${tag(targetDs)}] Repo switched to ${selectedPath}, new session created`);
  }
}

// ─── Event handling ──────────────────────────────────────────────────────────

// Cache group user counts to avoid API calls on every message
const chatUserCountCache = new Map<string, { count: number; fetchedAt: number }>();
const CHAT_CACHE_TTL = 5 * 60_000; // 5 minutes

async function getGroupUserCount(chatId: string): Promise<number> {
  const cached = chatUserCountCache.get(chatId);
  if (cached && Date.now() - cached.fetchedAt < CHAT_CACHE_TTL) {
    return cached.count;
  }
  try {
    const info = await getChatInfo(chatId);
    chatUserCountCache.set(chatId, { count: info.userCount, fetchedAt: Date.now() });
    return info.userCount;
  } catch (err) {
    logger.debug(`Failed to get chat user count for ${chatId}: ${err}`);
    return cached?.count ?? 999; // fallback: assume multi-person
  }
}

/**
 * Probe the bot's own open_id at startup by sending a message and reading it back.
 * Sends a brief status DM to the first allowed user, then inspects the message
 * metadata to learn the bot's sender open_id.
 */
async function probeBotOpenId(): Promise<void> {
  if (botOpenId) return; // already known

  // Call /bot/v3/info to get the bot's open_id using tenant_access_token
  const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: config.lark.appId, app_secret: config.lark.appSecret }),
  });
  const tokenData = await tokenRes.json() as any;
  if (tokenData.code !== 0) {
    throw new Error(`Failed to get tenant_access_token: ${tokenData.msg}`);
  }

  const botRes = await fetch('https://open.feishu.cn/open-apis/bot/v3/info/', {
    headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
  });
  const botData = await botRes.json() as any;
  if (botData.code !== 0) {
    throw new Error(`Failed to get bot info: ${botData.msg}`);
  }

  const openId = botData.bot?.open_id;
  if (openId) {
    botOpenId = openId;
    logger.info(`Bot open_id: ${botOpenId}`);
  } else {
    throw new Error('No open_id in bot info response');
  }
}

/** Check if the bot was @mentioned in this message */
function isBotMentioned(message: any, _senderOpenId: string | undefined): boolean {
  const mentions: any[] = message.mentions ?? [];
  if (mentions.length === 0) return false;

  if (!botOpenId) {
    // Bot open_id unknown — cannot reliably detect @bot mentions.
    // Will be resolved once probeBotOpenId() completes or first bot message event arrives.
    logger.warn('Bot open_id unknown, cannot check @mentions');
    return false;
  }

  return mentions.some((m: any) => m.id?.open_id === botOpenId);
}

/**
 * Check group message addressing:
 * - 'allowed'     → sender is allowed, bot was @mentioned or solo group
 * - 'not_allowed' → bot was @mentioned but sender is not in allowlist
 * - 'ignore'      → not addressed to bot at all
 */
async function checkGroupMessageAccess(
  message: any, chatId: string, senderOpenId: string | undefined,
): Promise<'allowed' | 'not_allowed' | 'ignore'> {
  const mentioned = isBotMentioned(message, senderOpenId);
  const allowedUsers = config.daemon.allowedUsers;
  const isAllowed = allowedUsers.length === 0 || (!!senderOpenId && allowedUsers.includes(senderOpenId));

  if (mentioned) {
    return isAllowed ? 'allowed' : 'not_allowed';
  }

  // No @mention — only allow if sender is the sole human in the group
  if (isAllowed) {
    const userCount = await getGroupUserCount(chatId);
    if (userCount <= 1) {
      return 'allowed';
    }
  }

  return 'ignore';
}

async function handleNewTopic(data: any, chatId: string, messageId: string, chatType: 'group' | 'p2p' = 'group'): Promise<void> {
  const { parsed, resources } = parseEventMessage(data);
  const content = parsed.content.trim();
  const senderOpenId: string | undefined = data.sender?.sender_id?.open_id;
  logger.info(`New topic: ${messageId} "${content.substring(0, 60)}" (resources: ${resources.length}, active: ${getActiveCount()})`);

  // Intercept daemon commands in new topics (no session needed for some commands)
  if (content.startsWith('/')) {
    const cmd = content.split(/\s+/)[0].toLowerCase();
    if (DAEMON_COMMANDS.has(cmd)) {
      const session = sessionStore.createSession(chatId, messageId, content.substring(0, 50), chatType);
      activeSessions.set(messageId, {
        session,
        worker: null,
        workerPort: null,
    workerToken: null,
        chatId,
        chatType,
        spawnedAt: Date.now(),
        claudeVersion: getCurrentClaudeVersion(),
        lastMessageAt: Date.now(),
        hasHistory: false,
        ownerOpenId: senderOpenId,
      });
      await handleCommand(cmd, messageId, parsed);
      return;
    }
  }

  // Download attachments
  const attachments = await downloadResources(messageId, resources);
  if (attachments.length > 0) {
    parsed.attachments = attachments;
  }

  refreshClaudeVersion();

  // Create session in pending-repo state — don't spawn Claude yet
  const session = sessionStore.createSession(chatId, messageId, parsed.content.substring(0, 50), chatType);
  messageQueue.ensureQueue(messageId);
  messageQueue.appendMessage(messageId, parsed);

  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    chatId,
    chatType,
    spawnedAt: Date.now(),
    claudeVersion: getCurrentClaudeVersion(),
    lastMessageAt: Date.now(),
    hasHistory: false,
    pendingRepo: true,
    pendingPrompt: content,
    pendingAttachments: attachments.length > 0 ? attachments : undefined,
    ownerOpenId: senderOpenId,
    currentTurnTitle: content.substring(0, 50),
  };
  activeSessions.set(messageId, ds);

  // Show repo selection card
  const scanDir = getProjectScanDir(ds);
  let projects: import('./services/project-scanner.js').ProjectInfo[] = [];
  if (existsSync(scanDir)) {
    projects = scanProjects(scanDir);
  }
  if (projects.length > 0) {
    lastRepoScan.set(chatId, projects);
    const currentCwd = getSessionWorkingDir(ds);
    const cardJson = buildRepoSelectCard(projects, currentCwd, messageId);
    await sessionReply(messageId, cardJson, 'interactive');
    logger.info(`[${tag(ds)}] Waiting for repo selection (${projects.length} projects)`);
  } else {
    // No projects found — skip repo selection, spawn directly
    ds.pendingRepo = false;
    const prompt = buildNewTopicPrompt(content, session.sessionId, attachments);
    forkWorker(ds, prompt);
    logger.info(`Session ${session.sessionId} ready (no projects to select), total active: ${getActiveCount()}`);
  }
}

async function handleThreadReply(data: any, rootId: string): Promise<void> {
  const { parsed, resources } = parseEventMessage(data);
  const content = parsed.content.trim();

  // Intercept daemon commands
  if (content.startsWith('/')) {
    const cmd = content.split(/\s+/)[0].toLowerCase();
    if (DAEMON_COMMANDS.has(cmd)) {
      handleCommand(cmd, rootId, parsed);
      return;
    }
  }

  logger.info(`Thread reply in ${rootId}: ${content.substring(0, 100)} (resources: ${resources.length})`);

  // Download attachments
  const attachments = await downloadResources(parsed.messageId, resources);
  if (attachments.length > 0) {
    parsed.attachments = attachments;
  }

  // Update last message time
  const ds = activeSessions.get(rootId);
  if (ds) ds.lastMessageAt = Date.now();

  // If waiting for repo selection, remind user
  if (ds?.pendingRepo) {
    await sessionReply(rootId, '请先在上方卡片中选择仓库，再发送消息。');
    return;
  }

  // Route to file queue
  messageQueue.ensureQueue(rootId);
  messageQueue.appendMessage(rootId, parsed);

  if (!ds) {
    // No active session for this thread — auto-create with repo selection
    const chatId: string = data?.message?.chat_id ?? '';
    const chatType = (data?.message?.chat_type === 'p2p' ? 'p2p' : 'group') as 'group' | 'p2p';
    logger.info(`No active session for thread ${rootId}, auto-creating new session...`);
    refreshClaudeVersion();
    const session = sessionStore.createSession(chatId, rootId, parsed.content.substring(0, 50), chatType);
    const newDs: DaemonSession = {
      session,
      worker: null,
      workerPort: null,
      workerToken: null,
      chatId,
      chatType,
      spawnedAt: Date.now(),
      claudeVersion: getCurrentClaudeVersion(),
      lastMessageAt: Date.now(),
      hasHistory: false,
      pendingRepo: true,
      pendingPrompt: parsed.content,
      pendingAttachments: attachments.length > 0 ? attachments : undefined,
      ownerOpenId: data.sender?.sender_id?.open_id,
      currentTurnTitle: parsed.content.substring(0, 50),
    };
    activeSessions.set(rootId, newDs);

    // Show repo selection card (same as handleNewTopic)
    const scanDir = getProjectScanDir(newDs);
    let projects: import('./services/project-scanner.js').ProjectInfo[] = [];
    if (existsSync(scanDir)) {
      projects = scanProjects(scanDir);
    }
    if (projects.length > 0) {
      lastRepoScan.set(chatId, projects);
      const currentCwd = getSessionWorkingDir(newDs);
      const cardJson = buildRepoSelectCard(projects, currentCwd, rootId);
      await sessionReply(rootId, cardJson, 'interactive');
      logger.info(`[${tag(newDs)}] Waiting for repo selection (${projects.length} projects)`);
    } else {
      // No projects found — skip repo selection, spawn directly
      newDs.pendingRepo = false;
      const prompt = buildNewTopicPrompt(parsed.content, session.sessionId, attachments);
      forkWorker(newDs, prompt);
    }

    return;
  }

  // Send message to worker via IPC
  if (ds.worker && !ds.worker.killed) {
    const msgContent = attachments.length > 0
      ? `${parsed.content}${formatAttachmentsHint(attachments)}`
      : parsed.content;
    // Freeze the previous turn's card at "idle" before starting a new turn
    if (ds.streamCardId && ds.workerPort) {
      const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
      const prevTitle = ds.currentTurnTitle || ds.session.title || 'Claude Code';
      const frozenCard = buildStreamingCard(
        ds.session.sessionId, ds.session.rootMessageId, readUrl, prevTitle,
        ds.lastScreenContent ?? '', 'idle',
      );
      updateMessage(ds.streamCardId, frozenCard).catch(() => {});
    }
    // Mark new turn — next screen_update will create a fresh streaming card
    ds.streamCardPending = true;
    ds.currentTurnTitle = parsed.content.substring(0, 50);
    ds.worker.send({ type: 'message', content: msgContent } as DaemonToWorker);
  } else {
    // Worker not running — re-fork with resume
    logger.info(`[${tag(ds)}] Worker not running, re-forking...`);
    ds.currentTurnTitle = parsed.content.substring(0, 50);
    forkWorker(ds, parsed.content, ds.hasHistory);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function startDaemon(): Promise<void> {
  validateConfig();
  writePidFile();

  // Initialise worker pool with daemon callbacks
  initWorkerPool({
    sessionReply,
    getSessionWorkingDir,
    getActiveCount,
  });

  // Get initial CLI version
  refreshClaudeVersion();
  if (getCurrentClaudeVersion() === 'unknown') {
    logger.warn('Could not detect CLI version at startup');
  }

  // Resolve email prefixes in ALLOWED_USERS to open_ids
  if (config.daemon.allowedUsers.length > 0) {
    const hasEmails = config.daemon.allowedUsers.some(u => !u.startsWith('ou_'));
    if (hasEmails) {
      try {
        config.daemon.allowedUsers = await resolveAllowedUsers(config.daemon.allowedUsers);
        logger.info(`Resolved allowedUsers: ${config.daemon.allowedUsers.join(', ')}`);
      } catch (err: any) {
        logger.warn(`Failed to resolve allowedUsers: ${err.message}`);
      }
    }
  }

  // Probe bot open_id at startup (non-blocking)
  probeBotOpenId().catch(err => {
    logger.warn(`Bot open_id probe failed (will learn from events): ${err.message}`);
  });

  // Restore active sessions from previous run
  restoreActiveSessions();

  // Start scheduled task scheduler
  scheduler.setExecuteCallback(executeScheduledTask);
  scheduler.startScheduler();

  // Set up event dispatcher
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'card.action.trigger': async (data: any) => {
      try {
        await handleCardAction(data);
      } catch (err) {
        logger.error(`Error handling card action: ${err}`);
      }
      // Return undefined so WSClient sends no response body (avoids error 200672)
      return undefined;
    },
    'im.message.receive_v1': async (data: any) => {
      try {
        const message = data.message;
        const sender = data.sender;
        if (!message) return;

        // Learn bot's own open_id from its outgoing messages
        if (sender?.sender_type === 'app') {
          if (!botOpenId && sender.sender_id?.open_id) {
            botOpenId = sender.sender_id.open_id;
            logger.info(`Learned bot open_id from message event: ${botOpenId}`);
          }
          // Allow bot's own messages only if they are /close commands in threads
          const rootId = message.root_id;
          if (!rootId) return;
          try {
            const body = JSON.parse(message.content ?? '{}');
            if (body.text?.trim() !== '/close') return;
          } catch {
            return;
          }
          handleThreadReply(data, rootId).catch(err => logger.error(`Error handling message event: ${err}`));
          return;
        }

        const rootId = message.root_id;
        const chatId = message.chat_id;
        const chatType = message.chat_type;  // 'group' or 'p2p'
        const messageId = message.message_id;
        const senderOpenId = sender?.sender_id?.open_id as string | undefined;
        const allowedUsers = config.daemon.allowedUsers;
        const isAllowed = allowedUsers.length === 0 || (!!senderOpenId && allowedUsers.includes(senderOpenId));

        // Group new topics (no rootId): check @mention + permissions
        if (chatType === 'group' && !rootId) {
          const access = await checkGroupMessageAccess(message, chatId, senderOpenId);
          if (access === 'not_allowed') {
            replyMessage(messageId, JSON.stringify({ text: '⚠️ 无操作权限' }))
              .catch(err => logger.debug(`Failed to send permission denied: ${err}`));
            return;
          }
          if (access === 'ignore') {
            logger.debug(`Ignoring group message not addressed to bot: ${messageId}`);
            return;
          }
        } else if (!isAllowed) {
          // Thread replies and DMs: still check allowlist
          logger.debug(`Ignoring message from non-allowed user: ${senderOpenId}`);
          return;
        }

        // p2p messages without rootId → create session directly in the DM chat
        // group messages → normal flow
        const promise = !rootId
          ? handleNewTopic(data, chatId, messageId, chatType as 'group' | 'p2p')
          : handleThreadReply(data, rootId);
        promise.catch(err => logger.error(`Error handling message event: ${err}`));
      } catch (err) {
        logger.error(`Error handling message event: ${err}`);
      }
    },
  });

  // Start WSClient
  const wsClient = new Lark.WSClient({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  wsClient.start({ eventDispatcher });
  logger.info('Daemon WSClient started');

  // Graceful shutdown
  const shutdown = () => {
    logger.info(`Daemon shutting down... (active: ${getActiveCount()})`);
    scheduler.stopScheduler();
    for (const [, ds] of activeSessions) {
      if (ds.worker && !ds.worker.killed) {
        logger.info(`Shutting down worker for session ${ds.session.sessionId}`);
        killWorker(ds);
      }
    }
    removePidFile();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Daemon is running. Press Ctrl+C to stop.');
}
