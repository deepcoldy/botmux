import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraexInitialDelivery, useTraexInitialArg, traexInitialExecFits } from '../src/services/traex-initial-delivery.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { traexRestoredComposerReady } from '../src/adapters/cli/traex-footer.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'traex-initial-'));
  roots.push(root);
  const history = join(root, 'history.jsonl');
  const receipt = new TraexInitialDelivery(root, 'session-one');
  return { root, history, receipt };
}
const allowed = {
  version: '0.215.0', platform: 'linux', backend: 'tmux',
  prompt: '首条任务', turnId: 'turn-one', dataDir: '/private/data',
};

describe('TRAE native first-input selection', () => {
  it.each(['0.214.1', '0.215.0'])('admits the exercised %s versions on both local backends', version => {
    for (const platform of ['linux', 'darwin']) for (const backend of ['pty', 'tmux']) {
      expect(useTraexInitialArg({ ...allowed, version, platform, backend })).toBe(true);
    }
  });
  it.each([
    { version: undefined }, { version: '0.215.1' }, { platform: 'win32' },
    { backend: 'zmx' }, { prompt: '' }, { turnId: undefined }, { dataDir: undefined },
    { resume: true }, { fork: true }, { adopt: true }, { reattach: true },
    { startupWork: true }, { wrapper: true }, { sandbox: true }, { durable: true },
    { rpc: true }, { quota: true }, { extraArgs: true }, { prompt: '中'.repeat(30_000) },
  ])('retains terminal ownership for %j', overrides => {
    expect(useTraexInitialArg({ ...allowed, ...overrides })).toBe(false);
  });
  it('accounts for UTF-8 argv and the complete environment', () => {
    expect(traexInitialExecFits(['--', '中'.repeat(20_000)], { HOME: '/tmp/home' })).toBe(true);
    expect(traexInitialExecFits(['--', '中'.repeat(50_000)], {})).toBe(false);
    expect(traexInitialExecFits(['--', 'task'], { A: 'a'.repeat(100_000), B: 'b'.repeat(100_000) })).toBe(false);
  });
  it.each(['-task', '中文\n"quoted"\n$(literal)', 'a'.repeat(7831)])('preserves one literal native argument', prompt => {
    const adapter = createTraexAdapter('/bin/true');
    const args = adapter.buildArgs({ sessionId: 'session', initialPrompt: prompt, model: 'auto' });
    expect(args.slice(-2)).toEqual(['--', prompt]);
    expect(adapter.buildArgs({ sessionId: 'session', resume: true,
      resumeSessionId: 'native', initialPrompt: prompt })).not.toContain(prompt);
    expect(adapter.buildArgs({ sessionId: 'session', forkSession: true,
      initialPrompt: prompt })).not.toContain(prompt);
  });
});

describe('TRAE first delivery recovery', () => {
  it('allows only one dispatch when two workers both observed an absent receipt', () => {
    const { root, receipt, history } = fixture();
    const rival = new TraexInitialDelivery(root, 'session-one');
    const first = receipt.prepare('task', 'turn-one', 1, history);
    const second = rival.prepare('task', 'turn-one', 2, history);
    receipt.dispatch(first);
    expect(() => rival.dispatch(second)).toThrow();
    expect(new TraexInitialDelivery(root, 'session-one').record?.deliveryId).toBe(first.deliveryId);
  });
  it('records before dispatch and never replays the fsync/spawn crash gap', () => {
    const { root, receipt, history } = fixture();
    const record = receipt.prepare('same body', 'turn-one', 1, history);
    expect(new TraexInitialDelivery(root, 'session-one').record).toBeUndefined();
    receipt.dispatch(record);
    const successor = new TraexInitialDelivery(root, 'session-one');
    expect(successor.pending).toBe(true);
    expect(successor.owns('same body', 'turn-one')).toBe(true);
    expect(successor.owns('same body', 'turn-two')).toBe(false);
    expect(() => successor.prepare('same body', 'turn-one', 2, history)).toThrow();
    expect(successor.confirm(record.deliveryId)).toBeUndefined();
    expect(statSync(receipt.path).mode & 0o777).toBe(0o600);
  });
  it('requires full content with the per-dispatch marker, excluding another bot with identical text', () => {
    const { receipt, history } = fixture();
    const record = receipt.prepare('same body', 'turn-one', 1, history);
    receipt.dispatch(record);
    appendFileSync(history, `${JSON.stringify({ session_id: 'other', text: 'same body' })}\n`);
    expect(receipt.confirm(record.deliveryId)).toBeUndefined();
    const line = JSON.stringify({ session_id: 'ours', text: record.content });
    appendFileSync(history, line);
    expect(receipt.confirm(record.deliveryId)).toBeUndefined();
    appendFileSync(history, '\n');
    expect(receipt.confirm(record.deliveryId)).toBe('ours');
    expect(receipt.pending).toBe(false);
  });
  it('keeps unknown across long waits, then persists late confirmation through a restart', () => {
    vi.useFakeTimers();
    const { root, receipt, history } = fixture();
    const record = receipt.prepare('task', 'turn-one', 1, history);
    receipt.dispatch(record);
    vi.advanceTimersByTime(120_000);
    receipt.markUnknown(record.deliveryId);
    const successor = new TraexInitialDelivery(root, 'session-one');
    expect(successor.record?.state).toBe('unknown');
    appendFileSync(history, `${JSON.stringify({ session_id: 'ours', text: record.content })}\n`);
    expect(successor.confirm(record.deliveryId)).toBe('ours');
    expect(new TraexInitialDelivery(root, 'session-one').record?.cliSessionId).toBe('ours');
    expect(() => successor.dispatch(record)).toThrow();
  });
  it('does not let a stale callback mutate the current delivery', () => {
    const { receipt, history } = fixture();
    const record = receipt.prepare('task', 'turn-one', 8, history);
    receipt.dispatch(record);
    appendFileSync(history, `${JSON.stringify({ session_id: 'ours', text: record.content })}\n`);
    expect(receipt.confirm('previous-generation-delivery')).toBeUndefined();
    receipt.markUnknown('previous-generation-delivery');
    expect(receipt.record?.state).toBe('dispatched');
    expect(receipt.confirm(record.deliveryId)).toBe('ours');
  });
  it('retains a confirmation written by another reader when history has rotated', () => {
    const { root, receipt, history } = fixture();
    const record = receipt.prepare('task', 'turn-one', 1, history);
    receipt.dispatch(record);
    const stale = new TraexInitialDelivery(root, 'session-one');
    appendFileSync(history, `${JSON.stringify({ session_id: 'ours', text: record.content })}\n`);
    expect(receipt.confirm(record.deliveryId)).toBe('ours');
    renameSync(history, `${history}.old`);
    stale.markUnknown(record.deliveryId);
    expect(new TraexInitialDelivery(root, 'session-one').record?.state).toBe('confirmed');
    expect(stale.confirm(record.deliveryId)).toBe('ours');
    expect(stale.pending).toBe(false);
  });
  it('finds the exact new receipt after rotation without treating absent history as unsent', () => {
    const { receipt, history } = fixture();
    writeFileSync(history, 'old history\n'.repeat(100));
    const record = receipt.prepare('task', 'turn-one', 1, history);
    receipt.dispatch(record);
    renameSync(history, `${history}.old`);
    expect(receipt.confirm(record.deliveryId)).toBeUndefined();
    writeFileSync(history, `${JSON.stringify({ session_id: 'ours', text: record.content })}\n`);
    expect(receipt.confirm(record.deliveryId)).toBe('ours');
  });
  it('fails closed on corrupt receipt instead of creating another delivery', () => {
    const { root, receipt, history } = fixture();
    receipt.dispatch(receipt.prepare('task', 'turn-one', 1, history));
    writeFileSync(receipt.path, readFileSync(receipt.path, 'utf8').slice(0, 20));
    expect(() => new TraexInitialDelivery(root, 'session-one')).toThrow();
  });
});

describe('TRAE editable versus submit-ready footer', () => {
  it('keeps short/warning footers display-compatible without granting startup submission', () => {
    for (const footer of ['? for shortcuts', '? for shortcuts   ⚠ 2 warnings · f2 to view', '⚠ 2']) {
      const screen = `❯ Ask TRAE CLI to do anything\n──────────────────\n  ${footer}`;
      expect(traexRestoredComposerReady(screen)).toBe(true);
      expect(traexRestoredComposerReady(screen, { requireModelFooter: true })).toBe(false);
    }
    expect(traexRestoredComposerReady('❯ Ask TRAE CLI to do anything\n  GPT-6 · Context 100% left',
      { requireModelFooter: true })).toBe(true);
  });
});
