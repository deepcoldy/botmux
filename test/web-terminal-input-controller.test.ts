import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';
import { WebTerminalInputController, WebTerminalInputWireState } from '../src/core/web-terminal-input-controller.js';
import { terminalInputSubmits } from '../src/adapters/cli/tui-input.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const REPLY = '\x1b]11;rgb:1a1a/1b1b/2626\x1b\\';
type Target = { backend: object; lifetime: number; generation: number; binding: object; transport: object };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { resolve, promise };
}
async function drain() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function recordWireInput(wire: WebTerminalInputWireState, operation: 'written' | 'accepted',
  data: string, owner: symbol) {
  wire[operation](data, owner);
  // These parser controls use a direct writer; accepted bytes are also
  // physically acknowledged. Queued-but-unwritten cases are tested separately.
  if (operation === 'accepted') wire.written(data, owner);
}

function fixture(options: { maxUserBytes?: number; maxUserMessages?: number; carryMs?: number } = {},
  shared?: { target: Target; wire: WebTerminalInputWireState }) {
  const current: Target = shared?.target ?? { backend: {}, lifetime: 1, generation: 1, binding: {}, transport: {} };
  let currentWire = shared?.wire ?? new WebTerminalInputWireState();
  let wireTarget = { ...current };
  let writable = true, open = true, fork = false, now = 0;
  const context = new AsyncLocalStorage<Target>();
  const timers = new Map<object, { callback: () => void; at: number }>();
  const writes: string[] = [], userInputs: Array<{ data: string; submit: boolean }> = [];
  const writeCalls: Array<{ target: Target; data: string; owner: symbol }> = [];
  const uncertainTargets: Target[] = [];
  const holds: boolean[] = [], audit: boolean[] = [];
  let cancellations = 0, efforts = 0, overflows = 0;
  let uncertainties = 0;
  let before: () => Promise<boolean> = async () => true;
  let effort: () => Promise<void> = async () => {};
  let write: (data: string, owner: symbol) => boolean | 'queued' = () => true;
  let onUser: (data: string, submit: boolean) => void = () => {};
  let onHold: (held: boolean) => void = () => {};
  const owns = (target: Target) => writable && open && !fork
    && (Object.keys(current) as Array<keyof Target>).every(key => target[key] === current[key]);
  const controller = new WebTerminalInputController<Target>({
    capture: () => writable && open && !fork ? { ...current } : undefined,
    isCurrent: owns,
    wireState: target => {
      if (target.backend !== wireTarget.backend || target.lifetime !== wireTarget.lifetime
        || target.generation !== wireTarget.generation) {
        currentWire = new WebTerminalInputWireState(); wireTarget = { ...target };
      }
      return currentWire;
    },
    runInTarget: (target, run) => context.run(target, run),
    beforeUserInput: async target => {
      expect(context.getStore()).toBe(target);
      cancellations++; return before();
    },
    cancelEffort: async target => {
      expect(context.getStore()).toBe(target);
      efforts++; await effort();
    },
    write: (target, data, owner) => {
      expect(context.getStore()).toBe(target);
      writes.push(data); writeCalls.push({ target, data, owner }); return write(data, owner);
    },
    onUserInput: (target, data, submit) => {
      expect(context.getStore()).toBe(target);
      userInputs.push({ data, submit }); onUser(data, submit);
    },
    audit: (_target, input) => { audit.push(input.hasUser); },
    onPendingChange: (_target, held) => { holds.push(held); onHold(held); },
    onOverflow: () => { overflows++; open = false; },
    onTransportUncertain: target => { uncertainties++; uncertainTargets.push(target); },
    now: () => now,
    setTimer: (callback, ms) => { const id = {}; timers.set(id, { callback, at: now + ms }); return id; },
    clearTimer: id => { timers.delete(id as object); },
  }, options);
  const tick = async (time: number) => {
    now = time;
    for (const [id, timer] of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(id); timer.callback();
    }
    await drain();
  };
  return {
    controller, current, writes, writeCalls, uncertainTargets, userInputs, holds, audit, timers, tick,
    stats: () => ({ cancellations, efforts, overflows }),
    uncertainties: () => uncertainties,
    setWritable: (value: boolean) => { writable = value; },
    setOpen: (value: boolean) => { open = value; },
    setFork: (value: boolean) => { fork = value; },
    before: (fn: () => Promise<boolean>) => { before = fn; },
    effort: (fn: () => Promise<void>) => { effort = fn; },
    write: (fn: (data: string, owner: symbol) => boolean | 'queued') => { write = fn; },
    onUser: (fn: (data: string, submit: boolean) => void) => { onUser = fn; },
    onHold: (fn: (held: boolean) => void) => { onHold = fn; },
  };
}

describe('WebTerminalInputController', () => {
  it.each([
    { inputName: 'user input', next: 'second' },
    { inputName: 'neutral reply', next: REPLY },
  ])('waits to physically write $inputName until another connection queued complete paste is replayed',
    async ({ next }) => {
      const shared = { target: { backend: {}, lifetime: 1, generation: 1, binding: {}, transport: {} },
        wire: new WebTerminalInputWireState() };
      const a = fixture({}, shared), b = fixture({}, shared);
      const queue: Array<{ data: string; owner: symbol }> = [];
      const physical: Array<{ data: string; owner: symbol }> = [];
      const paste = '\x1b[200~first\r\n\x1b[201~';
      a.write((data, owner) => { queue.push({ data, owner }); return 'queued'; });
      b.write((data, owner) => { physical.push({ data, owner }); return true; });
      try {
        expect(await a.controller.accept(paste)).toBe('forwarded');
        expect(queue.map(item => item.data)).toEqual([paste]);
        expect(queue[0]!.owner).toBe(a.writeCalls[0]!.owner);
        expect(shared.wire.writer.inPaste).toBe(false);
        expect(shared.wire.acceptedWriter.inPaste).toBe(false);
        expect(physical).toEqual([]);

        let settled = false;
        const second = b.controller.accept(next).then(result => { settled = true; return result; });
        await drain();
        expect(settled).toBe(false);
        expect(b.writeCalls).toEqual([]);
        expect(physical).toEqual([]);

        const first = queue.shift()!;
        physical.push(first);
        shared.wire.written(first.data, first.owner);
        expect(await second).toBe('forwarded');
        expect(physical.map(item => item.data)).toEqual([paste, next]);
        expect(physical[1]!.owner).toBe(b.writeCalls[0]!.owner);
        expect(physical[1]!.owner).not.toBe(first.owner);
        expect(queue).toEqual([]);
        expect(shared.wire.inPaste).toBe(false);
        expect(shared.wire.dirty).toBe(false);
      } finally {
        a.controller.dispose(); b.controller.dispose();
      }
    },
  );

  it.each([
    { inputName: 'user input', next: 'second' },
    { inputName: 'neutral reply', next: REPLY },
  ])('discards a disposed connection queued paste-start without blocking later $inputName',
    async ({ next }) => {
      const shared = { target: { backend: {}, lifetime: 1, generation: 1, binding: {}, transport: {} },
        wire: new WebTerminalInputWireState() };
      const a = fixture({}, shared), b = fixture({}, shared);
      const queue: Array<{ data: string; owner: symbol }> = [];
      const physical: string[] = [];
      a.write((data, owner) => { queue.push({ data, owner }); return 'queued'; });
      b.write(data => { physical.push(data); return true; });
      try {
        expect(await a.controller.accept('\x1b[200~first')).toBe('forwarded');
        expect(queue.map(item => item.data)).toEqual(['\x1b[200~first']);
        expect(shared.wire.owner).toBe(queue[0]!.owner);
        expect(queue[0]!.owner).toBe(a.writeCalls[0]!.owner);
        expect(shared.wire.writer.inPaste).toBe(false);
        expect(shared.wire.acceptedWriter.inPaste).toBe(true);
        expect(physical).toEqual([]);

        let settled = false;
        const second = b.controller.accept(next).then(result => { settled = true; return result; });
        await drain();
        expect(settled).toBe(false);
        expect(b.writeCalls).toEqual([]);
        a.controller.dispose();
        expect(shared.wire.dirty).toBe(false);
        expect(shared.wire.owner).toBeUndefined();
        expect(shared.wire.acceptedWriter.inPaste).toBe(false);
        expect(shared.wire.inPaste).toBe(false);
        expect(a.uncertainTargets).toEqual([]);
        // The disposed owner's queued bytes are discarded, never replayed.
        expect(await second).toBe('forwarded');
        expect(physical).toEqual([next]);
        expect(shared.wire.dirty).toBe(false);
      } finally {
        a.controller.dispose(); b.controller.dispose();
      }
    },
  );

  it.each([
    { pasteName: 'ESC CSI', paste: '\x1b[200~unwritten\r\n\x1b[201~' },
    { pasteName: 'C1 CSI', paste: '\x9b200~unwritten\r\n\x9b201~' },
  ])('keeps the wire clean after write=false rejects an explicitly unwritten complete paste ($pasteName)',
    async ({ paste }) => {
      const shared = { target: { backend: {}, lifetime: 1, generation: 1, binding: {}, transport: {} },
        wire: new WebTerminalInputWireState() };
      const f = fixture({}, shared);
      const physical: string[] = [];
      f.write(() => false);
      try {
        expect(await f.controller.accept(paste)).toBe('refused');
        expect(f.writes).toEqual([paste]);
        expect(shared.wire.writer.pending).toBe(false);
        expect(shared.wire.acceptedWriter.pending).toBe(false);
        expect(shared.wire.dirty).toBe(false);
        expect(f.uncertainTargets).toEqual([]);
        expect(f.controller.pending).toBe(false);
        f.write(data => { physical.push(data); return true; });
        expect(await f.controller.accept('later')).toBe('forwarded');
        expect(physical).toEqual(['later']);
        expect(shared.wire.dirty).toBe(false);
      } finally {
        f.controller.dispose();
      }
    },
  );

  it('keeps a physically written nonpaste Escape clean when the next ordinary input is refused', async () => {
    const shared = { target: { backend: {}, lifetime: 1, generation: 1, binding: {}, transport: {} },
      wire: new WebTerminalInputWireState() };
    const f = fixture({}, shared);
    try {
      expect(await f.controller.accept('\x1b', { forceUser: true })).toBe('forwarded');
      expect(f.writes).toEqual(['\x1b']);
      expect(shared.wire.writer.pending).toBe(true);
      expect(shared.wire.writer.inPaste).toBe(false);
      expect(shared.wire.acceptedWriter.inPaste).toBe(false);
      f.before(async () => false);
      expect(await f.controller.accept('refused')).toBe('refused');
      expect(f.writes).toEqual(['\x1b']);
      expect(shared.wire.dirty).toBe(false);
      expect(f.uncertainTargets).toEqual([]);
      expect(f.controller.pending).toBe(false);
      f.before(async () => true);
      expect(await f.controller.accept('later')).toBe('forwarded');
      expect(f.writes).toEqual(['\x1b', 'later']);
      expect(shared.wire.dirty).toBe(false);
    } finally {
      f.controller.dispose();
    }
  });

  it.each(['dispose', 'throw'] as const)(
    'marks an actually written partial paste uncertain on its captured target after %s',
    async action => {
      const shared = { target: { backend: {}, lifetime: 1, generation: 1, binding: {}, transport: {} },
        wire: new WebTerminalInputWireState() };
      const a = fixture({}, shared), b = fixture({}, shared);
      try {
        expect(await a.controller.accept('\x1b[200~written')).toBe('forwarded');
        const captured = a.writeCalls[0]!.target;
        expect(shared.wire.writer.inPaste).toBe(true);
        expect(shared.wire.owner).toBe(a.writeCalls[0]!.owner);
        if (action === 'dispose') a.controller.dispose();
        else {
          a.write(() => { throw new Error('unconfirmed continuation'); });
          expect(await a.controller.accept('continuation')).toBe('failed');
        }
        expect(shared.wire.dirty).toBe(true);
        expect(a.uncertainties()).toBe(1);
        expect(a.uncertainTargets).toEqual([captured]);
        expect(a.uncertainTargets[0]).toBe(captured);
        expect(await b.controller.accept(REPLY)).toBe('refused');
        expect(b.writes).toEqual([]);
        a.controller.dispose();
        expect(a.uncertainties()).toBe(1);

        shared.target.backend = {};
        shared.target.generation++;
        expect(a.controller.pending).toBe(false);
        expect(await b.controller.accept('successor')).toBe('forwarded');
        expect(b.writes).toEqual(['successor']);
        expect(a.uncertainTargets[0]!.backend).toBe(captured.backend);
        expect(a.uncertainTargets[0]!.backend).not.toBe(shared.target.backend);
        expect(shared.wire.dirty).toBe(true);
      } finally {
        a.controller.dispose(); b.controller.dispose();
      }
    },
  );

  it('keeps a reply after the queued attach terminator before replay starts', async () => {
    const wire = new WebTerminalInputWireState();
    const queue: Array<{ data: string; owner: symbol }> = [];
    let before: () => Promise<boolean> = async () => true;
    const input = new WebTerminalInputController({
      capture: () => 1, isCurrent: () => true, wireState: () => wire,
      beforeUserInput: () => before(),
      write: (_target, data, owner) => { queue.push({ data, owner }); return 'queued' as const; },
    });
    await input.accept('\x1b[200~human');
    expect(wire.writer.inPaste).toBe(false);
    expect(wire.acceptedWriter.inPaste).toBe(true);
    const waiting = deferred<boolean>(); before = () => waiting.promise;
    const end = input.accept('\x1b[201~');
    await drain();
    const reply = input.accept('\x1b[O');
    await drain();
    expect(queue.map(item => item.data)).toEqual(['\x1b[200~human']);
    waiting.resolve(true);
    expect(await end).toBe('forwarded');
    expect(await reply).toBe('forwarded');
    expect(queue.map(item => item.data)).toEqual(['\x1b[200~human', '\x1b[201~', '\x1b[O']);
    for (const item of queue) wire.written(item.data, item.owner);
    expect(wire.writer.inPaste).toBe(false);
    expect(wire.dirty).toBe(false);
    input.dispose();
  });
  it('keeps a second connection reply outside the first connection paste', async () => {
    const shared = { target: { backend: {}, lifetime: 1, generation: 1, binding: {}, transport: {} },
      wire: new WebTerminalInputWireState() };
    const a = fixture({}, shared), b = fixture({}, shared);
    await a.controller.accept('\x1b[200~human');
    const reply = b.controller.accept(REPLY);
    await drain();
    expect(b.writes).toEqual([]);
    await a.controller.accept('\x1b[201~');
    expect(await reply).toBe('forwarded');
    expect(a.writes).toEqual(['\x1b[200~human', '\x1b[201~']);
    expect(b.writes).toEqual([REPLY]);
    expect(b.stats().cancellations).toBe(0);
    a.controller.dispose(); b.controller.dispose();
  });

  it('refuses another connection user batch without disturbing the paste owner', async () => {
    const shared = { target: { backend: {}, lifetime: 1, generation: 1, binding: {}, transport: {} },
      wire: new WebTerminalInputWireState() };
    const a = fixture({}, shared), b = fixture({}, shared);
    await a.controller.accept('\x1b[200~human');
    expect(await b.controller.accept('other')).toBe('refused');
    expect(b.writes).toEqual([]);
    expect(a.uncertainties()).toBe(0);
    await a.controller.accept('\x1b[201~');
    expect(await b.controller.accept('after')).toBe('forwarded');
    expect(b.writes).toEqual(['after']);
    a.controller.dispose(); b.controller.dispose();
  });

  it('refuses every connection after the shared writer paste becomes uncertain', async () => {
    const shared = { target: { backend: {}, lifetime: 1, generation: 1, binding: {}, transport: {} },
      wire: new WebTerminalInputWireState() };
    const a = fixture({}, shared), b = fixture({}, shared);
    await a.controller.accept('\x1b[200~human');
    const reply = b.controller.accept(REPLY);
    a.before(async () => false);
    expect(await a.controller.accept('\x1b[201~')).toBe('refused');
    expect(await reply).toBe('refused');
    expect(await b.controller.accept('new')).toBe('refused');
    expect(b.writes).toEqual([]);
    expect(shared.wire.dirty).toBe(true);
    a.controller.dispose(); b.controller.dispose();
  });
  it('keeps a neutral reply behind a paste terminator waiting for cancellation', async () => {
    const f = fixture();
    await f.controller.accept('\x1b[200~human');
    const waiting = deferred<boolean>();
    f.before(() => waiting.promise);
    const end = f.controller.accept('\x1b[201~');
    await drain();
    const reply = f.controller.accept(REPLY);
    await drain();
    expect(f.writes).toEqual(['\x1b[200~human']);
    waiting.resolve(true);
    expect(await end).toBe('forwarded');
    expect(await reply).toBe('forwarded');
    expect(f.writes).toEqual(['\x1b[200~human', '\x1b[201~', REPLY]);
    expect(f.stats().cancellations).toBe(2);
    expect(f.uncertainties()).toBe(0);
    f.controller.dispose();
  });

  it('stops further input when a written paste cannot be terminated', async () => {
    const f = fixture();
    await f.controller.accept('\x1b[200~human');
    const waiting = deferred<boolean>();
    f.before(() => waiting.promise);
    const end = f.controller.accept('\x1b[201~');
    await drain();
    const reply = f.controller.accept(REPLY);
    waiting.resolve(false);
    expect(await end).toBe('refused');
    expect(await reply).toBe('refused');
    expect(await f.controller.accept('new')).toBe('refused');
    expect(f.writes).toEqual(['\x1b[200~human']);
    expect(f.uncertainties()).toBe(1);
    expect(f.controller.pending).toBe(true);
    f.controller.dispose();
  });

  it('does not resurrect an unfinished paste after a write grant is revoked and restored', async () => {
    const f = fixture();
    await f.controller.accept('\x1b[200~human');
    const waiting = deferred<boolean>();
    f.before(() => waiting.promise);
    const end = f.controller.accept('\x1b[201~');
    await drain();
    f.setWritable(false);
    waiting.resolve(true);
    expect(await end).toBe('refused');
    f.setWritable(true);
    expect(await f.controller.accept(REPLY)).toBe('refused');
    expect(f.writes).toEqual(['\x1b[200~human']);
    expect(f.uncertainties()).toBe(1);
    f.controller.dispose();
  });

  it('does not continue after a paste write throws with unknown completion', async () => {
    const f = fixture();
    f.write(() => { throw new Error('unconfirmed paste write'); });
    expect(await f.controller.accept('\x1b[200~human\x1b[201~')).toBe('failed');
    expect(await f.controller.accept(REPLY)).toBe('refused');
    expect(f.uncertainties()).toBe(1);
    f.controller.dispose();
  });
  it('publishes cleared ownership before notifying a refused input observer', async () => {
    const f = fixture();
    f.before(async () => false);
    const observed: boolean[] = [];
    f.onHold(held => { if (!held) observed.push(f.controller.pending); });
    expect(await f.controller.accept('draft')).toBe('refused');
    expect(observed).toEqual([false]);
    expect(f.writes).toEqual([]);
    f.controller.dispose();
  });
  it('forwards repeated actual protocol data with zero real worker input generations', async () => {
    const f = fixture();
    // Transitional behavior seam: execute the real leaf, but invoke it only
    // through the production controller's admitted-user callback.
    const noteScope: Record<string, any> = {
      Date: { now: () => 1234 }, terminalInputSubmits, backendScreenRevision: 9,
      webTerminalInputGeneration: 0, webTerminalSubmitGeneration: 0,
      lastWebTerminalInputAtMs: 0, lastWebTerminalSubmitAtMs: 0,
    };
    const note = loadWorkerFunction('noteWebTerminalInput', noteScope);
    f.onUser(data => note(data));
    for (let i = 0; i < 120; i++) await f.controller.accept(REPLY);
    expect(f.writes).toEqual(Array(120).fill(REPLY));
    expect(f.stats()).toEqual({ cancellations: 0, efforts: 0, overflows: 0 });
    expect(noteScope.webTerminalInputGeneration).toBe(0);
    expect(noteScope.lastWebTerminalInputAtMs).toBe(0);
    expect(f.audit.every(user => !user)).toBe(true);
    await f.controller.accept('\x1b[200~');
    await f.controller.accept(REPLY);
    await f.controller.accept('\x1b[201~');
    expect(noteScope.webTerminalInputGeneration).toBe(3);
    expect(f.userInputs.map(input => input.data)).toEqual(['\x1b[200~', REPLY, '\x1b[201~']);
    f.controller.dispose();
  });

  it.each(['\x1b[A', '\x03', '\x1b[1;2R', '\x1b[<0;2;3M', '\x1b[<64;2;3M', 'draft', REPLY + 'text'])(
    'keeps real takeover effects for user/unknown input %j', async data => {
      const f = fixture();
      expect(await f.controller.accept(data)).toBe('forwarded');
      expect(f.writes).toEqual([data]);
      expect(f.stats()).toEqual({ cancellations: 1, efforts: 1, overflows: 0 });
      expect(f.userInputs).toHaveLength(1);
      expect(f.holds).toEqual([true, false]);
      f.controller.dispose();
    },
  );

  it('force-user never grants permission or downgrades text into protocol', async () => {
    const f = fixture();
    await f.controller.accept(REPLY, { forceUser: true });
    expect(f.stats().cancellations).toBe(1);
    await f.controller.accept(REPLY, { forceUser: 'protocol' });
    expect(f.stats().cancellations).toBe(1);
    f.setWritable(false);
    expect(await f.controller.accept(REPLY, { forceUser: true })).toBe('refused');
    expect(f.writes).toHaveLength(2);
    f.controller.dispose();
  });

  it('holds partial data, completes a split reply without cancelling, and expires a lone Escape', async () => {
    const f = fixture({ carryMs: 10 });
    expect(await f.controller.accept(REPLY.slice(0, 5))).toBe('pending');
    expect(f.controller.pending).toBe(true);
    expect(f.writes).toEqual([]);
    await f.tick(5);
    await f.controller.accept(REPLY.slice(5));
    expect(f.writes).toEqual([REPLY]);
    expect(f.holds).toEqual([true, false]);
    expect(f.stats().cancellations).toBe(0);
    await f.controller.accept('\x1b');
    await f.tick(15);
    expect(f.writes).toEqual([REPLY, '\x1b']);
    expect(f.stats().cancellations).toBe(1);
    expect(f.controller.pending).toBe(false);
    f.controller.dispose();
  });

  it('registers a hold before cancellation waits, lets pure replies bypass it, and keeps user order', async () => {
    const f = fixture();
    const waiting = deferred<boolean>();
    f.before(() => waiting.promise);
    const a = f.controller.accept('a');
    const b = f.controller.accept('b');
    expect(f.controller.pending).toBe(true);
    await drain();
    expect(f.writes).toEqual([]);
    expect(await f.controller.accept(REPLY)).toBe('forwarded');
    expect(f.writes).toEqual([REPLY]);
    expect(f.stats().cancellations).toBe(1);
    waiting.resolve(true);
    expect(await a).toBe('forwarded');
    expect(await b).toBe('forwarded');
    expect(f.writes).toEqual([REPLY, 'a', 'b']);
    expect(f.controller.pending).toBe(false);
    f.controller.dispose();
  });

  it.each(['backend', 'lifetime', 'generation', 'binding', 'transport', 'auth', 'close', 'fork'])(
    'refuses an old user batch after the cancellation await changes %s', async change => {
      const f = fixture(), waiting = deferred<boolean>();
      f.before(() => waiting.promise);
      const result = f.controller.accept('draft');
      await drain();
      if (change === 'auth') f.setWritable(false);
      else if (change === 'close') f.setOpen(false);
      else if (change === 'fork') f.setFork(true);
      else if (change === 'lifetime' || change === 'generation') f.current[change]++;
      else f.current[change as 'backend' | 'binding' | 'transport'] = {};
      waiting.resolve(true);
      expect(await result).toBe('refused');
      expect(f.writes).toEqual([]);
      expect(f.userInputs).toEqual([]);
      expect(f.stats().efforts).toBe(0);
      expect(f.controller.pending).toBe(false);
      f.controller.dispose();
    },
  );

  it('rechecks binding after effort cancellation and never writes to the successor', async () => {
    const f = fixture(), waiting = deferred<void>();
    f.effort(() => waiting.promise);
    const result = f.controller.accept('draft');
    await drain();
    f.current.binding = {};
    waiting.resolve();
    expect(await result).toBe('refused');
    expect(f.writes).toEqual([]);
    expect(f.userInputs).toEqual([]);
    f.controller.dispose();
  });

  it.each(['auth', 'close', 'generation'])('does not forward expired carries after %s', async change => {
    const f = fixture({ carryMs: 10 });
    await f.controller.accept('\x1b]11');
    if (change === 'auth') f.setWritable(false);
    else if (change === 'close') f.setOpen(false);
    else f.current.generation++;
    await f.tick(10);
    expect(f.writes).toEqual([]);
    expect(f.stats().cancellations).toBe(0);
    expect(f.controller.pending).toBe(false);
    expect(f.timers.size).toBe(0);
    f.controller.dispose();
  });

  it('discarding an old prefix and old timer cannot consume the new target prefix', async () => {
    const f = fixture({ carryMs: 10 });
    await f.controller.accept('\x1b]11');
    const old = [...f.timers.values()][0]!.callback;
    f.current.backend = {};
    await f.controller.accept('\x1b]10');
    old();
    expect(f.timers.size).toBe(1);
    expect(f.writes).toEqual([]);
    f.controller.dispose();
    expect(f.timers.size).toBe(0);
    await f.tick(100);
    expect(f.writes).toEqual([]);
  });

  it('a stale open paste hold is cleared when the current target is queried', async () => {
    const f = fixture();
    await f.controller.accept('\x1b[200~');
    expect(f.controller.pending).toBe(true);
    f.current.backend = {};
    expect(f.controller.pending).toBe(false);
    expect(f.holds.at(-1)).toBe(false);
    await f.controller.accept('\r');
    expect(f.userInputs.at(-1)?.submit).toBe(true);
    f.controller.dispose();
  });

  it.each(['bytes', 'messages'])('bounds pending user %s without truncating or replaying input', async limit => {
    const f = fixture(limit === 'bytes' ? { maxUserBytes: 2 } : { maxUserMessages: 1 });
    const waiting = deferred<boolean>();
    f.before(() => waiting.promise);
    const a = f.controller.accept('a');
    await drain();
    expect(await f.controller.accept(limit === 'bytes' ? 'long paste' : 'b')).toBe('refused');
    expect(f.stats().overflows).toBe(1);
    waiting.resolve(true);
    expect(await a).toBe('refused');
    expect(f.writes).toEqual([]);
    expect(f.controller.pending).toBe(false);
    expect(await f.controller.accept('c')).toBe('refused');
  });

  it('dispose clears carries without forwarding and refuses later input', async () => {
    const f = fixture();
    await f.controller.accept('\x1b');
    f.controller.dispose();
    await f.tick(1000);
    expect(f.timers.size).toBe(0);
    expect(f.writes).toEqual([]);
    expect(await f.controller.accept(REPLY)).toBe('refused');
  });

  it('refused and throwing user dependencies do not poison later admitted input', async () => {
    const f = fixture();
    f.before(async () => false);
    expect(await f.controller.accept('first')).toBe('refused');
    f.before(async () => { throw new Error('synthetic'); });
    expect(await f.controller.accept('second')).toBe('failed');
    f.before(async () => true);
    f.effort(async () => { throw new Error('synthetic'); });
    expect(await f.controller.accept('third')).toBe('failed');
    f.effort(async () => {});
    f.write(() => false);
    expect(await f.controller.accept('fourth')).toBe('refused');
    f.write(() => true);
    expect(await f.controller.accept('fifth')).toBe('forwarded');
    expect(f.writes).toEqual(['fourth', 'fifth']);
    expect(f.controller.pending).toBe(false);
    f.controller.dispose();
  });

  it('rejecting an unwritten user prefix invalidates queued fragments rather than sending a broken sequence', async () => {
    const f = fixture(), waiting = deferred<boolean>();
    f.before(() => waiting.promise);
    const prefix = f.controller.accept('\x1b', { forceUser: true });
    const tail = f.controller.accept('[I');
    await drain();
    waiting.resolve(false);
    expect(await prefix).toBe('refused');
    expect(await tail).toBe('refused');
    expect(f.writes).toEqual([]);
    expect(f.userInputs).toEqual([]);
    expect(f.controller.pending).toBe(false);
    f.before(async () => true);
    expect(await f.controller.accept('new')).toBe('forwarded');
    expect(f.writes).toEqual(['new']);
    f.controller.dispose();
  });

  it('does not create a protocol callback rejection on write failure', async () => {
    const f = fixture();
    f.write(() => { throw new Error('synthetic'); });
    expect(await f.controller.accept(REPLY)).toBe('failed');
    expect(f.stats().cancellations).toBe(0);
    f.controller.dispose();
  });

  it('supports default clock/timer and optional observers without opening a service', async () => {
    const writes: string[] = [];
    const controller = new WebTerminalInputController({
      capture: () => 1, isCurrent: () => true, beforeUserInput: async () => true,
      write: (_target, data) => { writes.push(data); },
    });
    expect(await controller.accept(REPLY)).toBe('forwarded');
    expect(await controller.accept('user')).toBe('forwarded');
    expect(await controller.accept('')).toBe('forwarded');
    await controller.accept('\x1b');
    controller.dispose();
    expect(writes).toEqual([REPLY, 'user']);
  });

  it('rejects invalid backlog limits and incomplete timer injection', () => {
    const deps = { capture: () => 1, isCurrent: () => true, write: () => true, beforeUserInput: async () => true };
    for (const options of [{ maxUserBytes: 0 }, { maxUserMessages: 0 }, { maxUserBytes: Infinity }]) {
      expect(() => new WebTerminalInputController(deps, options)).toThrow();
    }
    expect(() => new WebTerminalInputController({ ...deps, setTimer: () => ({}) })).toThrow();
  });
});

describe('WebTerminalInputWireState', () => {
  it.each(['written', 'accepted'] as const)(
    'expires an old Escape before a delayed continuation on the %s wire',
    async operation => {
      let now = 1000;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const wire = new WebTerminalInputWireState(), owner = Symbol('writer');
      const parser = operation === 'written' ? wire.writer : wire.acceptedWriter;
      try {
        recordWireInput(wire, operation, '\x1b', owner);
        expect(parser.pending).toBe(true);
        now += 100;
        recordWireInput(wire, operation, '[200~', owner);
        // A tail arriving after expiry cannot turn the old Escape into paste.
        expect(parser.pending).toBe(false);
        expect(wire.inPaste).toBe(false);
        expect(wire.owner).toBeUndefined();
        expect(await wire.waitForPasteEnd()).toBe(true);
        now++;
        recordWireInput(wire, operation, '\x1b[200~fresh', owner);
        expect(parser.inPaste).toBe(true);
        now++;
        recordWireInput(wire, operation, '\x1b[201~', owner);
        expect(wire.inPaste).toBe(false);
        expect(wire.dirty).toBe(false);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each((['written', 'accepted'] as const).flatMap(operation => [
    { timing: 'immediate', arrival: 1 },
    { timing: 'delayed', arrival: 100 },
  ].flatMap(timing => [
    { pasteName: 'ESC CSI', start: '\x1b[200~', end: '\x1b[201~' },
    { pasteName: 'C1 CSI', start: '\x9b200~', end: '\x9b201~' },
  ].map(paste => ({ operation, ...timing, ...paste })))))(
    'tracks an Escape followed by a new paste on the $operation wire ($timing, $pasteName)',
    async ({ operation, arrival, start, end }) => {
      let now = 0;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const wire = new WebTerminalInputWireState(), owner = Symbol('writer');
      const parser = operation === 'written' ? wire.writer : wire.acceptedWriter;
      try {
        recordWireInput(wire, operation, '\x1b', owner);
        expect(parser.pending).toBe(true);
        expect(parser.inPaste).toBe(false);
        now = arrival;
        recordWireInput(wire, operation, start, owner);
        expect(parser.inPaste).toBe(true);
        expect(wire.inPaste).toBe(true);
        expect(wire.owner).toBe(owner);
        expect(wire.dirty).toBe(false);

        let completed = false;
        const completion = wire.waitForPasteEnd().then(ok => { completed = true; return ok; });
        await drain();
        expect(completed).toBe(false);
        now++;
        recordWireInput(wire, operation, 'body\r\n' + end, owner);
        expect(await completion).toBe(true);
        expect(parser.pending).toBe(false);
        expect(wire.inPaste).toBe(false);
        expect(wire.owner).toBeUndefined();
        expect(wire.dirty).toBe(false);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each(['written', 'accepted'] as const)(
    'keeps a color reply split inside ST on the %s wire without creating paste ownership',
    operation => {
      let now = 0;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const wire = new WebTerminalInputWireState(), owner = Symbol('writer');
      const parser = operation === 'written' ? wire.writer : wire.acceptedWriter;
      try {
        recordWireInput(wire, operation, REPLY.slice(0, -1), owner);
        expect(parser.pending).toBe(true);
        expect(wire.inPaste).toBe(false);
        expect(wire.owner).toBeUndefined();
        now = 1;
        recordWireInput(wire, operation, '\\', owner);
        expect(parser.pending).toBe(false);
        expect(wire.inPaste).toBe(false);
        expect(wire.owner).toBeUndefined();
        expect(wire.dirty).toBe(false);
      } finally {
        clock.mockRestore();
      }
    },
  );
});
