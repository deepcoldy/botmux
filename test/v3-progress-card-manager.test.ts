import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  V3_PROGRESS_SIDECAR,
  V3ProgressCardManager,
  freezeV3ProgressCard,
  type V3ProgressCardTransport,
} from '../src/im/lark/v3-progress-card-manager.js';
import { appendEvent } from '../src/workflows/v3/journal.js';
import { artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce } from '../src/workflows/v3/run-envelope.js';
import { withFileLock } from '../src/utils/file-lock.js';

let root: string;
let baseDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'v3-progress-manager-'));
  baseDir = join(root, 'runs');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function seedRun(runId: string, rootMessageId: string | null = 'om_root') {
  const runDir = join(baseDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, 'dag.json'), {
    runId,
    nodes: [{ id: 'work', type: 'goal', goal: 'work', depends: [], inputs: [] }],
  });
  writeJson(join(runDir, 'spec.json'), {
    schemaVersion: 1,
    runId,
    title: 'Progress test',
    requirement: 'work',
    nodes: [{
      sketchId: 'work', goal: 'work', input_needs: [], expected_outputs: ['out'],
      acceptance: 'done', risk_gate: false, unknowns: [],
    }],
  });
  writeJson(join(runDir, 'bots.snapshot.json'), {
    '': { larkAppId: 'cli_test', cliId: 'claude-code', workingDir: '/work' },
  });
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId,
    createdAt: '2026-07-11T00:00:00.000Z',
    authorizedAt: '2026-07-11T00:00:01.000Z',
    chatBinding: {
      larkAppId: 'cli_test', chatId: 'oc_chat', ownerOpenId: 'ou_owner',
      ...(rootMessageId ? { rootMessageId } : {}),
    },
    artifacts: {
      dag: artifactRef(runDir, 'dag.json'),
      spec: artifactRef(runDir, 'spec.json'),
      botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
    },
  }));
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId });
  return runDir;
}

function transport(overrides: Partial<V3ProgressCardTransport> = {}): V3ProgressCardTransport {
  return {
    reply: vi.fn(async () => 'om_progress'),
    send: vi.fn(async () => 'om_progress'),
    patch: vi.fn(async () => {}),
    ...overrides,
  };
}

function manager(tx: V3ProgressCardTransport, now = new Date('2026-07-11T00:05:00.000Z')) {
  return new V3ProgressCardManager({
    baseDir,
    transport: tx,
    now: () => now,
    buildCard: (view) => JSON.stringify({ status: view.status, updatedAt: view.updatedAt }),
  });
}

describe('V3ProgressCardManager', () => {
  it('persists a 0600 pending intent before one reply and PATCHes only visual changes', async () => {
    const runDir = seedRun('progress-001');
    const sidecarPath = join(runDir, V3_PROGRESS_SIDECAR);
    let uuidSeen = '';
    const reply = vi.fn(async (_app: string, _root: string, _card: string, uuid: string) => {
      const pending = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
      expect(pending.delivery).toBe('pending');
      expect(pending.messageId).toBeUndefined();
      expect(statSync(sidecarPath).mode & 0o777).toBe(0o600);
      uuidSeen = uuid;
      return 'om_progress';
    });
    const tx = transport({ reply });
    const cards = manager(tx);

    await Promise.all([
      cards.refresh('progress-001', { allowCreate: true }),
      cards.refresh('progress-001', { allowCreate: true }),
    ]);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(uuidSeen).toMatch(/^[0-9a-f]{40}$/);
    expect(uuidSeen.length).toBeLessThanOrEqual(50);
    expect(tx.patch).not.toHaveBeenCalled();

    await cards.refresh('progress-001', { allowCreate: true });
    expect(tx.patch).not.toHaveBeenCalled();
    appendEvent(join(runDir, 'journal.ndjson'), {
      type: 'nodeDispatched', nodeId: 'work', attemptId: 'work/attempts/001',
    });
    await cards.refresh('progress-001', { allowCreate: true });
    expect(tx.patch).toHaveBeenCalledTimes(1);
  });

  it('re-reads journal inside the cross-process lock so an old snapshot cannot overwrite terminal', async () => {
    const runDir = seedRun('progress-lock-freshness');
    const sidecarPath = join(runDir, V3_PROGRESS_SIDECAR);
    let delivered = '';
    const tx = transport({
      reply: vi.fn(async (_app, _root, card) => {
        delivered = card;
        return 'om_progress';
      }),
    });
    const cards = manager(tx);
    let refresh!: Promise<boolean>;
    await withFileLock(sidecarPath, async () => {
      refresh = cards.refresh('progress-lock-freshness', { allowCreate: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      appendEvent(join(runDir, 'journal.ndjson'), { type: 'runSucceeded' });
    });
    expect(await refresh).toBe(true);
    expect(JSON.parse(delivered).status).toBe('succeeded');
  });

  it('uses chat send without a root message and never calls reply', async () => {
    seedRun('progress-chat', null);
    const tx = transport();
    await manager(tx).refresh('progress-chat', { allowCreate: true });
    expect(tx.send).toHaveBeenCalledWith('cli_test', 'oc_chat', expect.any(String), expect.any(String));
    expect(tx.reply).not.toHaveBeenCalled();
  });

  it('retries a crashed pending send with the same UUID', async () => {
    seedRun('progress-retry');
    const uuids: string[] = [];
    const reply = vi.fn(async (_app: string, _root: string, _card: string, uuid: string) => {
      uuids.push(uuid);
      if (uuids.length === 1) throw new Error('network down after intent');
      return 'om_progress';
    });
    const errors = vi.fn();
    const cards = new V3ProgressCardManager({
      baseDir,
      transport: transport({ reply }),
      now: () => new Date('2026-07-11T00:05:00.000Z'),
      buildCard: (view) => JSON.stringify({ status: view.status }),
      onError: errors,
    });
    expect(await cards.refresh('progress-retry', { allowCreate: true })).toBe(false);
    expect(await cards.refresh('progress-retry', { allowCreate: true })).toBe(true);
    expect(uuids).toHaveLength(2);
    expect(uuids[1]).toBe(uuids[0]);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('coalesces unlimited polling ticks behind a hung transport into one dirty rerun', async () => {
    const runDir = seedRun('progress-coalesce');
    let release!: (messageId: string) => void;
    const blockedSend = new Promise<string>((resolve) => { release = resolve; });
    const reply = vi.fn(async () => blockedSend);
    const tx = transport({ reply });
    const cards = manager(tx);

    const first = cards.refresh('progress-coalesce', { allowCreate: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const queued = Array.from({ length: 100 }, () =>
      cards.refresh('progress-coalesce', { allowCreate: true }));
    appendEvent(join(runDir, 'journal.ndjson'), {
      type: 'nodeDispatched', nodeId: 'work', attemptId: 'work/attempts/001',
    });
    const final = cards.finalize('progress-coalesce');
    expect(reply).toHaveBeenCalledTimes(1);
    expect(queued.every((promise) => promise === first)).toBe(true);
    expect(final).toBe(first);

    release('om_progress');
    await expect(first).resolves.toBe(true);
    expect(tx.patch).toHaveBeenCalledTimes(1);
  });

  it('marks a withdrawn card and does not recreate it', async () => {
    const runDir = seedRun('progress-withdrawn');
    const withdrawn = Object.assign(new Error('gone'), { name: 'MessageWithdrawnError' });
    const reply = vi.fn(async () => { throw withdrawn; });
    const tx = transport({ reply });
    const cards = manager(tx);
    expect(await cards.refresh('progress-withdrawn', { allowCreate: true })).toBe(false);
    expect(JSON.parse(readFileSync(join(runDir, V3_PROGRESS_SIDECAR), 'utf-8')).delivery).toBe('withdrawn');
    expect(await cards.refresh('progress-withdrawn', { allowCreate: true })).toBe(false);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('records freeze_pending when a visible callback wins the send→messageId crash window', async () => {
    const runDir = seedRun('progress-freeze-pending');
    const reply = vi.fn(async () => { throw new Error('message landed but receipt write was lost'); });
    const tx = transport({ reply });
    const cards = manager(tx);
    expect(await cards.refresh('progress-freeze-pending', { allowCreate: true })).toBe(false);
    expect(JSON.parse(readFileSync(join(runDir, V3_PROGRESS_SIDECAR), 'utf-8')).delivery).toBe('pending');
    await freezeV3ProgressCard(runDir);
    expect(JSON.parse(readFileSync(join(runDir, V3_PROGRESS_SIDECAR), 'utf-8')).delivery).toBe('freeze_pending');
    expect(await cards.refresh('progress-freeze-pending', { allowCreate: true })).toBe(true);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('freezes an in-place terminal action so later refresh/cold attach cannot overwrite it', async () => {
    const runDir = seedRun('progress-frozen');
    const tx = transport();
    const cards = manager(tx);
    await cards.refresh('progress-frozen', { allowCreate: true });
    await freezeV3ProgressCard(runDir);
    appendEvent(join(runDir, 'journal.ndjson'), {
      type: 'nodeDispatched', nodeId: 'work', attemptId: 'work/attempts/001',
    });
    expect(await cards.refresh('progress-frozen', { allowCreate: true })).toBe(true);
    expect(tx.patch).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(runDir, V3_PROGRESS_SIDECAR), 'utf-8')).delivery).toBe('frozen');
  });

  it('fails closed on a corrupt/tampered sidecar without sending another card', async () => {
    const runDir = seedRun('progress-corrupt');
    const path = join(runDir, V3_PROGRESS_SIDECAR);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, runId: '../other' }));
    chmodSync(path, 0o600);
    const onError = vi.fn();
    const tx = transport();
    const cards = new V3ProgressCardManager({
      baseDir,
      transport: tx,
      buildCard: (view) => JSON.stringify(view.status),
      onError,
    });
    expect(await cards.refresh('progress-corrupt', { allowCreate: true })).toBe(false);
    expect(tx.reply).not.toHaveBeenCalled();
    expect(tx.send).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('rejects a symlink sidecar instead of following it outside the run directory', async () => {
    const runDir = seedRun('progress-symlink');
    const outside = join(root, 'outside.json');
    writeFileSync(outside, '{}');
    symlinkSync(outside, join(runDir, V3_PROGRESS_SIDECAR));
    const tx = transport();
    const onError = vi.fn();
    const cards = new V3ProgressCardManager({
      baseDir,
      transport: tx,
      buildCard: (view) => JSON.stringify(view.status),
      onError,
    });
    expect(await cards.refresh('progress-symlink', { allowCreate: true })).toBe(false);
    expect(tx.reply).not.toHaveBeenCalled();
    expect(readFileSync(outside, 'utf-8')).toBe('{}');
    expect(onError).toHaveBeenCalledWith('progress-symlink', expect.objectContaining({
      message: expect.stringContaining('regular file'),
    }));
  });

  it('rename-replaces a symlink raced in after read instead of overwriting its target', async () => {
    const runDir = seedRun('progress-symlink-race');
    const path = join(runDir, V3_PROGRESS_SIDECAR);
    const outside = join(root, 'outside-race.json');
    writeFileSync(outside, 'DO_NOT_TOUCH');
    const tx = transport();
    const cards = new V3ProgressCardManager({
      baseDir,
      transport: tx,
      buildCard: (view) => {
        if (!lstatMaybe(path)) symlinkSync(outside, path);
        return JSON.stringify({ status: view.status });
      },
    });
    expect(await cards.refresh('progress-symlink-race', { allowCreate: true })).toBe(true);
    expect(readFileSync(outside, 'utf-8')).toBe('DO_NOT_TOUCH');
    expect(lstatSync(path).isFile()).toBe(true);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
  });

  it('cold attach patches terminal runs only when a sidecar already exists', async () => {
    const historical = seedRun('progress-old-terminal');
    appendEvent(join(historical, 'journal.ndjson'), { type: 'runSucceeded' });
    const live = seedRun('progress-live-terminal');
    const tx = transport();
    const cards = manager(tx);
    await cards.refresh('progress-live-terminal', { allowCreate: true });
    appendEvent(join(live, 'journal.ndjson'), { type: 'runSucceeded' });
    await cards.coldAttach('cli_test');
    expect(tx.reply).toHaveBeenCalledTimes(1);
    expect(tx.patch).toHaveBeenCalledTimes(1);
    expect(statSync(join(historical, 'run.json')).isFile()).toBe(true);
    expect(() => statSync(join(historical, V3_PROGRESS_SIDECAR))).toThrow();
    cards.close();
  });

  it('cold attach refreshes phantom-running history once without leaking a poll observer', async () => {
    const runDir = seedRun('progress-phantom');
    const tx = transport();
    const cards = new V3ProgressCardManager({
      baseDir,
      transport: tx,
      pollIntervalMs: 5,
      buildCard: (view) => JSON.stringify({ status: view.status, updatedAt: view.updatedAt }),
    });
    await cards.coldAttach('cli_test');
    expect(tx.reply).toHaveBeenCalledTimes(1);
    appendEvent(join(runDir, 'journal.ndjson'), {
      type: 'nodeDispatched', nodeId: 'work', attemptId: 'work/attempts/001',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(tx.patch).not.toHaveBeenCalled();
    cards.close();
  });
});

function lstatMaybe(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}
