import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { logger } from '../utils/logger.js';
import { fetchDaemonIpc, loadDaemonIpcSecret } from '../core/daemon-ipc-auth.js';
import { resolveSessionContext } from '../core/session-marker.js';
import { readManagedOriginCapability } from '../core/managed-origin-capability.js';

export const HOOK_EVENTS = [
  'topic.new',
  'thread.reply',
  'outbound.send',
  'outbound.reply',
  'schedule.fired',
  'session.start',
  'session.exit',
  'session.idle',
  'session.requires_attention',
] as const;

export type HookEvent = typeof HOOK_EVENTS[number];

export type HookFilter = {
  chatId?: string | string[];
  senderOpenId?: string | string[];
  sender_open_id?: string | string[];
};

export type HookConfig = {
  event: HookEvent;
  command: string;
  timeoutMs?: number;
  filter?: HookFilter;
  redact?: {
    fullContentEvents?: HookEvent[];
  };
};

export type HookPayload = Record<string, unknown> & {
  event: HookEvent;
  chatId?: string;
  senderOpenId?: string;
  sender_open_id?: string;
};

export type ParsedHookCommand = {
  file: string;
  args: string[];
};

export type HookRunResult = {
  ok: boolean;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  error?: string;
};

type RunHookCommandOptions = {
  fireAndForget?: boolean;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const CONTENT_PREVIEW_LIMIT = 600;
const CONTENT_FIELDS = ['content', 'message', 'description', 'finalOutput', 'lastScreenContent'] as const;

let envHookCache: { raw: string; hooks: HookConfig[] } | null = null;
let fileHookCache: { path: string; mtimeMs: number; size: number; hooks: HookConfig[] } | null = null;

function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value);
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (typeof value === 'string' && value) return [value];
  if (Array.isArray(value)) {
    const out = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

function normalizeHookConfig(raw: unknown): HookConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (!isHookEvent(rec.event)) return null;
  if (typeof rec.command !== 'string' || rec.command.trim().length === 0) return null;

  const hook: HookConfig = {
    event: rec.event,
    command: rec.command,
  };
  if (typeof rec.timeoutMs === 'number' && Number.isFinite(rec.timeoutMs)) {
    hook.timeoutMs = rec.timeoutMs;
  }
  if (rec.filter && typeof rec.filter === 'object') {
    const filterRec = rec.filter as Record<string, unknown>;
    const filter: HookFilter = {};
    const chatId = normalizeStringList(filterRec.chatId);
    const senderOpenId = normalizeStringList(filterRec.senderOpenId ?? filterRec.sender_open_id);
    if (chatId) filter.chatId = chatId;
    if (senderOpenId) filter.senderOpenId = senderOpenId;
    if (filter.chatId || filter.senderOpenId) hook.filter = filter;
  }
  if (rec.redact && typeof rec.redact === 'object') {
    const redactRec = rec.redact as Record<string, unknown>;
    const fullContentEventsRaw = Array.isArray(redactRec.fullContentEvents)
      ? redactRec.fullContentEvents
      : [];
    const fullContentEvents = fullContentEventsRaw.filter(isHookEvent);
    if (fullContentEvents.length > 0) {
      hook.redact = { fullContentEvents };
    }
  }
  return hook;
}

function readJsonHookArray(raw: string): HookConfig[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeHookConfig).filter((h): h is HookConfig => !!h);
}

export function loadHookConfigs(opts: {
  dataDir?: string;
  env?: Pick<NodeJS.ProcessEnv, 'BOTMUX_HOOKS_JSON' | 'BOTMUX_HOOKS_FILE'>;
} = {}): HookConfig[] {
  const env = opts.env ?? process.env;
  try {
    if (env.BOTMUX_HOOKS_JSON) {
      if (envHookCache?.raw === env.BOTMUX_HOOKS_JSON) return envHookCache.hooks;
      const hooks = readJsonHookArray(env.BOTMUX_HOOKS_JSON);
      envHookCache = { raw: env.BOTMUX_HOOKS_JSON, hooks };
      return hooks;
    }

    const hooksPath = env.BOTMUX_HOOKS_FILE || join(opts.dataDir ?? config.session.dataDir, 'hooks.json');
    if (!existsSync(hooksPath)) return [];
    const stats = statSync(hooksPath);
    if (
      fileHookCache
      && fileHookCache.path === hooksPath
      && fileHookCache.mtimeMs === stats.mtimeMs
      && fileHookCache.size === stats.size
    ) {
      return fileHookCache.hooks;
    }
    const hooks = readJsonHookArray(readFileSync(hooksPath, 'utf-8'));
    fileHookCache = { path: hooksPath, mtimeMs: stats.mtimeMs, size: stats.size, hooks };
    return hooks;
  } catch (err: any) {
    logger.warn(`[hooks] Failed to load hook config: ${err?.message ?? String(err)}`);
    return [];
  }
}

export function prepareHookPayload(hook: HookConfig, rawPayload: HookPayload): HookPayload {
  const allowFullContent = !!hook.redact?.fullContentEvents?.includes(rawPayload.event);
  const payload: HookPayload = { ...rawPayload };

  for (const field of CONTENT_FIELDS) {
    const value = payload[field];
    if (typeof value !== 'string') continue;
    const lengthKey = `${field}Length`;
    const truncatedKey = `${field}Truncated`;
    payload[lengthKey] = value.length;
    if (allowFullContent || value.length <= CONTENT_PREVIEW_LIMIT) {
      payload[truncatedKey] = false;
      continue;
    }
    payload[field] = value.slice(0, CONTENT_PREVIEW_LIMIT);
    payload[truncatedKey] = true;
  }

  // Redact nested option text/label. session.requires_attention emits this
  // as `optionsPreview` (see worker-pool.ts tui_prompt case); keep `options`
  // as an alias so callers using either name get the same treatment.
  for (const arrayField of ['optionsPreview', 'options'] as const) {
    const arrayValue = payload[arrayField];
    if (!Array.isArray(arrayValue)) continue;
    payload[arrayField] = arrayValue.map(item => {
      if (!item || typeof item !== 'object') return item;
      const opt = { ...(item as Record<string, unknown>) };
      for (const field of ['text', 'label'] as const) {
        const v = opt[field];
        if (typeof v === 'string' && v.length > CONTENT_PREVIEW_LIMIT) {
          opt[field] = v.slice(0, CONTENT_PREVIEW_LIMIT);
        }
      }
      return opt;
    });
  }

  return payload;
}

export function parseHookCommand(command: string): ParsedHookCommand {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of command.trim()) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (escaping) current += '\\';
  if (quote) throw new Error('Unterminated quote in hook command');
  if (current) tokens.push(current);
  if (tokens.length === 0) throw new Error('Empty hook command');
  const [file, ...args] = tokens;
  return { file, args };
}

function valueMatchesFilter(allowed: string | string[] | undefined, actual: string | undefined): boolean {
  if (!allowed) return true;
  if (!actual) return false;
  const list = Array.isArray(allowed) ? allowed : [allowed];
  return list.includes(actual);
}

export function filterMatches(filter: HookFilter | undefined, payload: HookPayload): boolean {
  if (!filter) return true;
  const senderOpenId = payload.senderOpenId ?? payload.sender_open_id;
  return valueMatchesFilter(filter.chatId, payload.chatId)
    && valueMatchesFilter(filter.senderOpenId ?? filter.sender_open_id, senderOpenId);
}

function timeoutFor(hook: HookConfig): number {
  if (typeof hook.timeoutMs === 'number' && hook.timeoutMs >= 0) return hook.timeoutMs;
  return DEFAULT_TIMEOUT_MS;
}

async function runHookCommand(
  hook: HookConfig,
  payload: HookPayload,
  options: RunHookCommandOptions = {},
): Promise<HookRunResult> {
  let parsed: ParsedHookCommand;
  try {
    parsed = parseHookCommand(hook.command);
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }

  return new Promise<HookRunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let stderr = '';
    const child = spawn(parsed.file, parsed.args, {
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
      // detached so we can kill the whole process group (grandchildren included)
      detached: true,
      env: {
        // Minimal allowlist — avoids leaking secrets (LARK_APP_SECRET, API keys, etc.)
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        SHELL: process.env.SHELL ?? '/bin/sh',
        USER: process.env.USER,
        LOGNAME: process.env.LOGNAME,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        BOTMUX_HOOK_EVENT: payload.event,
      },
    });
    if (options.fireAndForget) {
      // Unref both the process handle and the stderr pipe. child.unref() alone
      // still leaves piped stdio referenced, making short-lived CLI commands
      // wait for hooks to finish.
      child.unref();
      (child.stderr as any)?.unref?.();
    }

    const settle = (result: HookRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
          setTimeout(() => {
            if (!settled && child.pid !== undefined) {
              try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
            }
          }, 250).unref();
        } else {
          child.kill('SIGTERM');
        }
      } catch { /* process may already be gone */ }
      // Actively settle — don't wait for 'close' which may never fire if a
      // grandchild process holds the stderr pipe open.
      settle({ ok: false, timedOut: true, code: null, signal: null, error: 'hook timed out' });
    }, timeoutFor(hook));
    if (options.fireAndForget) timer.unref();

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => {
      stderr += String(chunk);
      if (stderr.length > 2_000) stderr = stderr.slice(-2_000);
    });

    child.on('error', (err) => {
      settle({ ok: false, timedOut, error: err.message });
    });

    child.on('close', (code, signal) => {
      settle({
        ok: code === 0 && !timedOut,
        code,
        signal,
        timedOut,
        error: code === 0 && !timedOut ? undefined : (stderr.trim() || `hook exited code=${code} signal=${signal ?? 'none'}`),
      });
    });

    // Hooks that don't drain stdin and exit fast (touch/echo/notify-send,
    // `botmux send`, …) close their read end before this write flushes →
    // EPIPE on the stdin socket. Without a listener that 'error' is unhandled;
    // in the long-lived daemon (no global uncaughtException handler) it would
    // crash the whole process. The hook already spawned, so swallow it.
    child.stdin?.on('error', () => { /* EPIPE: fast-exiting hook closed stdin */ });
    child.stdin?.end(JSON.stringify(payload), () => {
      if (options.fireAndForget) (child.stdin as any)?.unref?.();
    });
  });
}

export function emitHookEvent(event: HookEvent, body: Record<string, unknown> = {}): void {
  try {
    const payload: HookPayload = {
      ...body,
      event,
      emittedAt: new Date().toISOString(),
    };

    // CLI context: forward to the long-lived daemon so its event loop
    // supervises the timeout/process-group kill. Short-lived `botmux send`
    // can't enforce timeouts itself — fireAndForget unrefs the timer, so a
    // runaway hook would survive as an orphan. The daemon stays alive, its
    // timer fires reliably, and `process.kill(-pid)` cleans the whole group.
    // The daemon itself must never take this branch — it boots with
    // session-scoped env scrubbed (index-daemon.ts) and its /api/hooks/emit
    // handler calls emitHookEventLocal, so the gate can't self-forward even
    // if leaked env survives somewhere.
    if (process.env.BOTMUX_SESSION_ID && process.env.BOTMUX_LARK_APP_ID) {
      void forwardEmitToDaemon(event, payload, process.env.BOTMUX_LARK_APP_ID);
      return;
    }

    runHooksLocally(payload);
  } catch (err: any) {
    logger.warn(`[hooks] Failed to emit ${event}: ${err?.message ?? String(err)}`);
  }
}

/**
 * Daemon-side emit: always run hooks in-process, never forward. The
 * /api/hooks/emit handler MUST use this instead of emitHookEvent — re-entering
 * the CLI gate there means a daemon that accidentally carries session-scoped
 * env (e.g. `botmux restart` issued from inside a botmux session: pm2
 * startOrRestart injects the caller's environment into the restarted daemon)
 * would POST every event back to itself in an infinite loop — one core pegged
 * and hundreds of self-connections on the IPC port, with nothing in the logs.
 */
export function emitHookEventLocal(event: HookEvent, body: Record<string, unknown> = {}): void {
  try {
    const payload: HookPayload = {
      ...body,
      event,
      emittedAt: new Date().toISOString(),
    };
    runHooksLocally(payload);
  } catch (err: any) {
    logger.warn(`[hooks] Failed to emit ${event}: ${err?.message ?? String(err)}`);
  }
}

function runHooksLocally(payload: HookPayload): void {
  const event = payload.event;
  const hooks = loadHookConfigs().filter(hook => hook.event === event && filterMatches(hook.filter, payload));
  if (hooks.length === 0) return;

  for (const [i, hook] of hooks.entries()) {
    const hookPayload = prepareHookPayload(hook, payload);
    const tag = `${event}[${i}] (${hook.command.slice(0, 60)})`;
    void runHookCommand(hook, hookPayload, { fireAndForget: true }).then(result => {
      if (!result.ok) {
        logger.warn(`[hooks] ${tag} failed: ${result.error ?? `code=${result.code} signal=${result.signal ?? 'none'}`}`);
      } else {
        logger.debug(`[hooks] ${tag} completed`);
      }
    }).catch((err: any) => {
      logger.warn(`[hooks] ${tag} crashed: ${err?.message ?? String(err)}`);
    });
  }
}

export function runHookCommandForTest(hook: HookConfig, payload: HookPayload): Promise<HookRunResult> {
  return runHookCommand(hook, payload);
}

const HOOK_FORWARD_FETCH_TIMEOUT_MS = 2_000;

/**
 * CLI-side: hand off hook emission to the daemon so timeout enforcement and
 * process-group cleanup work. Best-effort — daemon unreachable / 4xx / 5xx
 * just log and drop, hooks are best-effort by contract.
 */
async function forwardEmitToDaemon(event: HookEvent, payload: HookPayload, larkAppId: string): Promise<void> {
  try {
    const daemon = findOnlineDaemon(larkAppId);
    if (!daemon) {
      logger.debug(`[hooks] CLI forward: no daemon for ${larkAppId}, dropping ${event}`);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HOOK_FORWARD_FETCH_TIMEOUT_MS);
    timer.unref();
    try {
      const sessionId = process.env.BOTMUX_SESSION_ID;
      const origin = resolveSessionContext(config.session.dataDir, sessionId);
      const originCapability = readManagedOriginCapability(
        config.session.dataDir,
        sessionId,
        process.env.BOTMUX_SEND_RELAY,
      )?.capability;
      const envAttempt = Number(process.env.BOTMUX_DISPATCH_ATTEMPT);
      const request = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event,
          payload,
          sessionId,
          originCapability,
          originTurnId: origin?.turnId ?? process.env.BOTMUX_TURN_ID,
          originDispatchAttempt: origin?.dispatchAttempt
            ?? (Number.isSafeInteger(envAttempt) && envAttempt > 0 ? envAttempt : undefined),
        }),
        signal: ctrl.signal,
      } satisfies RequestInit;
      let secret: string | undefined;
      try { secret = loadDaemonIpcSecret(); } catch { /* Seatbelt/read-isolated CLI */ }
      const res = secret
        ? await fetchDaemonIpc(daemon.ipcPort, '/api/hooks/emit', request, secret)
        : await fetch(`http://127.0.0.1:${daemon.ipcPort}/api/hooks/emit`, request);
      if (!res.ok) {
        logger.warn(`[hooks] CLI forward ${event} → daemon: HTTP ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    logger.warn(`[hooks] CLI forward ${event} failed: ${err?.message ?? String(err)}`);
  }
}
