/**
 * One orphan sandbox-tree sweep round, driven through the real Linux sweeps on
 * a temp dataDir shared by "several bots": the protection set must be every
 * bot's active rows (#2031), and an incomplete set must delete nothing.
 *
 * The scratch slot pass is pointed at a temp dir — the real one is host-wide.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSandboxOrphanSweep, type SandboxOrphanSweep } from '../src/core/sandbox-orphan-sweep.js';
import { sweepOrphanSandboxes } from '../src/adapters/backend/sandbox.js';
import { sweepOrphanScratchSandboxes } from '../src/adapters/backend/scratch-sandbox.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

let dataDir: string;
let slotRoot: string;
const tag = randomBytes(4).toString('hex');
const sid = (name: string) => `sweep-${tag}-${name}`;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'sbx-orphan-sweep-'));
  slotRoot = join(dataDir, 'no-slots');
  mkdirSync(slotRoot);
});
afterEach(() => { rmSandboxScratch(dataDir); });

function row(sessionId: string, status: 'active' | 'closed') {
  return { sessionId, chatId: 'oc_x', rootMessageId: `om_${sessionId}`, title: sessionId, status, createdAt: '2026-01-01T00:00:00.000Z' };
}

/** An oncall/credential-only tree (or a scratch one with `scratch`), older than the sweep grace. */
function tree(sessionId: string, opts: { scratch?: boolean } = {}): string {
  const root = join(dataDir, 'sandboxes', sessionId);
  mkdirSync(join(root, 'outbox'), { recursive: true });
  if (opts.scratch) {
    writeFileSync(join(root, 'scratch.json'), JSON.stringify({ v: 1, sid: sessionId, storage: 'disk' }));
  }
  const old = new Date(Date.now() - 120_000);
  utimesSync(root, old, old);
  return root;
}

const linuxSweeps: SandboxOrphanSweep[] = [
  sweepOrphanSandboxes,
  (dir, ids) => sweepOrphanScratchSandboxes(dir, ids, { slotRoot }),
];

describe.skipIf(process.platform !== 'linux')('runSandboxOrphanSweep', () => {
  it('keeps every bot\'s active session trees and reclaims closed or unknown ones', () => {
    seedPersistedSessionRows(dataDir, 'cli_other', {
      [sid('b-suspended')]: row(sid('b-suspended'), 'active'),
      [sid('b-closed')]: row(sid('b-closed'), 'closed'),
      [sid('b-scratch-suspended')]: row(sid('b-scratch-suspended'), 'active'),
      [sid('b-scratch-closed')]: row(sid('b-scratch-closed'), 'closed'),
    });
    const otherBotSuspended = tree(sid('b-suspended'));
    const otherBotClosed = tree(sid('b-closed'));
    const otherBotScratchSuspended = tree(sid('b-scratch-suspended'), { scratch: true });
    const otherBotScratchClosed = tree(sid('b-scratch-closed'), { scratch: true });
    const unknown = tree(sid('unknown'));
    // Ours, not yet visible on disk: only the in-memory set knows it.
    const ownUnflushed = tree(sid('own-unflushed'));
    const warn = vi.fn();

    const result = runSandboxOrphanSweep({
      dataDir,
      ownActiveSessionIds: [sid('own-unflushed')],
      label: 'test',
      warn,
      sweeps: linuxSweeps,
    });

    expect(result).toBe('swept');
    expect(existsSync(otherBotSuspended)).toBe(true);
    expect(existsSync(otherBotScratchSuspended)).toBe(true);
    expect(existsSync(ownUnflushed)).toBe(true);
    expect(existsSync(otherBotClosed)).toBe(false);
    expect(existsSync(otherBotScratchClosed)).toBe(false);
    expect(existsSync(unknown)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('deletes nothing when one bot\'s store cannot be read', () => {
    seedPersistedSessionRows(dataDir, 'cli_other', { [sid('b-closed')]: row(sid('b-closed'), 'closed') });
    mkdirSync(join(dataDir, 'session-stores', 'cli_broken'), { recursive: true });
    writeFileSync(join(dataDir, 'session-stores', 'cli_broken', 'sessions.db'), 'this is not a database');
    const closed = tree(sid('b-closed'));
    const unknown = tree(sid('unknown'));
    const spy = vi.fn();
    const warn = vi.fn();

    const result = runSandboxOrphanSweep({
      dataDir,
      ownActiveSessionIds: [],
      label: 'test',
      warn,
      sweeps: [spy, ...linuxSweeps],
    });

    expect(result).toBe('skipped');
    expect(spy).not.toHaveBeenCalled();
    expect(existsSync(closed)).toBe(true);
    expect(existsSync(unknown)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[test] skipped'));
  });

  it('a failing sweep does not stop the others in the same round', () => {
    const unknown = tree(sid('unknown'));
    const warn = vi.fn();

    const result = runSandboxOrphanSweep({
      dataDir,
      ownActiveSessionIds: [],
      label: 'test',
      warn,
      sweeps: [() => { throw new Error('boom'); }, ...linuxSweeps],
    });

    expect(result).toBe('swept');
    expect(existsSync(unknown)).toBe(false);
    expect(warn).toHaveBeenCalledWith('[test] failed: boom');
  });
});
