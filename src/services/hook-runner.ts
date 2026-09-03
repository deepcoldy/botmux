import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { logger } from '../utils/logger.js';
import { fetchDaemonIpc, loadDaemonIpcSecret } from '../core/daemon-ipc-auth.js';
import { resolveSessionContext } from '../core/session-marker.js';
import { readManagedOriginCapability } from '../core/managed-origin-capability.js';
import { loopbackFetch } from '../core/loopback-fetch.js';

export const HOOK_EVENTS = [
  'topic.new',
  'thread.reply',
  'prompt.submit',
  'outbound.send',
  'outbound.reply',
  'schedule.fired',
  'session.start',
  'session.exit',
  'session.idle',
  'session.requires_attention',
] as const;

export type HookEvent = typeof HOOK_EVENTS[number];

/**
 * Events whose emit point can actually WAIT for a verdict and act on it.
 *
 * `mode: 'sync'` is only honoured here. Every other event is emitted from a
 * fire-and-forget site (`emitHookEvent` returns void, callers never await), so
 * declaring sync on them would buy nothing but latency while still reading as
 * "this hook can block" to the operator. Those degrade to async with a warning
 * rather than silently pretending to gate — see `loadHookConfigs`.
 */
export const GATE_EVENTS: readonly HookEvent[] = ['prompt.submit'] as const;

export function isGateEvent(event: HookEvent): boolean {
  return GATE_EVENTS.includes(event);
}

/** A hook that actually adjudicates (blocking) rather than merely observing. */
function isSyncGateHook(hook: { event: HookEvent; mode?: 'sync' | 'async' }): boolean {
  return hook.mode === 'sync' && isGateEvent(hook.event);
}

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
  /** 'sync' 只对 GATE_EVENTS 生效：daemon 等它跑完并按裁决放行/拒绝。
   *  其余事件声明 sync 会在加载时降级为 async 并告警（见 normalizeHookConfig）。 */
  mode?: 'sync' | 'async';
  /** sync hook 自身失败（超时 / spawn 不到 / 命令崩溃）时的兜底方向。
   *  默认 'allow'（fail-open）：hook 坏掉不该把整个 bot 变成砖头。
   *  要「校验器挂了就一律不放行」的部署显式写 'deny'（fail-closed）。 */
  onError?: 'allow' | 'deny';
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

/** Frozen authority for a read-isolated post-provider hook. Every value comes
 * from the original protected claim/attestation; forwarding must not rediscover
 * a daemon or reread a rotating capability after the fence. */
export interface ManagedHookOrigin {
  ipcPort: number;
  sessionId: string;
  capability: string;
  turnId: string;
  dispatchAttempt?: number;
}

export interface EmitHookEventOptions {
  managedOrigin?: ManagedHookOrigin;
}

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
  /** Only populated when `captureStdout` was requested (sync gate hooks).
   *  Async hooks keep stdio[1]='ignore' so a chatty hook cannot fill a pipe
   *  nobody drains and wedge itself. */
  stdout?: string;
};

type RunHookCommandOptions = {
  fireAndForget?: boolean;
  captureStdout?: boolean;
};

const DEFAULT_TIMEOUT_MS = 5_000;
/** Sync gate hooks answer with a small JSON verdict; anything past this is
 *  debug spew we refuse to buffer unboundedly in the long-lived daemon. */
const STDOUT_CAPTURE_LIMIT = 64_000;
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
  // A `sync` declaration on a non-gate event is an operator mistake worth
  // saying out loud: the emit site there is fire-and-forget, so the hook would
  // run exactly as before while the config claims it gates. Degrade to async
  // and warn rather than honour a promise the call site cannot keep.
  if (rec.mode === 'sync') {
    if (isGateEvent(hook.event)) {
      hook.mode = 'sync';
    } else {
      hook.mode = 'async';
      logger.warn(
        `[hooks] mode:'sync' is not supported for event '${hook.event}' `
        + `(only ${GATE_EVENTS.join(', ')} can block); running it as async.`,
      );
    }
  } else if (rec.mode === 'async') {
    hook.mode = 'async';
  }
  if (rec.onError === 'allow' || rec.onError === 'deny') {
    hook.onError = rec.onError;
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
  // A sync gate hook DECIDES on this content, so truncating it would make the
  // gate structurally blind past CONTENT_PREVIEW_LIMIT: an attacker just pads
  // 600 chars and hides the payload behind them. (Verified before the fix: a
  // grep-for-`rm -rf /` gate allowed `'A'.repeat(700) + ' rm -rf /'` while
  // correctly denying the same string when short.) The preview limit exists to
  // keep notification hooks from swallowing huge payloads — that rationale
  // does not apply to a verdict input. Privacy note for operators is in
  // hooks.md: configuring a sync gate hands it the full message text.
  const allowFullContent = isSyncGateHook(hook)
    || !!hook.redact?.fullContentEvents?.includes(rawPayload.event);
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
    let stdout = '';
    const child = spawn(parsed.file, parsed.args, {
      shell: false,
      // stdout stays 'ignore' for async hooks: nothing drains it there, and a
      // chatty hook would block on a full pipe. Sync gate hooks need the
      // verdict, so they get a pipe (drained below, capped like stderr).
      stdio: ['pipe', options.captureStdout ? 'pipe' : 'ignore', 'pipe'],
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
      settle({ ok: false, timedOut: true, code: null, signal: null, error: 'hook timed out', stdout });
    }, timeoutFor(hook));
    if (options.fireAndForget) timer.unref();

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => {
      stderr += String(chunk);
      if (stderr.length > 2_000) stderr = stderr.slice(-2_000);
    });

    // Keep the HEAD of stdout, not the tail. parseHookVerdict requires the
    // WHOLE of stdout to be one JSON object, so verdict-then-debug-noise does
    // NOT parse — it falls back to the exit code. Keeping the head means the
    // verdict is at least intact for diagnosis in that case, and a hook that
    // only prints its verdict is unaffected. (stderr keeps the tail instead:
    // there the last error is what matters.)
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => {
      if (stdout.length < STDOUT_CAPTURE_LIMIT) stdout += String(chunk);
    });

    child.on('error', (err) => {
      settle({ ok: false, timedOut, error: err.message, stdout });
    });

    child.on('close', (code, signal) => {
      settle({
        ok: code === 0 && !timedOut,
        code,
        signal,
        timedOut,
        stdout,
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

export function emitHookEvent(
  event: HookEvent,
  body: Record<string, unknown> = {},
  options: EmitHookEventOptions = {},
): void {
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
    if (options.managedOrigin
      || (process.env.BOTMUX_SESSION_ID && process.env.BOTMUX_LARK_APP_ID)) {
      void forwardEmitToDaemon(
        event,
        payload,
        process.env.BOTMUX_LARK_APP_ID ?? '',
        options.managedOrigin,
      );
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
  const hooks = loadHookConfigs().filter(hook =>
    hook.event === event
    // A sync gate hook already ran (and was awaited) in evaluatePromptGate.
    // Without this it would spawn a SECOND time here as a notification —
    // double side effects, and a hook that denied would still see its own
    // event replayed as if nothing happened.
    && hook.mode !== 'sync'
    && filterMatches(hook.filter, payload));
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

export function runHookCommandForTest(
  hook: HookConfig,
  payload: HookPayload,
  options: RunHookCommandOptions = {},
): Promise<HookRunResult> {
  return runHookCommand(hook, payload, options);
}

// ─── 同步前置校验闸（sync gate hooks） ──────────────────────────────────────
//
// 与上面的 async hook 是两条不同的契约：async hook 是「通知」，跑完没人看结果；
// sync gate hook 是「裁决」，daemon 等它、读它、按它放行或拒绝。
//
// 判据优先级（两者都给以 stdout 为准）：
//   1) stdout 是 JSON 且带 `decision` → 按 decision（'allow' | 'deny'），
//      可选 `reason` 会回给用户。这是推荐写法：能带拒绝原因。
//   2) 没有可解析的 JSON verdict → 退回退出码：0 = allow，非 0 = deny。
//      让「一个只会 exit 1 的老脚本」不用改也能当校验器用。
//
// 三条铁律：
//   • hook 自身失败（超时/spawn 不到/崩溃且没给 verdict）不按 deny 处理，
//     走 `onError`，默认 fail-open——校验器挂掉不该让整个 bot 变砖头。
//     真要 fail-closed 的部署显式写 onError:'deny'。
//   • 多个 sync hook 是 AND：任一 deny 即拒绝，第一个 deny 短路，其余不再跑。
//   • 无论如何都返回裁决，绝不抛异常——这条链路在 daemon 的收信主路上。
//
// 延迟的影响面：bot 级 admission 是**并发**的，所以一个慢闸只拖它自己那一轮，
// 不会卡住整个 daemon。但同一话题的续聊持有 per-anchor FIFO 锁（daemon.ts
// `thread-delivery:` 键），慢闸会让同话题的后续消息排队——所以 timeoutMs
// 该设小（1-3s），别指望用大超时兜住一个慢服务。

export type PromptGateDecision = {
  allowed: boolean;
  /** 拒绝原因（回给用户）。allow 时通常为空。 */
  reason?: string;
  /** 做出该裁决的 hook 命令（日志用，已截断）。 */
  source?: string;
  /** 该裁决是不是 hook 自身失败后的 onError 兜底，而非它真的表了态。 */
  fromError?: boolean;
};

// Frozen: this single instance is handed to every allow path, so an in-place
// mutation by a future caller would silently corrupt every later verdict.
const GATE_ALLOW: PromptGateDecision = Object.freeze({ allowed: true });
/** 拒绝原因回显给用户前的长度上限——hook 的 stderr/stdout 不该变成刷屏面。 */
const GATE_REASON_LIMIT = 300;

function parseHookVerdict(stdout: string | undefined): { decision: 'allow' | 'deny'; reason?: string } | null {
  if (!stdout) return null;
  const text = stdout.trim();
  if (!text) return null;
  // 只认整段 JSON 对象。不做「从一堆日志里捞 JSON」的模糊匹配：那会让 hook 打印
  // 的一行调试日志意外变成裁决，把安全闸变成猜谜。
  if (!text.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  const decision = rec.decision;
  if (decision !== 'allow' && decision !== 'deny') return null;
  const reason = typeof rec.reason === 'string' && rec.reason.trim()
    ? rec.reason.trim().slice(0, GATE_REASON_LIMIT)
    : undefined;
  return { decision, reason };
}

/** 单个 sync hook 的裁决。不抛异常。 */
async function evaluateOneGateHook(hook: HookConfig, payload: HookPayload): Promise<PromptGateDecision> {
  const source = hook.command.slice(0, 60);
  let result: HookRunResult;
  try {
    result = await runHookCommand(hook, prepareHookPayload(hook, payload), { captureStdout: true });
  } catch (err: any) {
    // runHookCommand 本身按契约不 reject，这里只是结构性兜底。
    const failOpen = (hook.onError ?? 'allow') === 'allow';
    logger.warn(`[hooks] gate ${source} crashed: ${err?.message ?? String(err)} → ${failOpen ? 'allow' : 'deny'}`);
    return failOpen
      ? { allowed: true, source, fromError: true }
      : { allowed: false, reason: 'permission check failed', source, fromError: true };
  }

  // stdout 的 verdict 优先于退出码：一个 exit 1 但明说 decision:'allow' 的
  // hook，意图是放行（退出码可能只是它内部某步没成功）。
  const verdict = parseHookVerdict(result.stdout);
  if (verdict) {
    return verdict.decision === 'allow'
      ? { allowed: true, source }
      : { allowed: false, reason: verdict.reason, source };
  }

  // 没有 verdict 且 hook 没能正常跑完 → 这是「校验器坏了」，不是「用户没权限」。
  // 关键区分：超时 / spawn 失败（ENOENT）走 onError；命令正常跑完只是 exit 非 0
  // 的，那是它在用退出码表态 deny。
  const brokeDown = result.timedOut || result.code === undefined || result.code === null;
  if (brokeDown) {
    const failOpen = (hook.onError ?? 'allow') === 'allow';
    logger.warn(
      `[hooks] gate ${source} did not return a verdict (${result.error ?? 'unknown failure'}) `
      + `→ onError=${failOpen ? 'allow' : 'deny'}`,
    );
    return failOpen
      ? { allowed: true, source, fromError: true }
      : { allowed: false, reason: 'permission check failed', source, fromError: true };
  }

  if (result.code === 0) return { allowed: true, source };
  return {
    allowed: false,
    reason: result.error?.trim().slice(0, GATE_REASON_LIMIT) || undefined,
    source,
  };
}

/**
 * 跑齐某个 gate 事件上所有 `mode:'sync'` 的 hook，返回合并裁决（AND 语义）。
 *
 * 没有配任何 sync hook 时零开销直接放行——绝大多数部署走的就是这条路径，
 * 不能因为加了这个能力就给每条消息都加一次 spawn。
 */
export async function evaluatePromptGate(
  event: HookEvent,
  body: Record<string, unknown> = {},
): Promise<PromptGateDecision> {
  try {
    if (!isGateEvent(event)) return GATE_ALLOW;
    const payload: HookPayload = {
      ...body,
      event,
      emittedAt: new Date().toISOString(),
    };
    const hooks = loadHookConfigs().filter(hook =>
      hook.event === event
      && hook.mode === 'sync'
      && filterMatches(hook.filter, payload));
    if (hooks.length === 0) return GATE_ALLOW;

    // 记住「有 hook 是坏掉后被兜过去的」。全允许时也要把这一位带出去：
    // 「校验器明确放行」和「校验器挂了我们放行」对运维是两件事，后者需要能被
    // 观测到，否则一个一直在超时的闸会安静地等于没装。
    let sawFailOpen = false;
    for (const hook of hooks) {
      const decision = await evaluateOneGateHook(hook, payload);
      // 第一个 deny 短路：后面的 hook 不再跑，省掉一次无意义的 spawn，
      // 也让「拒绝原因」有确定的归属（就是这个 hook 说的）。
      if (!decision.allowed) {
        logger.info(
          `[hooks] gate ${event} DENIED by ${decision.source}`
          + `${decision.reason ? `: ${decision.reason}` : ''}`,
        );
        return decision;
      }
      if (decision.fromError) sawFailOpen = true;
    }
    return sawFailOpen ? { allowed: true, fromError: true } : GATE_ALLOW;
  } catch (err: any) {
    // 这条链路在收信主路上：任何未预期的异常都必须变成放行，不能把消息吞掉。
    logger.warn(`[hooks] gate ${event} evaluation crashed, allowing: ${err?.message ?? String(err)}`);
    return { allowed: true, fromError: true };
  }
}


const HOOK_FORWARD_FETCH_TIMEOUT_MS = 2_000;

/**
 * CLI-side: hand off hook emission to the daemon so timeout enforcement and
 * process-group cleanup work. Best-effort — daemon unreachable / 4xx / 5xx
 * just log and drop, hooks are best-effort by contract.
 */
export async function forwardEmitToDaemon(
  event: HookEvent,
  payload: HookPayload,
  larkAppId: string,
  managedOrigin?: ManagedHookOrigin,
): Promise<void> {
  try {
    const daemon = managedOrigin ? undefined : findOnlineDaemon(larkAppId);
    const ipcPort = managedOrigin?.ipcPort ?? daemon?.ipcPort;
    if (!ipcPort) {
      logger.debug(`[hooks] CLI forward: no daemon for ${larkAppId}, dropping ${event}`);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HOOK_FORWARD_FETCH_TIMEOUT_MS);
    timer.unref();
    try {
      const sessionId = managedOrigin?.sessionId ?? process.env.BOTMUX_SESSION_ID;
      const origin = managedOrigin
        ? undefined
        : resolveSessionContext(config.session.dataDir, sessionId);
      const originCapability = managedOrigin?.capability ?? readManagedOriginCapability(
          config.session.dataDir,
          sessionId,
          process.env.BOTMUX_SEND_RELAY,
          process.env.BOTMUX_ORIGIN_CHANNEL_ID,
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
          originTurnId: managedOrigin?.turnId ?? origin?.turnId ?? process.env.BOTMUX_TURN_ID,
          originDispatchAttempt: managedOrigin?.dispatchAttempt ?? origin?.dispatchAttempt
            ?? (Number.isSafeInteger(envAttempt) && envAttempt > 0 ? envAttempt : undefined),
        }),
        signal: ctrl.signal,
      } satisfies RequestInit;
      let secret: string | undefined;
      try { secret = loadDaemonIpcSecret(); } catch { /* Seatbelt/read-isolated CLI */ }
      const res = secret
        ? await fetchDaemonIpc(ipcPort, '/api/hooks/emit', request, secret)
        : await loopbackFetch(`http://127.0.0.1:${ipcPort}/api/hooks/emit`, request);
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
