import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from '../utils/file-lock.js';

export interface DeferredTopicBinding {
  sessionId: string;
  turnId: string;
  chatId: string;
  larkAppId: string;
  routingAnchor: string;
  rootMessageId: string;
  createdAt: string;
}

function bindingDir(dataDir: string): string {
  return join(dataDir, 'deferred-topics');
}

export function deferredTopicBindingPath(dataDir: string, sessionId: string): string {
  return join(bindingDir(dataDir), `${sessionId}.json`);
}

export function readDeferredTopicBinding(
  dataDir: string,
  sessionId: string,
): DeferredTopicBinding | undefined {
  const path = deferredTopicBindingPath(dataDir, sessionId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DeferredTopicBinding>;
    if (
      parsed.sessionId !== sessionId
      || typeof parsed.turnId !== 'string'
      || typeof parsed.chatId !== 'string'
      || typeof parsed.larkAppId !== 'string'
      || typeof parsed.routingAnchor !== 'string'
      || typeof parsed.rootMessageId !== 'string'
      || !parsed.rootMessageId.startsWith('om_')
      || typeof parsed.createdAt !== 'string'
    ) return undefined;
    return parsed as DeferredTopicBinding;
  } catch {
    return undefined;
  }
}

export function writeDeferredTopicBinding(
  dataDir: string,
  binding: DeferredTopicBinding,
): void {
  const path = deferredTopicBindingPath(dataDir, binding.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(binding, null, 2), 'utf8');
  renameSync(tmp, path);
}

/** Serialize the first-message claim across concurrent `botmux send`
 * processes. The callback may hold the lock across the Lark request: that is
 * intentional, because releasing it before the provider returns would allow
 * two callers to create two roots for the same deferred run. */
export function withDeferredTopicBindingLock<T>(
  dataDir: string,
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const path = deferredTopicBindingPath(dataDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  return withFileLock(path, fn, { maxWaitMs: 30_000 });
}

export function removeDeferredTopicBinding(dataDir: string, sessionId: string): void {
  const path = deferredTopicBindingPath(dataDir, sessionId);
  try { rmSync(path, { force: true }); } catch { /* best-effort lifecycle cleanup */ }
}
