/**
 * Breakdown snapshot for the "late native session id never reached the daemon"
 * wait (#3455).
 *
 * When that wait times out, the default error only carries worker logs and IPC
 * messages, so a red run cannot say WHERE the chain broke. This helper walks the
 * exact production chain for a Claude + tmux session and reports each link's
 * state at the moment of failure:
 *
 *   1. pid-state gate file — the test withholds the fake CLI's pid-state record
 *      until this file exists; a missing gate means the fake was never released.
 *   2. `~/.claude/sessions/<pid>.json` — what the fake actually wrote (the
 *      adapter's `resolveJsonlFromPid` reads this; pid/sessionId/cwd/procStart
 *      are exactly the fields its validation gates on).
 *   3. worker IPC — whether a `cli_session_id` and a native-identified
 *      `runtime_binding` were ever emitted (the worker's produce side).
 *   4. daemon store runtime identity — what the contract currently holds
 *      (the consume side the wait polls).
 *
 * Reading it bottom-to-top after a failure pinpoints the broken link instead of
 * leaving "timed out" as the only signal. Every filesystem access is fail-safe:
 * diagnostics must never throw and mask the original timeout.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal shape of the worker→daemon messages this inspection needs; callers
 *  pass the harness's full `WorkerToDaemon[]`, which is assignable to this. */
export interface NativeIdentityChainMessage {
  type: string;
  identity?: { nativeSessionId?: unknown; [key: string]: unknown };
  cliSessionId?: unknown;
  [key: string]: unknown;
}

export interface NativeIdentityChainInput {
  /** Harness `pidStateGate` path — its existence releases the fake's pid write. */
  pidStateGate: string;
  /** Harness `claudeDir`; the fake writes `sessions/<pid>.json` under it. */
  claudeDir: string;
  /** Snapshot of `controller.store.runtime(ref)?.identity` at failure time. */
  runtimeIdentity: unknown;
  /** The worker child's accumulated IPC messages (harness `g.messages`). */
  messages: ReadonlyArray<NativeIdentityChainMessage>;
}

function safeReadJson(path: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'record is not a JSON object' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function describePidStateRecords(claudeDir: string): string {
  const sessionsDir = join(claudeDir, 'sessions');
  if (!existsSync(sessionsDir)) return `  sessions/ dir: MISSING (${sessionsDir})`;
  let names: string[];
  try {
    names = readdirSync(sessionsDir).filter(n => n.endsWith('.json')).sort();
  } catch (error) {
    return `  sessions/ dir: UNREADABLE (${error instanceof Error ? error.message : String(error)})`;
  }
  if (names.length === 0) return '  sessions/ dir: present but contains no *.json pid-state record';
  return names.map((name) => {
    const path = join(sessionsDir, name);
    const parsed = safeReadJson(path);
    if (!parsed.ok) return `  ${name}: UNPARSEABLE (${parsed.error})`;
    const r = parsed.value;
    const fields = ['pid', 'sessionId', 'cwd', 'procStart', 'kind', 'version']
      .filter(k => k in r)
      .map(k => `${k}=${JSON.stringify(r[k])}`)
      .join(' ');
    return `  ${name}: ${fields || '(no recognised fields)'}`;
  }).join('\n');
}

/**
 * Render a human-readable, deterministic snapshot of every link in the native
 * identity chain. Never throws; returns a string suitable for appending to an
 * assertion/timeout error message.
 */
export function describeNativeIdentityChain(input: NativeIdentityChainInput): string {
  const gateExists = existsSync(input.pidStateGate);
  const cliSessionIdMessages = input.messages.filter(m => m.type === 'cli_session_id');
  const nativeBindings = input.messages.filter(
    m => m.type === 'runtime_binding' && typeof m.identity?.nativeSessionId === 'string',
  );
  const identity = (input.runtimeIdentity ?? null) as { nativeSessionId?: unknown; proof?: unknown; [k: string]: unknown } | null;
  const storeNativeId = identity && typeof identity.nativeSessionId === 'string' ? identity.nativeSessionId : undefined;

  const lines = [
    'native identity chain snapshot (failure-time):',
    `1. pid-state gate file: ${gateExists ? 'PRESENT' : 'MISSING'} (${input.pidStateGate})`,
    '2. fake CLI pid-state records:',
    describePidStateRecords(input.claudeDir),
    `3. worker IPC: cli_session_id emitted ${cliSessionIdMessages.length}x`
      + `${cliSessionIdMessages.length ? ` (last cliSessionId=${JSON.stringify(cliSessionIdMessages.at(-1)?.cliSessionId)})` : ''}`
      + `; runtime_binding carrying nativeSessionId emitted ${nativeBindings.length}x`,
    '4. daemon store runtime identity: '
      + (identity === null ? 'no runtime bound' : JSON.stringify(identity)),
    storeNativeId
      ? `   -> store DOES hold nativeSessionId=${JSON.stringify(storeNativeId)}; the chain is connected, so a timeout here points at the wait mechanism, not identity production`
      : '   -> store holds NO nativeSessionId; the chain is broken at or before the daemon',
  ];
  return lines.join('\n');
}
