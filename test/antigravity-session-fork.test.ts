import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntigravitySessionLog, forkAntigravitySession } from '../src/services/antigravity-session-fork.js';

const parent = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const child = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const sibling = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const streaming = (id: string) => `I1103 12:00:00.000001 100 conversation_manager.go:1093] Streaming conversation ${id}\n`;
const forked = (from: string, to: string) => `I1103 12:00:01.000001 101 server.go:2632] Forked conversation ${from} -> ${to}\n`;
let root: string;
let log: AntigravitySessionLog;
let clock = 0;

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  root = mkdtempSync(join(tmpdir(), 'agy-native-fork-'));
  log = new AntigravitySessionLog('botmux-child', root);
  writeFileSync(log.path, streaming(parent));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function start(overrides: Partial<Parameters<typeof forkAntigravitySession>[0]> = {}) {
  const sendCommand = vi.fn(async () => {});
  return { sendCommand, result: forkAntigravitySession({
    sourceId: parent, log, sendCommand, isCurrent: () => true, isReady: () => true,
    timeoutMs: 1_000, now: () => clock, ...overrides,
  }) };
}

async function advance(ms: number) {
  // Bun's Vitest shim advances timers synchronously. Let an awaited native
  // command finish scheduling its poll before moving either runtime's clock.
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    await Promise.resolve();
    await Promise.resolve();
    const step = Math.min(100, ms - elapsed);
    clock += step;
    await vi.advanceTimersByTimeAsync(step);
  }
}

describe('native Antigravity fork confirmation', () => {
  it('waits for both the exact source→child receipt and the active child stream', async () => {
    const op = start();
    expect(op.sendCommand).toHaveBeenCalledTimes(1);
    appendFileSync(log.path, forked(parent, child));
    let completed = false;
    void op.result.then(() => { completed = true; });
    await advance(200);
    expect(completed).toBe(false);
    appendFileSync(log.path, streaming(child));
    await advance(200);
    await expect(op.result).resolves.toBe(child);
    expect(op.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('recovers a warm pane after native fork completed but its id was not persisted', async () => {
    appendFileSync(log.path, forked(parent, child) + streaming(child));
    const op = start();
    await expect(op.result).resolves.toBe(child);
    expect(op.sendCommand).not.toHaveBeenCalled();
  });

  it('a cold resume of the parent supersedes the old fork receipt', async () => {
    appendFileSync(log.path, forked(parent, child) + streaming(child) + streaming(parent));
    const op = start();
    expect(op.sendCommand).toHaveBeenCalledTimes(1);
    appendFileSync(log.path, forked(parent, sibling) + streaming(sibling));
    await advance(100);
    await expect(op.result).resolves.toBe(sibling);
  });

  it.each([
    [forked(sibling, child) + streaming(child), 'a sibling fork'],
    [streaming(child), 'an unrelated conversation switch'],
    [forked(parent, parent) + streaming(parent), 'the unchanged parent'],
  ])('does not accept %s (%s) as an independent child', async (records) => {
    const op = start();
    const rejected = op.result.catch(error => error as Error);
    appendFileSync(log.path, records);
    await advance(1_100);
    expect((await rejected as Error).message).toContain('did not confirm an independent fork');
  });

  it('never types a fork into a draft, dialog or running turn', async () => {
    const op = start({ isReady: () => false });
    const rejected = op.result.catch(error => error as Error);
    await advance(1_100);
    expect((await rejected as Error).message).toContain('did not confirm');
    expect(op.sendCommand).not.toHaveBeenCalled();
  });

  it('stops after a generation is replaced, including while sending the command', async () => {
    let current = true;
    const op = start({ isCurrent: () => current, sendCommand: async () => { current = false; } });
    const rejected = op.result.catch(error => error as Error);
    appendFileSync(log.path, forked(parent, child) + streaming(child));
    await advance(200);
    expect((await rejected as Error).message).toContain('generation was replaced');
  });

  it('does not retry an ambiguous/failed command write', async () => {
    const sendCommand = vi.fn(async () => { throw new Error('unconfirmed Enter'); });
    const op = start({ sendCommand });
    await expect(op.result).rejects.toThrow('unconfirmed Enter');
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });
});

describe('process-scoped native session log', () => {
  it('waits for complete log records and retains state across unrelated output', () => {
    expect(log.read().currentId).toBe(parent);
    const receipt = forked(parent, child) + streaming(child);
    appendFileSync(log.path, receipt.slice(0, -3));
    expect(log.read().currentId).toBe(parent);
    appendFileSync(log.path, receipt.slice(-3));
    expect(log.read()).toEqual({ currentId: child, fork: { parentId: parent, childId: child } });
    appendFileSync(log.path, 'ordinary debug output\n');
    expect(log.read().currentId).toBe(child);
  });

  it('drops stale fork receipts when the log file is replaced', () => {
    appendFileSync(log.path, forked(parent, child) + streaming(child));
    expect(log.read().currentId).toBe(child);
    writeFileSync(log.path + '.new', streaming(parent));
    renameSync(log.path + '.new', log.path);
    expect(log.read()).toEqual({ currentId: parent });
  });
});
