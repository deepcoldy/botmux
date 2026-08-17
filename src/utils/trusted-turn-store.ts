import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from './atomic-write.js';
import type { TrustedCaller } from '../types.js';

export interface TrustedTurnRecord {
  sessionId: string;
  turnId?: string;
  trustedCaller: TrustedCaller;
  updatedAtMs: number;
  expiresAtMs: number;
}

export interface TrustedTurnFileResolution {
  filePath?: string;
  source: 'explicit_env' | 'session_data_dir' | 'data_dir_fallback' | 'unresolved';
}

export interface TrustedTurnInspection {
  filePath?: string;
  source: TrustedTurnFileResolution['source'];
  exists: boolean;
  valid: boolean;
  reason?: 'missing_session_id' | 'file_missing' | 'invalid_json' | 'session_mismatch' | 'expired' | 'missing_union_id';
  expectedSessionId?: string;
  sessionId?: string;
  turnId?: string;
  updatedAtMs?: number;
  expiresAtMs?: number;
  hasOpenId: boolean;
  hasUnionId: boolean;
  hasLarkAppId: boolean;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function trustedTurnFilePath(dataDir: string, sessionId: string): string {
  return join(dataDir, 'trusted-turns', `${sessionId}.json`);
}

export function resolveBotmuxDataDirForTrustedTurn(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SESSION_DATA_DIR) return env.SESSION_DATA_DIR;

  const configDir = join(homedir(), '.botmux');
  const fallbackDataDir = join(configDir, 'data');
  const breadcrumb = join(configDir, '.data-dir');
  try {
    const dataDir = readFileSync(breadcrumb, 'utf8').trim();
    if (dataDir && existsSync(dataDir)) {
      if (existsSync(join(dataDir, 'sessions.json'))) return dataDir;
      try {
        if (readdirSync(dataDir).some(file => file.startsWith('sessions-') && file.endsWith('.json'))) {
          return dataDir;
        }
      } catch {
        // Fall through to the default BotMux data dir.
      }
    }
  } catch {
    // Missing breadcrumb is normal for default installs.
  }
  return fallbackDataDir;
}

export function trustedTurnFilePathFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return trustedTurnFilePathResolutionFromEnv(env).filePath;
}

export function trustedTurnFilePathResolutionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TrustedTurnFileResolution {
  if (env.BOTMUX_TRUSTED_TURN_FILE) {
    return { filePath: env.BOTMUX_TRUSTED_TURN_FILE, source: 'explicit_env' };
  }
  if (!env.BOTMUX_SESSION_ID) return { source: 'unresolved' };
  const source = env.SESSION_DATA_DIR ? 'session_data_dir' : 'data_dir_fallback';
  return {
    filePath: trustedTurnFilePath(resolveBotmuxDataDirForTrustedTurn(env), env.BOTMUX_SESSION_ID),
    source,
  };
}

export function writeTrustedTurnFile(
  filePath: string,
  record: Omit<TrustedTurnRecord, 'updatedAtMs' | 'expiresAtMs'>,
  nowMs = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  atomicWriteFileSync(
    filePath,
    JSON.stringify({ ...record, updatedAtMs: nowMs, expiresAtMs: nowMs + ttlMs }),
    { mode: 0o600 },
  );
}

export function clearTrustedTurnFile(filePath?: string): void {
  if (!filePath) return;
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Best effort. A missing/expired file still fail-closes in the MCP proxy.
  }
}

function readRecord(filePath: string): TrustedTurnRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as TrustedTurnRecord;
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return undefined;
    if (!parsed.trustedCaller || typeof parsed.trustedCaller !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function readRecordForInspection(
  filePath: string,
): { ok: true; record: TrustedTurnRecord } | { ok: false; reason: 'file_missing' | 'invalid_json' } {
  if (!existsSync(filePath)) return { ok: false, reason: 'file_missing' };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as TrustedTurnRecord;
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'invalid_json' };
    if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return { ok: false, reason: 'invalid_json' };
    if (!parsed.trustedCaller || typeof parsed.trustedCaller !== 'object') return { ok: false, reason: 'invalid_json' };
    return { ok: true, record: parsed };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}

export function readTrustedTurnFile(
  filePath: string,
  expectedSessionId?: string,
  nowMs = Date.now(),
): TrustedCaller | undefined {
  const record = readRecord(filePath);
  if (!record) return undefined;
  if (expectedSessionId && record.sessionId !== expectedSessionId) return undefined;
  if (typeof record.expiresAtMs !== 'number' || record.expiresAtMs < nowMs) return undefined;
  if (!record.trustedCaller.requestUserUnionId) return undefined;
  return record.trustedCaller;
}

export function inspectTrustedTurnFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): TrustedTurnInspection {
  const resolution = trustedTurnFilePathResolutionFromEnv(env);
  const expectedSessionId = env.BOTMUX_SESSION_ID;
  const base = {
    filePath: resolution.filePath,
    source: resolution.source,
    exists: false,
    valid: false,
    expectedSessionId,
    hasOpenId: false,
    hasUnionId: false,
    hasLarkAppId: false,
  };
  if (!resolution.filePath) {
    return { ...base, reason: 'missing_session_id' };
  }

  const parsed = readRecordForInspection(resolution.filePath);
  if (!parsed.ok) {
    return { ...base, reason: parsed.reason };
  }

  const { record } = parsed;
  const inspected = {
    ...base,
    exists: true,
    sessionId: record.sessionId,
    turnId: record.turnId,
    updatedAtMs: record.updatedAtMs,
    expiresAtMs: record.expiresAtMs,
    hasOpenId: !!record.trustedCaller.requestUserOpenId,
    hasUnionId: !!record.trustedCaller.requestUserUnionId,
    hasLarkAppId: !!record.trustedCaller.requestLarkAppId,
  };
  if (expectedSessionId && record.sessionId !== expectedSessionId) {
    return { ...inspected, reason: 'session_mismatch' };
  }
  if (typeof record.expiresAtMs !== 'number' || record.expiresAtMs < nowMs) {
    return { ...inspected, reason: 'expired' };
  }
  if (!record.trustedCaller.requestUserUnionId) {
    return { ...inspected, reason: 'missing_union_id' };
  }
  return { ...inspected, valid: true };
}
