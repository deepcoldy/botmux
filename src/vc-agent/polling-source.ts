import { spawnSync } from 'node:child_process';
import { normalizeVcMeetingEvents } from './normalizer.js';
import type { NormalizedVcMeetingBatch } from './types.js';

/** Minimum lark-cli version that supports `--as bot` for VC meeting commands. */
export const MIN_LARK_CLI_VERSION_FOR_VC_BOT = '1.0.66';

export interface LarkCliVersionInfo {
  /** Raw version string, e.g. "1.0.66". */
  version: string;
  /** True when `version >= MIN_LARK_CLI_VERSION_FOR_VC_BOT`. */
  meetsVcBotRequirement: boolean;
}

/**
 * Run `lark-cli --version` and parse the result. Returns `null` when lark-cli
 * is not installed or the version string cannot be parsed.
 */
export function checkLarkCliVersion(): LarkCliVersionInfo | null {
  const result = spawnSync('lark-cli', ['--version'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  const match = (result.stdout ?? '').trim().match(/(\d+\.\d+\.\d+)/);
  if (!match) return null;
  const version = match[1];
  return {
    version,
    meetsVcBotRequirement: compareSemver(version, MIN_LARK_CLI_VERSION_FOR_VC_BOT) >= 0,
  };
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface LarkCliRunOptions {
  profile?: string;
  /** Bound synchronous lark-cli execution so daemon restore cannot hang the
   * event loop forever when the child process or network stalls. */
  timeoutMs?: number;
}

export interface FetchMeetingEventsOptions extends LarkCliRunOptions {
  meetingId: string;
  pageToken?: string;
  pageSize?: number;
  pageAll?: boolean;
  start?: string;
  end?: string;
}

export interface JoinMeetingOptions extends LarkCliRunOptions {
  meetingNumber: string;
  password?: string;
  /** Correlation ID forwarded from the invite event (lark-cli >= 1.0.66). */
  callId?: string;
}

export interface SendMeetingMessageOptions extends LarkCliRunOptions {
  meetingId: string;
  text: string;
  uuid?: string;
}

function parseCliJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const objectStart = trimmed.search(/[\[{]/);
    if (objectStart >= 0) return JSON.parse(trimmed.slice(objectStart));
    throw new Error('lark-cli returned non-JSON output');
  }
}

export function runLarkCliJson(args: string[], opts: { timeoutMs?: number } = {}): unknown {
  const timeoutMs = typeof opts.timeoutMs === 'number'
    && Number.isFinite(opts.timeoutMs)
    && opts.timeoutMs > 0
    ? Math.floor(opts.timeoutMs)
    : undefined;
  const result = spawnSync('lark-cli', args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      throw new Error(`lark-cli ${args.join(' ')} timed out after ${timeoutMs}ms`);
    }
    throw new Error(`lark-cli ${args.join(' ')} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(`lark-cli ${args.join(' ')} failed: ${stderr || stdout || `exit ${result.status}`}`);
  }
  return parseCliJson(result.stdout ?? '');
}

function firstErrorString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/** One entry from `lark-cli profile list --format json` (extra fields ignored). */
interface LarkCliProfileEntry {
  name: string;
  appId?: string;
  brand?: string;
  active?: boolean;
}

/** Injectable lark-cli surface so provisioning can be unit-tested without a
 *  real lark-cli or `node:child_process` module mock. Production uses spawnSync. */
export interface LarkCliProfileDeps {
  /** Return the names lark-cli currently knows, or null when it can't be
   *  enumerated (missing binary / non-zero exit / unparseable output). */
  listProfileNames(timeoutMs?: number): string[] | null;
  /** Run `profile add` from the secret (stdin). Returns the raw outcome. */
  addProfile(input: {
    profileName: string;
    appId: string;
    appSecret: string;
    brand: string;
    timeoutMs?: number;
  }): { status: number | null; stderr?: string; stdout?: string };
}

const defaultLarkCliProfileDeps: LarkCliProfileDeps = {
  listProfileNames(timeoutMs) {
    // NB: `profile list` outputs JSON by default and REJECTS `--format json`
    // ("unknown flag", exit 2). Do not add an output-format flag here.
    const result = spawnSync('lark-cli', ['profile', 'list'], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs ?? 10_000,
    });
    if (result.status !== 0) return null;
    let parsed: unknown;
    try {
      parsed = parseCliJson(result.stdout ?? '');
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const out: string[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const name = (entry as Record<string, unknown>).name;
        if (typeof name === 'string' && name.trim()) out.push(name.trim());
      }
    }
    return out;
  },
  addProfile({ profileName, appId, appSecret, brand, timeoutMs }) {
    const result = spawnSync('lark-cli', [
      'profile', 'add',
      '--app-id', appId,
      '--name', profileName,
      '--brand', brand,
      '--app-secret-stdin',
    ], {
      encoding: 'utf-8',
      input: appSecret,
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs ?? 30_000,
    });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  },
};

/**
 * List the profiles lark-cli currently knows about. Returns [] when lark-cli
 * is missing/errors — callers treat "cannot enumerate" the same as "profile
 * absent" and fall through to a provisioning attempt (which surfaces the real
 * error) rather than guessing a profile exists.
 */
export function listLarkCliProfiles(
  opts: { timeoutMs?: number } = {},
  deps: LarkCliProfileDeps = defaultLarkCliProfileDeps,
): LarkCliProfileEntry[] {
  const names = deps.listProfileNames(opts.timeoutMs);
  return (names ?? []).map((name) => ({ name }));
}

/** Does lark-cli already have a profile with this exact name? */
export function larkCliProfileExists(
  profileName: string,
  opts: { timeoutMs?: number } = {},
  deps: LarkCliProfileDeps = defaultLarkCliProfileDeps,
): boolean {
  const target = profileName.trim();
  if (!target) return false;
  return listLarkCliProfiles(opts, deps).some((p) => p.name === target);
}

export interface EnsureLarkCliBotProfileOptions {
  profileName: string;
  appId: string;
  appSecret: string;
  brand?: string;
  timeoutMs?: number;
}

export type EnsureLarkCliBotProfileResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: 'missing_secret' | 'add_failed'; error: string };

/**
 * Idempotently ensure a lark-cli bot profile exists for VC meeting join.
 *
 * botmux stores each bot's appSecret in its own config, but nothing ever
 * registered a matching lark-cli profile — so `--as bot --profile <appId>`
 * failed with "profile not found" and the bot was stuck ringing. This bridges
 * that gap: when the profile is absent we create it non-interactively from the
 * stored secret.
 *
 * SECRET HANDLING: the secret is passed via `--app-secret-stdin` (never argv,
 * so it can't leak into `ps`/process listings) and lands only in lark-cli's own
 * encrypted credential store. This must run in the trusted daemon process, not
 * inside a sandboxed worker.
 */
export function ensureLarkCliBotProfile(
  opts: EnsureLarkCliBotProfileOptions,
  deps: LarkCliProfileDeps = defaultLarkCliProfileDeps,
): EnsureLarkCliBotProfileResult {
  const profileName = opts.profileName.trim();
  const appId = opts.appId.trim();
  if (larkCliProfileExists(profileName, { timeoutMs: opts.timeoutMs }, deps)) {
    return { ok: true, created: false };
  }
  const appSecret = opts.appSecret?.trim();
  if (!appSecret) {
    return { ok: false, reason: 'missing_secret', error: `no stored appSecret for ${appId}` };
  }
  const result = deps.addProfile({
    profileName,
    appId,
    appSecret,
    brand: opts.brand?.trim() || 'feishu',
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (result.status === 0) return { ok: true, created: true };
  // A concurrent provisioner may have created it between our list and add
  // ("already exists" → exit 2); treat a now-present profile as success.
  if (larkCliProfileExists(profileName, { timeoutMs: opts.timeoutMs }, deps)) {
    return { ok: true, created: false };
  }
  const stderr = result.stderr?.trim();
  const stdout = result.stdout?.trim();
  // Defense-in-depth: even if the existence re-check can't confirm (lark-cli
  // enumeration unavailable), an explicit "already exists" from add means the
  // profile is present — the join can proceed, so this is not a failure.
  if (/already exists/i.test(`${stderr ?? ''}${stdout ?? ''}`)) {
    return { ok: true, created: false };
  }
  return {
    ok: false,
    reason: 'add_failed',
    error: stderr || stdout || `lark-cli profile add exited ${result.status ?? 'null'}`,
  };
}

/** Check both lark-cli convenience-command format ({ok:false}) and raw API format ({code:!0}). */
export function assertLarkCliJsonOk(raw: unknown, context: string): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const obj = raw as Record<string, unknown>;
  if (obj.ok === false) {
    const message = firstErrorString(
      obj.error,
      obj.message,
      obj.msg,
      obj.error_msg,
      obj.code,
      obj.error_code,
    );
    throw new Error(`${context} failed: ${message ?? 'lark-cli returned ok=false'}`);
  }
  if (typeof obj.code === 'number' && obj.code !== 0) {
    const message = firstErrorString(obj.msg, obj.message, obj.error);
    throw new Error(`${context} failed: ${message ?? `code=${obj.code}`}`);
  }
}

function withProfile(args: string[], profile?: string): string[] {
  return profile ? [...args, '--profile', profile] : args;
}

function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

export function extractMeetingIdFromJoin(raw: unknown): string | undefined {
  return firstString(
    getPath(raw, 'meeting.id'),
    getPath(raw, 'data.meeting.id'),
    getPath(raw, 'data.id'),
    getPath(raw, 'id'),
    getPath(raw, 'meeting_id'),
  );
}

/**
 * Join a VC meeting as a bot via `lark-cli vc +meeting-join --as bot`.
 * Requires lark-cli >= 1.0.66.
 */
export function joinMeetingAsBot(opts: JoinMeetingOptions): { meetingId: string; raw: unknown } {
  const args = withProfile([
    'vc',
    '+meeting-join',
    '--as',
    'bot',
    '--meeting-number',
    opts.meetingNumber,
    ...(opts.callId ? ['--call-id', opts.callId] : []),
    ...(opts.password ? ['--password', opts.password] : []),
    '--format',
    'json',
  ], opts.profile);
  const raw = runLarkCliJson(args, { timeoutMs: opts.timeoutMs });
  assertLarkCliJsonOk(raw, 'meeting join');
  const meetingId = extractMeetingIdFromJoin(raw);
  if (!meetingId) throw new Error('meeting join succeeded but response did not contain meeting.id');
  return { meetingId, raw };
}

/**
 * Fetch VC meeting events via `lark-cli vc +meeting-events --as bot`.
 * Requires lark-cli >= 1.0.66.
 */
export function fetchMeetingEventsAsBot(opts: FetchMeetingEventsOptions): { raw: unknown; batch: NormalizedVcMeetingBatch } {
  const args = withProfile([
    'vc',
    '+meeting-events',
    '--as',
    'bot',
    '--meeting-id',
    opts.meetingId,
    '--page-size',
    String(opts.pageSize ?? 100),
    ...(opts.pageToken ? ['--page-token', opts.pageToken] : []),
    ...(opts.start ? ['--start', opts.start] : []),
    ...(opts.end ? ['--end', opts.end] : []),
    ...(opts.pageAll ?? true ? ['--page-all'] : []),
    '--format',
    'json',
  ], opts.profile);
  const raw = runLarkCliJson(args, { timeoutMs: opts.timeoutMs });
  assertLarkCliJsonOk(raw, 'meeting events fetch');
  return { raw, batch: normalizeVcMeetingEvents(raw, { meetingId: opts.meetingId, source: 'polling' }) };
}

/**
 * Send a text message to a VC meeting via `lark-cli vc +meeting-message-send --as bot`.
 * Requires lark-cli >= 1.0.66.
 */
export function sendMeetingTextMessageAsBot(opts: SendMeetingMessageOptions): { raw: unknown } {
  const args = withProfile([
    'vc',
    '+meeting-message-send',
    '--as',
    'bot',
    '--meeting-id',
    opts.meetingId,
    '--msg-type',
    'text',
    '--text',
    opts.text,
    ...(opts.uuid ? ['--uuid', opts.uuid] : []),
    '--format',
    'json',
  ], opts.profile);
  const raw = runLarkCliJson(args, { timeoutMs: opts.timeoutMs });
  assertLarkCliJsonOk(raw, 'meeting text message send');
  return { raw };
}
