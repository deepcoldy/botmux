import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BackendType } from '../adapters/backend/types.js';
import type { DaemonToWorker } from '../types.js';
import type { Locale } from '../i18n/index.js';
import {
  ATTEMPT_TERMINAL_SCHEMA_VERSION,
  attemptTerminalSidecarPath,
  type AttemptTerminalSidecar,
} from './attempt-terminal.js';
import {
  forkWorkerJsFactory,
  syntheticSessionUuid,
  type WorkerHandle,
  type WorkerProcessFactory,
} from './daemon-spawn.js';
import {
  isPathInsideDir,
  isValidPathSegment,
  isValidRunId,
} from './ops-projection.js';
import { prependBotmuxBin } from '../core/botmux-wrapper.js';

export const ATTEMPT_RESUME_SCHEMA_VERSION = 1;
export const ATTEMPT_RESUME_IDLE_MS = 30 * 60 * 1000;
export const ATTEMPT_RESUME_GRACE_MS = 5000;
export const RESUME_REQUIRES_CLI_SESSION_ID = new Set(['antigravity', 'codex-app', 'cursor', 'mira']);
export const RESUME_USES_SESSION_ID = new Set(['aiden', 'coco', 'claude-code', 'seed', 'relay', 'codex', 'mtr', 'hermes', 'pi', 'mir']);

export type AttemptResumeStatus = 'starting' | 'live' | 'closed';

export type AttemptResumeSidecar = {
  schemaVersion: typeof ATTEMPT_RESUME_SCHEMA_VERSION;
  resumeId: string;
  runId: string;
  activityId: string;
  attemptId: string;
  sessionId: string;
  originalSessionId: string;
  cliSessionId?: string;
  webPort?: number;
  writeToken?: string;
  status: AttemptResumeStatus;
  larkAppId: string;
  botName?: string;
  cliId: string;
  workingDir: string;
  logPath: string;
  startedAt: number;
  updatedAt: number;
  closedAt?: number;
  closeReason?: string;
};

export type AttemptResumeBot = {
  larkAppId: string;
  larkAppSecret: string;
  cliId: string;
  cliPathOverride?: string;
  backendType?: BackendType;
  botName?: string;
  botOpenId?: string;
  locale?: Locale;
};

export type AttemptResumeStartResult =
  | {
      ok: true;
      resumeId: string;
      runId: string;
      activityId: string;
      attemptId: string;
      sessionId: string;
      originalSessionId: string;
      cliSessionId?: string;
      webPort: number;
      writeToken: string;
      url: string;
      alreadyRunning: boolean;
      startedAt: number;
      logPath: string;
      sidecarPath: string;
    }
  | { ok: false; error: string; hint?: string; message?: string };

export type AttemptResumeEndResult =
  | {
      ok: true;
      resumeId: string;
      status: 'closed';
      closeReason: string;
      closedAt: number;
    }
  | { ok: false; error: string; hint?: string; message?: string };

export type AttemptResumeManagerDeps = {
  runsDir: string;
  externalHost: string;
  workerPath?: string;
  factory?: WorkerProcessFactory;
  idleMs?: number;
  graceMs?: number;
  resolveBot(larkAppId: string, terminal: AttemptTerminalSidecar): AttemptResumeBot | undefined;
  now?: () => number;
};

type ResumeKey = string;

type ResumeEntry = {
  key: ResumeKey;
  resumeId: string;
  runId: string;
  activityId: string;
  attemptId: string;
  sessionId: string;
  originalSessionId: string;
  cliSessionId?: string;
  larkAppId: string;
  botName?: string;
  cliId: string;
  workingDir: string;
  logPath: string;
  sidecarPath: string;
  startedAt: number;
  updatedAt: number;
  webPort?: number;
  writeToken?: string;
  worker: WorkerHandle;
  closeReason?: string;
  closeTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  readyPromise: Promise<AttemptResumeStartResult>;
  readyResolve: (result: AttemptResumeStartResult) => void;
};

export class AttemptResumeManager {
  private entries = new Map<ResumeKey, ResumeEntry>();
  private readonly factory: WorkerProcessFactory;
  private readonly workerPath: string;
  private readonly idleMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: AttemptResumeManagerDeps) {
    this.factory = deps.factory ?? forkWorkerJsFactory;
    this.workerPath = deps.workerPath ?? defaultWorkerPath();
    this.idleMs = deps.idleMs ?? ATTEMPT_RESUME_IDLE_MS;
    this.graceMs = deps.graceMs ?? ATTEMPT_RESUME_GRACE_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  async start(input: {
    runId: string;
    activityId: string;
    attemptId: string;
  }): Promise<AttemptResumeStartResult> {
    const ids = validateAttemptIds(input);
    if (!ids.ok) return ids;

    const key = resumeKey(input);
    const existing = this.entries.get(key);
    if (existing && existing.webPort && existing.writeToken) {
      this.bumpIdle(existing);
      return {
        ok: true,
        resumeId: existing.resumeId,
        runId: existing.runId,
        activityId: existing.activityId,
        attemptId: existing.attemptId,
        sessionId: existing.sessionId,
        originalSessionId: existing.originalSessionId,
        cliSessionId: existing.cliSessionId,
        webPort: existing.webPort,
        writeToken: existing.writeToken,
        url: this.resumeUrl(existing.webPort, existing.writeToken),
        alreadyRunning: true,
        startedAt: existing.startedAt,
        logPath: existing.logPath,
        sidecarPath: existing.sidecarPath,
      };
    }
    if (existing) return existing.readyPromise;

    const terminal = readTerminalSidecar(this.deps.runsDir, input);
    if (!terminal.ok) return terminal;
    if (!terminal.terminal.larkAppId) {
      return { ok: false, error: 'missing_lark_app_id' };
    }
    const bot = this.deps.resolveBot(terminal.terminal.larkAppId, terminal.terminal);
    if (!bot) return { ok: false, error: 'bot_not_registered' };
    if (!isResumeCapableCli(bot.cliId)) {
      return {
        ok: false,
        error: 'resume_unsupported_cli',
        hint: `${bot.cliId} does not support precise session resume.`,
      };
    }
    if (cliRequiresNativeSessionId(bot.cliId) && !terminal.terminal.cliSessionId) {
      return {
        ok: false,
        error: 'missing_cli_session_id',
        hint: 'This CLI requires a native cliSessionId; rerun the workflow step before resuming.',
      };
    }

    const startedAt = this.now();
    const resumeId = `resume-${startedAt.toString(36)}-${randomBytes(4).toString('hex')}`;
    const resumeDir = join(
      this.deps.runsDir,
      input.runId,
      'attempts',
      input.activityId,
      input.attemptId,
      'resumes',
      resumeId,
    );
    if (!isPathInsideDir(this.deps.runsDir, resumeDir)) {
      return { ok: false, error: 'bad_path' };
    }
    mkdirSync(resumeDir, { recursive: true });
    const logPath = join(resumeDir, 'terminal.log');
    const ptyLogPath = join(resumeDir, 'pty.log');
    const sidecarPath = join(resumeDir, 'resume.json');
    const workingDir = expandWorkflowWorkingDir(terminal.terminal.workingDir) ?? process.cwd();
    const sessionId = syntheticSessionUuid(
      `wf-resume-${input.runId}-${input.activityId}-${input.attemptId}-${resumeId}`,
    );
    const originalSessionId = terminal.terminal.sessionId;

    appendResumeLog(logPath, 'system', `starting dashboard resume cwd=${workingDir}`);
    const worker = this.factory.spawn({
      workerPath: this.workerPath,
      cwd: workingDir,
      env: {
        ...process.env,
        PATH: prependBotmuxBin(join(homedir(), '.botmux', 'bin'), process.env.PATH),
        BOTMUX_WORKFLOW: '1',
        BOTMUX_WORKFLOW_RESUME: '1',
        BOTMUX_WORKFLOW_RUN_ID: input.runId,
        BOTMUX_WORKFLOW_ACTIVITY_ID: input.activityId,
        BOTMUX_WORKFLOW_ATTEMPT_ID: input.attemptId,
        BOTMUX_WORKFLOW_PTY_LOG_PATH: ptyLogPath,
      },
    });

    let readyResolve!: (result: AttemptResumeStartResult) => void;
    const readyPromise = new Promise<AttemptResumeStartResult>((resolve) => {
      readyResolve = resolve;
    });
    const entry: ResumeEntry = {
      key,
      resumeId,
      runId: input.runId,
      activityId: input.activityId,
      attemptId: input.attemptId,
      sessionId,
      originalSessionId,
      cliSessionId: terminal.terminal.cliSessionId,
      larkAppId: bot.larkAppId,
      botName: bot.botName ?? terminal.terminal.botName,
      cliId: bot.cliId,
      workingDir,
      logPath,
      sidecarPath,
      startedAt,
      updatedAt: startedAt,
      worker,
      readyPromise,
      readyResolve,
    };
    this.entries.set(key, entry);
    this.writeSidecar(entry, 'starting');
    this.attachWorker(entry, bot);
    this.bumpIdle(entry);

    const init: DaemonToWorker = {
      type: 'init',
      sessionId,
      chatId: `wf-resume-chat-${input.runId}`,
      rootMessageId: `wf-resume-root-${input.attemptId}`,
      workingDir,
      cliId: bot.cliId,
      cliPathOverride: bot.cliPathOverride,
      backendType: bot.backendType ?? 'pty',
      prompt: '',
      resume: true,
      originalSessionId,
      ...(terminal.terminal.cliSessionId ? { cliSessionId: terminal.terminal.cliSessionId } : {}),
      larkAppId: bot.larkAppId,
      larkAppSecret: bot.larkAppSecret,
      botName: bot.botName ?? terminal.terminal.botName,
      botOpenId: bot.botOpenId,
      locale: bot.locale ?? 'zh',
    };
    try {
      worker.send(init);
    } catch (err) {
      this.closeEntry(entry, `init_send_failed:${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: 'worker_init_failed', message: String(err) };
    }
    return readyPromise;
  }

  async end(input: {
    runId: string;
    activityId: string;
    attemptId: string;
    reason?: string;
  }): Promise<AttemptResumeEndResult> {
    const ids = validateAttemptIds(input);
    if (!ids.ok) return ids;
    const entry = this.entries.get(resumeKey(input));
    if (!entry) return { ok: false, error: 'resume_not_running' };
    const closedAt = this.closeEntry(entry, input.reason ?? 'ended_by_dashboard');
    return {
      ok: true,
      resumeId: entry.resumeId,
      status: 'closed',
      closeReason: entry.closeReason ?? input.reason ?? 'ended_by_dashboard',
      closedAt,
    };
  }

  private attachWorker(entry: ResumeEntry, bot: AttemptResumeBot): void {
    const worker = entry.worker;
    worker.stdout?.on('data', (data: Buffer) => {
      this.bumpIdle(entry);
      appendResumeLog(entry.logPath, 'stdout', data.toString());
    });
    worker.stderr?.on('data', (data: Buffer) => {
      this.bumpIdle(entry);
      appendResumeLog(entry.logPath, 'stderr', data.toString());
    });
    worker.on('message', (event: any) => {
      this.bumpIdle(entry);
      switch (event?.type) {
        case 'ready': {
          const webPort = Number(event.port);
          const writeToken = String(event.token);
          entry.webPort = webPort;
          entry.writeToken = writeToken;
          entry.updatedAt = this.now();
          appendResumeLog(entry.logPath, 'system', `worker ready port=${event.port}`);
          this.writeSidecar(entry, 'live');
          entry.readyResolve({
            ok: true,
            resumeId: entry.resumeId,
            runId: entry.runId,
            activityId: entry.activityId,
            attemptId: entry.attemptId,
            sessionId: entry.sessionId,
            originalSessionId: entry.originalSessionId,
            cliSessionId: entry.cliSessionId,
            webPort,
            writeToken,
            url: this.resumeUrl(webPort, writeToken),
            alreadyRunning: false,
            startedAt: entry.startedAt,
            logPath: entry.logPath,
            sidecarPath: entry.sidecarPath,
          });
          break;
        }
        case 'cli_session_id': {
          if (typeof event.cliSessionId === 'string' && event.cliSessionId) {
            entry.cliSessionId = event.cliSessionId;
            this.writeSidecar(entry, entry.webPort ? 'live' : 'starting');
          }
          break;
        }
        case 'error':
          appendResumeLog(entry.logPath, 'error', event.message ?? 'worker error');
          if (!entry.webPort) {
            entry.readyResolve({ ok: false, error: 'worker_error', message: String(event.message ?? '') });
          }
          this.closeEntry(entry, 'worker_error');
          break;
        default:
          break;
      }
    });
    worker.on('error', (err) => {
      appendResumeLog(entry.logPath, 'error', err.message);
      if (!entry.webPort) entry.readyResolve({ ok: false, error: 'worker_error', message: err.message });
      this.closeEntry(entry, 'worker_error');
    });
    worker.on('exit', (code) => {
      appendResumeLog(entry.logPath, 'system', `worker process exit code=${code ?? 'null'}`);
      if (!entry.webPort) {
        entry.readyResolve({ ok: false, error: 'worker_exited_before_ready' });
      }
      this.closeEntry(entry, entry.closeReason ?? 'worker_exit', { noKill: true });
    });
    appendResumeLog(
      entry.logPath,
      'system',
      `worker spawned pid=${worker.pid ?? 'unknown'} cli=${bot.cliId}`,
    );
  }

  private bumpIdle(entry: ResumeEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      this.closeEntry(entry, 'idle_timeout');
    }, this.idleMs);
  }

  private closeEntry(
    entry: ResumeEntry,
    reason: string,
    opts: { noKill?: boolean } = {},
  ): number {
    const current = this.entries.get(entry.key);
    if (current !== entry && !opts.noKill) return this.now();
    entry.closeReason = entry.closeReason ?? reason;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.closeTimer) clearTimeout(entry.closeTimer);
    const closedAt = this.now();
    entry.updatedAt = closedAt;
    this.writeSidecar(entry, 'closed');
    this.entries.delete(entry.key);
    if (!opts.noKill) {
      try { entry.worker.send({ type: 'close' }); } catch { /* gone */ }
      try { entry.worker.kill('SIGINT'); } catch { /* gone */ }
      entry.closeTimer = setTimeout(() => {
        try { entry.worker.kill('SIGKILL'); } catch { /* gone */ }
      }, this.graceMs);
    }
    return closedAt;
  }

  private writeSidecar(entry: ResumeEntry, status: AttemptResumeStatus): void {
    const now = this.now();
    entry.updatedAt = now;
    const sidecar: AttemptResumeSidecar = {
      schemaVersion: ATTEMPT_RESUME_SCHEMA_VERSION,
      resumeId: entry.resumeId,
      runId: entry.runId,
      activityId: entry.activityId,
      attemptId: entry.attemptId,
      sessionId: entry.sessionId,
      originalSessionId: entry.originalSessionId,
      cliSessionId: entry.cliSessionId,
      webPort: entry.webPort,
      writeToken: entry.writeToken,
      status,
      larkAppId: entry.larkAppId,
      botName: entry.botName,
      cliId: entry.cliId,
      workingDir: entry.workingDir,
      logPath: entry.logPath,
      startedAt: entry.startedAt,
      updatedAt: now,
      ...(status === 'closed' ? { closedAt: now, closeReason: entry.closeReason } : {}),
    };
    mkdirSync(dirname(entry.sidecarPath), { recursive: true });
    atomicWriteFileSync(entry.sidecarPath, JSON.stringify(sidecar, null, 2));
  }

  private resumeUrl(webPort: number, writeToken: string): string {
    return `http://${this.deps.externalHost}:${webPort}?token=${encodeURIComponent(writeToken)}`;
  }
}

function validateAttemptIds(input: {
  runId: string;
  activityId: string;
  attemptId: string;
}): { ok: true } | { ok: false; error: string } {
  if (!isValidRunId(input.runId)) return { ok: false, error: 'bad_run_id' };
  if (!isValidPathSegment(input.activityId) || !isValidPathSegment(input.attemptId)) {
    return { ok: false, error: 'bad_attempt_id' };
  }
  return { ok: true };
}

function resumeKey(input: { runId: string; activityId: string; attemptId: string }): ResumeKey {
  return `${input.runId}\n${input.activityId}\n${input.attemptId}`;
}

function readTerminalSidecar(
  runsDir: string,
  input: { runId: string; activityId: string; attemptId: string },
): { ok: true; terminal: AttemptTerminalSidecar } | { ok: false; error: string } {
  const runDir = join(runsDir, input.runId);
  const sidecarPath = attemptTerminalSidecarPath(runDir, input.activityId, input.attemptId);
  if (!isPathInsideDir(runsDir, sidecarPath)) return { ok: false, error: 'bad_path' };
  if (!existsSync(sidecarPath)) return { ok: false, error: 'no_terminal_sidecar' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
  } catch {
    return { ok: false, error: 'bad_terminal_sidecar' };
  }
  if (!isTerminalSidecar(parsed)) return { ok: false, error: 'bad_terminal_sidecar' };
  return { ok: true, terminal: parsed };
}

function isTerminalSidecar(raw: unknown): raw is AttemptTerminalSidecar {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const r = raw as Partial<AttemptTerminalSidecar>;
  return (
    r.schemaVersion === ATTEMPT_TERMINAL_SCHEMA_VERSION &&
    typeof r.sessionId === 'string' &&
    typeof r.webPort === 'number' &&
    (r.status === 'live' || r.status === 'closed')
  );
}

export function isResumeCapableCli(cliId: string | undefined): boolean {
  return !!cliId && (RESUME_USES_SESSION_ID.has(cliId) || RESUME_REQUIRES_CLI_SESSION_ID.has(cliId));
}

export function cliRequiresNativeSessionId(cliId: string | undefined): boolean {
  return !!cliId && RESUME_REQUIRES_CLI_SESSION_ID.has(cliId);
}

function appendResumeLog(logPath: string, label: string, content: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  const body = content.endsWith('\n') ? content : `${content}\n`;
  appendFileSync(logPath, `[${new Date().toISOString()}] ${label} ${body}`, 'utf-8');
}

function expandWorkflowWorkingDir(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  if (dir === '~') return homedir();
  if (dir.startsWith('~/')) return join(homedir(), dir.slice(2));
  return dir;
}

function defaultWorkerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'worker.js');
}
