import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { RestartIntent } from '../services/restart-intent-store.js';
import { withFileLockSync } from '../utils/file-lock.js';

const FILE = 'restart-failure.json';

export type RestartFailureNotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface RestartFailureRecord {
  schemaVersion: 1;
  failureId: string;
  code: 'bootstrap_shutdown_protocol_required';
  at: string;
  operation: 'restart';
  detail: string;
  unsafeDaemonNames: string[];
  restartIntent?: RestartIntent;
  notification: {
    status: RestartFailureNotificationStatus;
    attempts: number;
    updatedAt: string;
    larkAppId?: string;
    ownerOpenId?: string;
    messageId?: string;
    error?: string;
  };
}

export interface RestartFailureNotifierBot {
  larkAppId: string;
  larkAppSecret: string;
  apiOnly?: boolean;
  ownerOpenId?: string;
  allowedUsers?: string[];
  brand?: 'feishu' | 'lark';
}

export interface RestartFailureNotificationTarget {
  larkAppId: string;
  ownerOpenId: string;
}

export interface RestartFailureNotificationWiring {
  dataDir: string;
  bots: RestartFailureNotifierBot[];
  unsafeDaemonNames: string[];
  detail: string;
  restartIntent?: RestartIntent | null;
  now?: number | (() => number);
  resolveOwner: (bot: RestartFailureNotifierBot) => Promise<string | undefined>;
  sendText: (target: RestartFailureNotificationTarget, text: string) => Promise<string>;
}

export function restartFailurePathIn(dir: string): string {
  return join(dir, FILE);
}

function nowMs(input: RestartFailureNotificationWiring): number {
  return typeof input.now === 'function' ? input.now() : input.now ?? Date.now();
}

function writeRestartFailureUnlocked(dir: string, record: RestartFailureRecord): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = restartFailurePathIn(dir);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
  renameSync(tmp, path);
}

export function writeRestartFailureTo(dir: string, record: RestartFailureRecord): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  withFileLockSync(restartFailurePathIn(dir), () => writeRestartFailureUnlocked(dir, record));
}

export function readRestartFailureFrom(dir: string): RestartFailureRecord | null {
  try {
    const value = JSON.parse(readFileSync(restartFailurePathIn(dir), 'utf8')) as RestartFailureRecord;
    if (value?.schemaVersion !== 1
      || value.code !== 'bootstrap_shutdown_protocol_required'
      || typeof value.failureId !== 'string'
      || typeof value.at !== 'string'
      || !value.notification
      || typeof value.notification.status !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

function updateRestartFailureTo(
  dir: string,
  failureId: string,
  update: (record: RestartFailureRecord) => RestartFailureRecord,
): RestartFailureRecord | null {
  if (!existsSync(dir)) return null;
  return withFileLockSync(restartFailurePathIn(dir), () => {
    const current = readRestartFailureFrom(dir);
    if (!current || current.failureId !== failureId) return null;
    const next = update(current);
    writeRestartFailureUnlocked(dir, next);
    return next;
  });
}

export function buildRestartBootstrapRequiredText(
  record: RestartFailureRecord,
  dataDir: string,
): string {
  const daemonLine = record.unsafeDaemonNames.length > 0
    ? `\n受影响 daemon：${record.unsafeDaemonNames.join('、')}`
    : '';
  const versionLine = record.restartIntent?.oldVersion && record.restartIntent?.newVersion
    ? `\n版本：v${record.restartIntent.oldVersion.replace(/^v/, '')} → v${record.restartIntent.newVersion.replace(/^v/, '')}`
    : '';
  return 'Botmux 新版本已安装，但自动重启被安全检查阻止：当前运行的 daemon 仍使用旧的关停协议。'
    + versionLine
    + daemonLine
    + '\n请先确认所有 Session / Riff 工作均已空闲，再在机器终端执行：'
    + '\nbotmux restart --bootstrap-shutdown-protocol --yes'
    // Report the ACTUAL failure-record location: dataDir may be redirected by
    // SESSION_DATA_DIR or the `.data-dir` breadcrumb, and a literal `~` does not
    // expand in Feishu text. See PR #843 R2 review.
    + `\n失败记录：${restartFailurePathIn(dataDir)}`;
}

/**
 * Persist the first-upgrade failure before attempting any external delivery.
 * The selected owner is resolved independently inside each configured app;
 * an app-scoped open_id is never copied from one bot to another.
 */
export async function recordAndNotifyRestartBootstrapFailure(
  input: RestartFailureNotificationWiring,
): Promise<RestartFailureRecord> {
  const atMs = nowMs(input);
  const at = new Date(atMs).toISOString();
  const record: RestartFailureRecord = {
    schemaVersion: 1,
    failureId: randomBytes(16).toString('hex'),
    code: 'bootstrap_shutdown_protocol_required',
    at,
    operation: 'restart',
    detail: input.detail,
    unsafeDaemonNames: [...new Set(input.unsafeDaemonNames)].sort(),
    ...(input.restartIntent ? { restartIntent: input.restartIntent } : {}),
    notification: { status: 'pending', attempts: 0, updatedAt: at },
  };
  writeRestartFailureTo(input.dataDir, record);

  let target: RestartFailureNotificationTarget | undefined;
  let resolutionError: string | undefined;
  for (const bot of input.bots) {
    if (bot.apiOnly === true || !bot.larkAppId || !bot.larkAppSecret) continue;
    try {
      const ownerOpenId = await input.resolveOwner(bot);
      if (ownerOpenId?.startsWith('ou_')) {
        target = { larkAppId: bot.larkAppId, ownerOpenId };
        break;
      }
    } catch (error) {
      resolutionError = error instanceof Error ? error.message : String(error);
    }
  }

  const pending = updateRestartFailureTo(input.dataDir, record.failureId, current => ({
    ...current,
    notification: {
      status: target ? 'pending' : 'skipped',
      attempts: target ? 1 : 0,
      updatedAt: new Date(nowMs(input)).toISOString(),
      ...(target ? { larkAppId: target.larkAppId, ownerOpenId: target.ownerOpenId } : {}),
      ...(!target ? { error: resolutionError ?? 'no transport-enabled bot with a resolvable owner' } : {}),
    },
  })) ?? record;
  if (!target) return pending;

  try {
    const messageId = await input.sendText(
      target,
      buildRestartBootstrapRequiredText(pending, input.dataDir),
    );
    return updateRestartFailureTo(input.dataDir, record.failureId, current => ({
      ...current,
      notification: {
        ...current.notification,
        status: 'sent',
        updatedAt: new Date(nowMs(input)).toISOString(),
        ...(messageId ? { messageId } : {}),
      },
    })) ?? pending;
  } catch (error) {
    return updateRestartFailureTo(input.dataDir, record.failureId, current => ({
      ...current,
      notification: {
        ...current.notification,
        status: 'failed',
        updatedAt: new Date(nowMs(input)).toISOString(),
        error: error instanceof Error ? error.message : String(error),
      },
    })) ?? pending;
  }
}
