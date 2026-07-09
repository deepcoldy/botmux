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

export function runLarkCliJson(args: string[]): unknown {
  const result = spawnSync('lark-cli', args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
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
  const raw = runLarkCliJson(args);
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
  const raw = runLarkCliJson(args);
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
  const raw = runLarkCliJson(args);
  assertLarkCliJsonOk(raw, 'meeting text message send');
  return { raw };
}
