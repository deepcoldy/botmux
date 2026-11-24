import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { doubaoExportAnswer, doubaoExportFrontier } from './doubao-transcript.js';
import type { CodexPendingTurn } from './codex-bridge-queue.js';

// A terminal-less log cannot disambiguate a late final from the next turn's
// final. Once export owns a native log, keep it as its only terminal source,
// including after reattach. This is NOT a delivered marker: publication still
// uses the existing queue, output journal and daemon delivery deduper.
function modePath(dataDir: string, path: string): string {
  return join(dataDir, 'doubao-export', createHash('sha256').update(path).digest('hex'));
}

export function doubaoExportOwnsTerminals(dataDir: string, path: string): boolean {
  return existsSync(modePath(dataDir, path));
}

export function commitDoubaoExportMode(dataDir: string, path: string): void {
  const marker = modePath(dataDir, path);
  mkdirSync(join(dataDir, 'doubao-export'), { recursive: true });
  atomicWriteFileSync(marker, 'export-only\n', { mode: 0o600, durable: true, followTargetSymlink: false });
}

export function exportDoubaoSession(bin: string, sessionId: string, options: {
  cwd?: string; env?: NodeJS.ProcessEnv;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['--export', sessionId], { ...options, timeout: 8_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(new Error('doubao_export_unavailable')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('doubao_export_invalid')); }
    });
  });
}

export interface DoubaoRecoveryView {
  path: string;
  sessionId: string;
  generation: string;
  idle: boolean;
  turns: readonly CodexPendingTurn[];
}

/** Single-flight export, bounded by observed native idle, not the submit time.
 * Re-read all authority after IO; stopping, new input or a rewritten log must
 * never let an old callback publish into the new execution. */
export class DoubaoExportRecovery {
  private flight = false;
  private waits = new Map<CodexPendingTurn, { generation: string; since: number; retryAt: number }>();

  constructor(private readonly hooks: {
    view: () => DoubaoRecoveryView | undefined;
    readExport: (sessionId: string) => Promise<unknown>;
    commitMode: (path: string) => void;
    settle: (turn: CodexPendingTurn, answer: string | undefined) => void;
    now?: () => number;
    graceMs?: number;
    deadlineMs?: number;
  }) { }

  async tick(): Promise<void> {
    const now = this.hooks.now?.() ?? Date.now();
    let view: DoubaoRecoveryView | undefined;
    try { view = this.hooks.view(); } catch { view = undefined; }
    const pending = view?.turns.filter(turn => turn.started && turn.finalText === undefined && !turn.isLocal) ?? [];
    for (const turn of this.waits.keys()) {
      if (!view?.idle || !pending.includes(turn) || this.waits.get(turn)!.generation !== view.generation) this.waits.delete(turn);
    }
    if (!view?.idle) return;
    for (const turn of pending) {
      const wait = this.waits.get(turn) ?? { generation: view.generation, since: now, retryAt: now };
      this.waits.set(turn, wait);
      if (now - wait.since >= (this.hooks.deadlineMs ?? 60_000)) {
        try {
          this.hooks.commitMode(view.path);
          this.hooks.settle(turn, undefined);
          this.waits.delete(turn);
        } catch { /* A failed durable barrier/publication is retried, never acknowledged. */ }
        continue;
      }
      if (this.flight || now < wait.retryAt || now - wait.since < (this.hooks.graceMs ?? 5_000)) continue;
      const frontier = doubaoExportFrontier(view.path, turn);
      if (!frontier || frontier.sessionId !== view.sessionId) continue;
      this.flight = true;
      wait.retryAt = now + 5_000;
      try {
        const exported = await this.hooks.readExport(view.sessionId);
        const current = this.hooks.view();
        if (!current?.idle || current.path !== view.path || current.sessionId !== view.sessionId
          || current.generation !== view.generation || !current.turns.includes(turn) || turn.finalText !== undefined) continue;
        const rechecked = doubaoExportFrontier(current.path, turn);
        if (!rechecked || rechecked.assignmentHash !== frontier.assignmentHash || rechecked.index !== frontier.index) continue;
        const answer = doubaoExportAnswer(frontier, exported);
        if (answer === undefined) continue;
        this.hooks.commitMode(view.path);
        this.hooks.settle(turn, answer);
        this.waits.delete(turn);
      } catch { /* Export errors contain no provider payloads; bounded notice owns failure. */ }
      finally { this.flight = false; }
    }
  }
}
