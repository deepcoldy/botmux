import { join } from 'node:path';

export function codexNotifierRoot(dataDir: string): string {
  return join(dataDir, 'codex-notifier');
}

export function codexNotifierOutboxDir(dataDir: string): string {
  return join(codexNotifierRoot(dataDir), 'outbox');
}

export function codexNotifierDeadLetterDir(dataDir: string): string {
  return join(codexNotifierRoot(dataDir), 'dead-letter');
}

export function codexNotifierConfirmedTurnsDir(dataDir: string): string {
  return join(codexNotifierRoot(dataDir), 'confirmed-turns');
}

export function codexNotifierWorkerStatePath(dataDir: string): string {
  return join(codexNotifierRoot(dataDir), 'worker-state.json');
}

export function codexNotifierWorkerLockPath(dataDir: string): string {
  return join(codexNotifierRoot(dataDir), 'worker.lock');
}
