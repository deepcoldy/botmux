import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionRuntimeSweeper } from '../src/core/session-runtime-sweep.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-runtime-sweep-'));
  roots.push(dir);
  return dir;
}

const row = (sessionId: string, status: 'active' | 'closed') => ({
  sessionId, chatId: 'oc_x', rootMessageId: `om_${sessionId}`, title: sessionId, status,
  createdAt: '2026-10-01T00:00:00.000Z',
});

// The sweeps themselves are stubbed: they default to the real ~/.cache and
// tmpdir() roots, which a test must never touch.
function harness(data: string, own: string[] = []) {
  const sweepScratch = vi.fn(async () => [] as string[]);
  const sweepGateway = vi.fn(async () => [] as string[]);
  const log = { info: vi.fn(), warn: vi.fn() };
  const sweep = createSessionRuntimeSweeper({
    dataDir: data,
    ownActiveSessionIds: () => own,
    liveReferences: async () => new Set(),
    sweepScratch,
    sweepGateway,
    log,
  });
  return { sweep, sweepScratch, sweepGateway, log };
}

describe('session runtime sweep (#1748)', () => {
  it('protects every bot’s active sessions plus this daemon’s unflushed ones', async () => {
    const data = dataDir();
    seedPersistedSessionRows(data, 'appA', { a1: row('a1', 'active'), a2: row('a2', 'closed') });
    seedPersistedSessionRows(data, 'appB', { b1: row('b1', 'active'), b2: row('b2', 'closed') });
    const { sweep, sweepScratch, sweepGateway } = harness(data, ['mine-unflushed']);

    await sweep();

    const expected = ['a1', 'b1', 'mine-unflushed'];
    expect([...(sweepScratch.mock.calls[0]?.[1] as Set<string>)].sort()).toEqual(expected);
    expect([...(sweepGateway.mock.calls[0]?.[1] as Set<string>)].sort()).toEqual(expected);
    expect(sweepScratch.mock.calls[0]?.[0]).toBe(data);
  });

  it('skips the whole round when one bot’s store cannot be read', async () => {
    const data = dataDir();
    seedPersistedSessionRows(data, 'appB', { b1: row('b1', 'active') });
    mkdirSync(join(data, 'session-stores', 'appA'), { recursive: true });
    writeFileSync(join(data, 'session-stores', 'appA', 'sessions.db'), 'this is not a database');
    const { sweep, sweepScratch, sweepGateway, log } = harness(data);

    await sweep();

    expect(sweepScratch).not.toHaveBeenCalled();
    expect(sweepGateway).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('never overlaps a round still in flight', async () => {
    const data = dataDir();
    const { sweep, sweepScratch } = harness(data);
    let release!: () => void;
    sweepScratch.mockImplementationOnce(() => new Promise<string[]>(resolve => { release = () => resolve([]); }));

    const first = sweep();
    await vi.waitFor(() => expect(sweepScratch).toHaveBeenCalledTimes(1));
    await sweep();
    expect(sweepScratch).toHaveBeenCalledTimes(1);
    release();
    await first;
    await sweep();
    expect(sweepScratch).toHaveBeenCalledTimes(2);
  });
});
