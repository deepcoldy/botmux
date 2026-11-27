/**
 * Worker-local SessionStart signal channel (workflow workers): the hook-side
 * writer, the worker-side claim/validate, and the per-spawn watcher. Real
 * files in a private temp root; the watcher runs on an injected manual timer,
 * so early / late / repeated / stale-generation orderings are explicit.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgeLocalSessionReadySignal,
  consumeLocalSessionReadySignal,
  createLocalSessionReadyChannel,
  SESSION_READY_SIGNAL_FILE_ENV,
  SESSION_READY_SIGNAL_NONCE_ENV,
  startLocalSessionReadyWatcher,
  waitForLocalSessionReadyAck,
  writeLocalSessionReadySignal,
  type LocalSessionReadyChannel,
} from '../src/utils/session-ready-local-signal.js';
import { sanitizePerBotEnv } from '../src/core/per-bot-env.js';

const roots: string[] = [];
const channels: LocalSessionReadyChannel[] = [];

afterEach(() => {
  for (const c of channels.splice(0)) c.dispose();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function root(): string {
  const r = mkdtempSync(join(tmpdir(), 'bmx-ready-signal-test-'));
  roots.push(r);
  return r;
}

function channel(): LocalSessionReadyChannel {
  const c = createLocalSessionReadyChannel(root());
  channels.push(c);
  return c;
}

/** Manual interval driver: each tick() runs the registered callbacks once. */
function manualTimers() {
  const fns = new Map<number, () => void>();
  let next = 1;
  return {
    timers: {
      setInterval: (fn: () => void) => { const id = next++; fns.set(id, fn); return id; },
      clearInterval: (h: unknown) => { fns.delete(h as number); },
    },
    tick: () => { for (const fn of [...fns.values()]) fn(); },
    active: () => fns.size,
  };
}

describe('local SessionStart channel — writer and reader', () => {
  it('creates a private per-spawn directory and env that per-bot env cannot set', () => {
    const c = channel();
    const env = c.env();
    expect(Object.keys(env).sort()).toEqual([SESSION_READY_SIGNAL_FILE_ENV, SESSION_READY_SIGNAL_NONCE_ENV].sort());
    expect(env[SESSION_READY_SIGNAL_FILE_ENV]).toBe(c.filePath);
    expect(readdirSync(dirname(dirname(c.filePath)))).toHaveLength(1);
    expect(statSync(dirname(c.filePath)).mode & 0o777).toBe(0o700);
    // A bot's configurable env is sanitized before it reaches the CLI child.
    expect(sanitizePerBotEnv({ ...env, KEEP_ME: '1' })).toEqual({ KEEP_ME: '1' });
  });

  it('delivers one signal per write and consumes it exactly once', () => {
    const c = channel();
    expect(consumeLocalSessionReadySignal(c)).toEqual({ kind: 'none' });
    expect(writeLocalSessionReadySignal(c.env(), 'startup')).toMatch(/^[0-9a-f]{32}$/);
    expect(consumeLocalSessionReadySignal(c)).toMatchObject({ kind: 'signal', source: 'startup' });
    expect(consumeLocalSessionReadySignal(c)).toEqual({ kind: 'none' });
    // A later SessionStart (clear/compact) is a new event on the same spawn.
    expect(writeLocalSessionReadySignal(c.env(), 'clear')).toMatch(/^[0-9a-f]{32}$/);
    expect(consumeLocalSessionReadySignal(c)).toMatchObject({ kind: 'signal', source: 'clear' });
    // No temp or claimed leftovers.
    expect(readdirSync(dirname(c.filePath))).toEqual([]);
  });

  it('collapses writes that land between two polls into one signal (last write wins)', () => {
    const c = channel();
    expect(writeLocalSessionReadySignal(c.env(), 'startup')).toMatch(/^[0-9a-f]{32}$/);
    expect(writeLocalSessionReadySignal(c.env(), 'resume')).toMatch(/^[0-9a-f]{32}$/);
    expect(consumeLocalSessionReadySignal(c)).toMatchObject({ kind: 'signal', source: 'resume' });
    expect(consumeLocalSessionReadySignal(c)).toEqual({ kind: 'none' });
  });

  it('drops an unknown source value but keeps the signal', () => {
    const c = channel();
    expect(writeLocalSessionReadySignal(c.env(), 'Weird Source;rm')).toMatch(/^[0-9a-f]{32}$/);
    const read = consumeLocalSessionReadySignal(c);
    expect(read).toMatchObject({ kind: 'signal' });
    expect(read).not.toHaveProperty('source');
  });

  it('refuses a missing, malformed or non-private channel so the caller keeps the daemon route', () => {
    const c = channel();
    expect(writeLocalSessionReadySignal({}, 'startup')).toBeNull();
    expect(writeLocalSessionReadySignal({ ...c.env(), [SESSION_READY_SIGNAL_NONCE_ENV]: 'short' }, 'startup')).toBeNull();
    expect(writeLocalSessionReadySignal({ ...c.env(), [SESSION_READY_SIGNAL_FILE_ENV]: 'relative/session-ready.json' }, 'startup')).toBeNull();
    expect(writeLocalSessionReadySignal({ ...c.env(), [SESSION_READY_SIGNAL_FILE_ENV]: join(dirname(c.filePath), 'other.json') }, 'startup')).toBeNull();
    chmodSync(dirname(c.filePath), 0o755);
    expect(writeLocalSessionReadySignal(c.env(), 'startup')).toBeNull();
    chmodSync(dirname(c.filePath), 0o700);
    // A symlinked directory is not the worker's private directory.
    const linkDir = join(root(), 'linked');
    symlinkSync(dirname(c.filePath), linkDir);
    expect(writeLocalSessionReadySignal({ ...c.env(), [SESSION_READY_SIGNAL_FILE_ENV]: join(linkDir, 'session-ready.json') }, 'startup')).toBeNull();
    expect(consumeLocalSessionReadySignal(c)).toEqual({ kind: 'none' });
  });

  it('replaces a planted symlink instead of writing through it', () => {
    const c = channel();
    const outside = join(root(), 'outside.txt');
    writeFileSync(outside, 'untouched');
    symlinkSync(outside, c.filePath);
    expect(writeLocalSessionReadySignal(c.env(), 'startup')).toMatch(/^[0-9a-f]{32}$/);
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
    expect(consumeLocalSessionReadySignal(c)).toMatchObject({ kind: 'signal', source: 'startup' });
  });

  it('rejects a symlink, a directory, malformed or oversized content at the signal path', () => {
    const c = channel();
    const outside = join(root(), 'outside.json');
    writeFileSync(outside, JSON.stringify({ v: 1, nonce: c.nonce, id: 'a'.repeat(32), source: 'startup' }));
    symlinkSync(outside, c.filePath);
    expect(consumeLocalSessionReadySignal(c)).toEqual({ kind: 'invalid', reason: 'not-regular-file' });
    expect(existsSync(outside)).toBe(true);

    mkdirSync(c.filePath);
    expect(consumeLocalSessionReadySignal(c)).toMatchObject({ kind: 'invalid' });

    for (const body of ['not json', '[]', JSON.stringify({ v: 2, nonce: c.nonce, id: 'a'.repeat(32) }), JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, nonce: c.nonce })]) {
      writeFileSync(c.filePath, body);
      expect(consumeLocalSessionReadySignal(c), body).toEqual({ kind: 'invalid', reason: 'malformed' });
    }
    writeFileSync(c.filePath, JSON.stringify({ v: 1, nonce: c.nonce, id: 'a'.repeat(32), pad: 'x'.repeat(2048) }));
    expect(consumeLocalSessionReadySignal(c)).toEqual({ kind: 'invalid', reason: 'too-large' });
    // Every rejected entry was claimed away: the next valid write is read normally.
    expect(writeLocalSessionReadySignal(c.env(), 'startup')).toMatch(/^[0-9a-f]{32}$/);
    expect(consumeLocalSessionReadySignal(c)).toMatchObject({ kind: 'signal', source: 'startup' });
  });

  it('never accepts a previous spawn’s hook', () => {
    const old = channel();
    const oldEnv = old.env();
    old.dispose();
    // Its directory is gone: the old hook cannot deliver, and falls back to the daemon route.
    expect(writeLocalSessionReadySignal(oldEnv, 'startup')).toBeNull();
    // An old nonce aimed at the new spawn's path is rejected by the new spawn.
    const current = channel();
    expect(writeLocalSessionReadySignal({ ...oldEnv, [SESSION_READY_SIGNAL_FILE_ENV]: current.filePath }, 'startup')).toMatch(/^[0-9a-f]{32}$/);
    expect(consumeLocalSessionReadySignal(current)).toEqual({ kind: 'invalid', reason: 'nonce-mismatch' });
  });

  it('dispose removes the directory with an unconsumed signal and is idempotent', () => {
    const c = channel();
    expect(writeLocalSessionReadySignal(c.env(), 'startup')).toMatch(/^[0-9a-f]{32}$/);
    c.dispose();
    c.dispose();
    expect(existsSync(dirname(c.filePath))).toBe(false);
  });
});

describe('local SessionStart channel — watcher ordering', () => {
  function watch(c: LocalSessionReadyChannel, current: { value: boolean }, onSignal?: (s: string | undefined) => void) {
    const t = manualTimers();
    const signals: (string | undefined)[] = [];
    const invalid: string[] = [];
    const w = startLocalSessionReadyWatcher({
      channel: c, intervalMs: 200, timers: t.timers,
      isCurrent: () => current.value,
      onSignal: s => { signals.push(s); onSignal?.(s); },
      onInvalid: r => invalid.push(r),
    });
    return { ...t, w, signals, invalid };
  }

  it('picks up a signal written before the watcher started', () => {
    const c = channel();
    expect(writeLocalSessionReadySignal(c.env(), 'startup')).toMatch(/^[0-9a-f]{32}$/);
    const h = watch(c, { value: true });
    expect(h.signals).toEqual(['startup']);
    h.tick();
    expect(h.signals).toEqual(['startup']);
  });

  it('delivers a late signal on the next poll, and each later write once', () => {
    const c = channel();
    const h = watch(c, { value: true });
    h.tick();
    h.tick();
    expect(h.signals).toEqual([]);
    writeLocalSessionReadySignal(c.env(), 'startup');
    h.tick();
    writeLocalSessionReadySignal(c.env(), 'compact');
    h.tick();
    h.tick();
    expect(h.signals).toEqual(['startup', 'compact']);
  });

  it('stops without consuming once its spawn is no longer current', () => {
    const c = channel();
    const current = { value: true };
    const h = watch(c, current);
    current.value = false;
    writeLocalSessionReadySignal(c.env(), 'startup');
    h.tick();
    expect(h.signals).toEqual([]);
    expect(h.active()).toBe(0);
    // Left for dispose(); nothing else reads it.
    expect(existsSync(c.filePath)).toBe(true);
  });

  it('stop() ends polling and reports invalid entries without delivering them', () => {
    const c = channel();
    const h = watch(c, { value: true });
    writeFileSync(c.filePath, 'garbage');
    h.tick();
    expect(h.invalid).toEqual(['malformed']);
    h.w.stop();
    expect(h.active()).toBe(0);
    writeLocalSessionReadySignal(c.env(), 'startup');
    h.w.poll();
    expect(h.signals).toEqual([]);
  });
});

describe('local SessionStart channel — ack ordering', () => {
  const ackPath = (c: LocalSessionReadyChannel) => join(dirname(c.filePath), 'session-ready.ack');
  /** Deterministic clock for the hook's bounded wait: each sleep advances it. */
  function clock() {
    let t = 0;
    const sleeps: number[] = [];
    return {
      now: () => t,
      sleepWith: (onSleep?: (n: number) => void) => async (ms: number) => { sleeps.push(ms); t += ms; onSleep?.(sleeps.length); },
      sleeps,
    };
  }

  it('acks only after the handler ran, and the hook accepts exactly that ack', async () => {
    const c = channel();
    const order: string[] = [];
    const id = writeLocalSessionReadySignal(c.env(), 'startup')!;
    const h = watchWith(c, () => {
      // The ack must not exist while the boundary is being established.
      order.push(existsSync(ackPath(c)) ? 'ack-before-handler' : 'handler');
    });
    expect(order).toEqual(['handler']);
    expect(h.signals).toEqual(['startup']);
    const k = clock();
    await expect(waitForLocalSessionReadyAck(c.env(), id, 2_000, { now: k.now, sleep: k.sleepWith() })).resolves.toBe(true);
    expect(k.sleeps).toEqual([]);
    // Consumed by the hook.
    expect(existsSync(ackPath(c))).toBe(false);
  });

  it('a late ack releases the waiting hook on the poll after it lands', async () => {
    const c = channel();
    const id = writeLocalSessionReadySignal(c.env(), 'startup')!;
    const k = clock();
    const waiting = waitForLocalSessionReadyAck(c.env(), id, 2_000, {
      now: k.now, pollMs: 20,
      sleep: k.sleepWith(n => { if (n === 3) acknowledgeLocalSessionReadySignal(c, id); }),
    });
    await expect(waiting).resolves.toBe(true);
    expect(k.sleeps).toHaveLength(3);
  });

  it('times out fail-open after the bound when no ack arrives', async () => {
    const c = channel();
    const id = writeLocalSessionReadySignal(c.env(), 'startup')!;
    const k = clock();
    await expect(waitForLocalSessionReadyAck(c.env(), id, 2_000, { now: k.now, pollMs: 20, sleep: k.sleepWith() })).resolves.toBe(false);
    expect(k.now()).toBe(2_000);
  });

  it('ignores an ack for another signal, another spawn, or a malformed / symlinked ack', async () => {
    const c = channel();
    const earlier = writeLocalSessionReadySignal(c.env(), 'startup')!;
    consumeLocalSessionReadySignal(c);
    const id = writeLocalSessionReadySignal(c.env(), 'clear')!;
    const other = channel();
    const outside = join(root(), 'forged.ack');
    writeFileSync(outside, JSON.stringify({ v: 1, nonce: c.nonce, id }));
    const forgeries: Array<() => void> = [
      () => acknowledgeLocalSessionReadySignal(c, earlier), // a previous signal's ack (early/duplicate)
      () => writeFileSync(ackPath(c), JSON.stringify({ v: 1, nonce: other.nonce, id })), // another spawn
      () => writeFileSync(ackPath(c), 'anything'), // arbitrary body
      () => writeFileSync(ackPath(c), JSON.stringify({ v: 2, nonce: c.nonce, id })), // wrong version
      () => { rmSync(ackPath(c), { force: true }); symlinkSync(outside, ackPath(c)); }, // symlink to a valid-looking ack
    ];
    for (const forge of forgeries) {
      rmSync(ackPath(c), { force: true });
      forge();
      const k = clock();
      await expect(waitForLocalSessionReadyAck(c.env(), id, 100, { now: k.now, pollMs: 20, sleep: k.sleepWith() })).resolves.toBe(false);
    }
    rmSync(ackPath(c), { force: true });
    acknowledgeLocalSessionReadySignal(c, id);
    const k = clock();
    await expect(waitForLocalSessionReadyAck(c.env(), id, 100, { now: k.now, sleep: k.sleepWith() })).resolves.toBe(true);
  });

  it('does not ack when the handler throws', () => {
    const c = channel();
    writeLocalSessionReadySignal(c.env(), 'startup');
    const h = watchWith(c, () => { throw new Error('boom'); });
    expect(h.invalid).toEqual(['handler-error']);
    expect(existsSync(ackPath(c))).toBe(false);
  });

  it('does not ack once the spawn stopped being current during the handler', () => {
    const c = channel();
    writeLocalSessionReadySignal(c.env(), 'startup');
    const current = { value: true };
    const h = watchWith(c, () => { current.value = false; }, current);
    expect(h.signals).toEqual(['startup']);
    expect(existsSync(ackPath(c))).toBe(false);
  });
});

function watchWith(c: LocalSessionReadyChannel, onSignal: () => void, current = { value: true }) {
  const signals: (string | undefined)[] = [];
  const invalid: string[] = [];
  startLocalSessionReadyWatcher({
    channel: c, intervalMs: 200,
    timers: { setInterval: () => 1, clearInterval: () => {} },
    isCurrent: () => current.value,
    onSignal: s => { signals.push(s); onSignal(); },
    onInvalid: r => invalid.push(r),
  });
  return { signals, invalid };
}
