/**
 * script host：受限 global、显式 scope 与位置身份、组合器、生命周期硬错误、IPC 胶水（§4.2、§5.2、§5.6、§10）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { spawnTsScript } from './helpers/ts-runner.js';
import { ScriptRuntime, runScript, type AgentCall, type HostBridge } from '../src/flow/script-host.js';
import { serveScriptHost, type ScriptTransport } from '../src/flow/script-ipc.js';
import type { Outcome, RunnerToScriptMessage, ScriptToRunnerMessage } from '../src/flow/types.js';

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((r) => child.once('exit', () => r()));
    }
  }
});

interface FakeBridgeOptions {
  /** 按 identity 决定 agent 结果；默认回显 prompt。 */
  respond?: (call: AgentCall) => Outcome | Promise<Outcome>;
  /** 结算顺序控制：返回一个在指定时机 resolve 的 promise。 */
  delay?: (call: AgentCall) => number;
}

function fakeBridge(opts: FakeBridgeOptions = {}) {
  const calls: AgentCall[] = [];
  const logs: string[] = [];
  const positions: Array<{ identity: string; kind: string; size: number }> = [];
  const bridge: HostBridge = {
    async agent(call) {
      calls.push(call);
      const delay = opts.delay?.(call) ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (opts.respond) return opts.respond(call);
      return { ok: true, value: { echo: call.spec.prompt }, identity: call.identity, attempt: 1, evidence: { source: 'contract_file' } };
    },
    async signal() {
      throw new Error('signal is not available in M1');
    },
    async log(call) {
      logs.push(call.text);
    },
    position(call) {
      positions.push({ identity: call.identity, kind: call.kind, size: call.size });
    },
  };
  return { bridge, calls, logs, positions };
}

const run = (source: string, bridge: HostBridge, input: unknown = {}) =>
  runScript({ source, input, bridge, cwd: '/work', execConfigDigest: 'digest' });

describe('位置身份与组合器', () => {
  it('slogan 形态：parallel 分支各自 scope，顶层顺序副作用按 seq 编号，input 可读', async () => {
    const fb = fakeBridge();
    const res = await run(`
      export default async function (ctx) {
        const { input, parallel, agent, log } = ctx;
        await log('start ' + input.topic);
        const drafts = await parallel(['warm', 'bold'].map((tone) => (c) =>
          c.agent({ cli: 'claude-code', prompt: tone + ' ' + input.topic })));
        const review = await agent({ cli: 'codex', prompt: 'review ' + drafts.map((d) => d.value.echo).join('|') });
        return { drafts: drafts.map((d) => d.value.echo), review: review.value.echo, ids: drafts.map((d) => d.identity) };
      }
    `, fb.bridge, { topic: 'tea' });
    expect(res).toEqual({
      kind: 'done',
      value: { drafts: ['warm tea', 'bold tea'], review: 'review warm tea|bold tea', ids: ['#0/par:0#0', '#0/par:1#0'] },
    });
    expect(fb.calls.map((c) => c.identity)).toEqual(['#0/par:0#0', '#0/par:1#0', '#1']);
    expect(fb.positions).toEqual([{ identity: '#0', kind: 'parallel', size: 2 }]);
    expect(fb.logs).toEqual(['start tea']);
    // log 不占位置：parallel 仍是 #0
    const c0 = fb.calls[0]!;
    expect(c0.content).toMatch(/^[0-9a-f]{64}$/);
    expect(c0.scopePath).toBe('#0/par:0');
  });

  it('流水线相同 prompt 的两个 stage 身份不同；ok:false 短路；普通值解包继续', async () => {
    const fb = fakeBridge({
      respond: (call) =>
        call.identity === '#0/pipe:1:0#0'
          ? { ok: false, identity: call.identity, attempt: 1, evidence: {}, error: 'boom', category: 'crashed', retry: 'auto', effects: 'none' }
          : { ok: true, value: call.spec.prompt.toUpperCase(), identity: call.identity, attempt: 1, evidence: {} },
    });
    const res = await run(`
      export default async (ctx) => ctx.pipeline(['a', 'b'],
        (value, item, c) => c.agent({ cli: 'x', prompt: 'same ' + item }),
        (value, item, c) => c.agent({ cli: 'x', prompt: 'same ' + item }),
        (value) => value + '!',
      );
    `, fb.bridge);
    expect(res.kind).toBe('done');
    const value = (res as { value: Outcome[] }).value;
    expect(value[0]).toMatchObject({ ok: true, value: 'SAME A!' });
    expect(value[1]).toMatchObject({ ok: false, identity: '#0/pipe:1:0#0', error: 'boom' });
    expect(fb.calls.map((c) => c.identity)).toEqual(['#0/pipe:0:0#0', '#0/pipe:1:0#0', '#0/pipe:0:1#0']);
    // 两个 stage 的 content 相同（同 prompt）但 identity 不同：位置身份把它们分开
    expect(fb.calls[0]!.content).toBe(fb.calls[2]!.content);
    expect(fb.positions).toEqual([{ identity: '#0', kind: 'pipeline', size: 2 }]);
  });

  it('遵守约束的脚本：结算顺序不同，返回值相同（分支只靠返回值汇总）', async () => {
    const script = `
      export default async (ctx) => {
        const outs = await ctx.parallel([1, 2, 3].map((n) => (c) => c.agent({ cli: 'x', prompt: 'n' + n })));
        return outs.map((o) => o.value.echo);
      }
    `;
    const forward = fakeBridge({ delay: (c) => (c.identity.endsWith('par:0#0') ? 1 : 30) });
    const reverse = fakeBridge({ delay: (c) => (c.identity.endsWith('par:0#0') ? 30 : 1) });
    const a = await run(script, forward.bridge);
    const b = await run(script, reverse.bridge);
    expect(a).toEqual(b);
    expect(a).toEqual({ kind: 'done', value: ['n1', 'n2', 'n3'] });
  });

  it('违反约束的 ++rank 共享状态：身份不变，返回值随结算顺序变化（--check-replay 的检出对象）', async () => {
    const script = `
      export default async (ctx) => {
        let rank = 0;
        const outs = await ctx.parallel(['a', 'b'].map((p) => async (c) => {
          const o = await c.agent({ cli: 'x', prompt: p });
          return { ...o, value: { rank: ++rank } };
        }));
        return outs.map((o) => o.value.rank);
      }
    `;
    const forward = fakeBridge({ delay: (c) => (c.identity.endsWith('par:0#0') ? 1 : 30) });
    const reverse = fakeBridge({ delay: (c) => (c.identity.endsWith('par:0#0') ? 30 : 1) });
    const a = await run(script, forward.bridge);
    const b = await run(script, reverse.bridge);
    expect(a).toEqual({ kind: 'done', value: [1, 2] });
    expect(b).toEqual({ kind: 'done', value: [2, 1] });
    expect(forward.calls.map((c) => c.identity)).toEqual(reverse.calls.map((c) => c.identity));
  });
});

describe('生命周期硬错误（首次执行即拒绝）', () => {
  it('裸 Promise.all 被 lint 拒绝，不触达 bridge', async () => {
    const fb = fakeBridge();
    const res = await run(`export default async (ctx) => Promise.all([ctx.agent({ cli: 'x', prompt: 'a' })]);`, fb.bridge);
    expect(res).toMatchObject({ kind: 'error', code: 'lint_failed' });
    expect(fb.calls).toEqual([]);
  });

  it('分支内误用根 ctx → concurrency_outside_combinator', async () => {
    const fb = fakeBridge();
    const res = await run(`
      export default async (ctx) => ctx.parallel([(c) => ctx.agent({ cli: 'x', prompt: 'root misuse' })]);
    `, fb.bridge);
    expect(res).toMatchObject({ kind: 'error', code: 'concurrency_outside_combinator' });
    expect(fb.calls).toEqual([]);
  });

  it('同一 ctx 上两个未 await 的副作用 → concurrency_outside_combinator，即使脚本 catch 也终局', async () => {
    const fb = fakeBridge({ delay: () => 20 });
    const res = await run(`
      export default async (ctx) => {
        const p = ctx.agent({ cli: 'x', prompt: 'first' });
        try { await ctx.agent({ cli: 'x', prompt: 'second' }); } catch (e) { /* swallowed */ }
        await p;
        return 'survived';
      }
    `, fb.bridge);
    expect(res).toMatchObject({ kind: 'error', code: 'concurrency_outside_combinator' });
    expect(fb.calls.map((c) => c.spec.prompt)).toEqual(['first']);
  });

  it('逃逸的分支 ctx → ctx_revoked', async () => {
    const fb = fakeBridge();
    const res = await run(`
      export default async (ctx) => {
        let leaked;
        await ctx.parallel([async (c) => { leaked = c; return 1; }]);
        return leaked.agent({ cli: 'x', prompt: 'after revoke' });
      }
    `, fb.bridge);
    expect(res).toMatchObject({ kind: 'error', code: 'ctx_revoked' });
    expect(fb.calls).toEqual([]);
  });

  it('未等待的副作用 → unawaited_effect（副作用已经发出，由 runner 取消）', async () => {
    const fb = fakeBridge({ delay: () => 30 });
    const res = await run(`
      export default async (ctx) => ctx.parallel([(c) => { c.agent({ cli: 'x', prompt: 'fire and forget' }); return 'left'; }]);
    `, fb.bridge);
    expect(res).toMatchObject({ kind: 'error', code: 'unawaited_effect' });
    expect(fb.calls).toHaveLength(1);
  });

  it('脚本返回时根 ctx 仍有在途副作用 → unawaited_effect', async () => {
    const fb = fakeBridge({ delay: () => 30 });
    const res = await run(`export default async (ctx) => { ctx.agent({ cli: 'x', prompt: 'p' }); return 1; }`, fb.bridge);
    expect(res).toMatchObject({ kind: 'error', code: 'unawaited_effect' });
  });

  it('非法 spec / 非法 schema / signal 在 M1 / 脚本异常 / default export 不是函数', async () => {
    const fb = fakeBridge();
    // `{ prompt }` 单独合法（bot 执行器：落到本 run 所属 bot）；cli / bot 给了就不能是空串
    expect(await run(`export default async (ctx) => ctx.agent({ cli: '', prompt: 'empty cli' });`, fb.bridge)).toMatchObject({ kind: 'error', code: 'invalid_spec' });
    expect(await run(`export default async (ctx) => ctx.agent({ bot: '', prompt: 'empty bot' });`, fb.bridge)).toMatchObject({ kind: 'error', code: 'invalid_spec' });
    expect(await run(`export default async (ctx) => ctx.agent({ cli: 'x' });`, fb.bridge)).toMatchObject({ kind: 'error', code: 'invalid_spec', message: /prompt/ });
    expect(await run(`export default async (ctx) => ctx.agent({ cli: 'x', prompt: 'p', schema: { type: 'string', pattern: 'a' } });`, fb.bridge)).toMatchObject({ kind: 'error', code: 'schema_invalid' });
    expect(await run(`export default async (ctx) => ctx.signal({ prompt: 'p', schema: { type: 'object' } });`, fb.bridge)).toMatchObject({ kind: 'error', code: 'runner_rejected', message: /M1/ });
    expect(await run(`export default async () => { throw new Error('my bug'); }`, fb.bridge)).toMatchObject({ kind: 'error', code: 'script_threw', message: 'my bug' });
    expect(await run(`export default 42;`, fb.bridge)).toMatchObject({ kind: 'error', code: 'default_export_not_function' });
    expect(await run(`export default async () => ({ f() {} });`, fb.bridge)).toEqual({ kind: 'done', value: {} });
    expect(fb.calls).toEqual([]);
  });

  it('bridge 拒绝（如 maxNotes）→ runner_rejected 终局', async () => {
    const fb = fakeBridge();
    fb.bridge.log = async () => { throw new Error('note limit exceeded'); };
    expect(await run(`export default async (ctx) => { try { await ctx.log('x'); } catch {} return 'kept going'; }`, fb.bridge))
      .toMatchObject({ kind: 'error', code: 'runner_rejected', message: 'note limit exceeded' });
  });

  it('abort 后所有 ctx 调用拒绝，结果为 aborted', async () => {
    const fb = fakeBridge({ delay: () => 200 });
    const runtime = new ScriptRuntime({ source: `export default async (ctx) => { await ctx.agent({ cli: 'x', prompt: 'slow' }); return 'no'; }`, input: {}, bridge: fb.bridge, cwd: '/', execConfigDigest: '' });
    const p = runtime.run();
    await new Promise((r) => setTimeout(r, 20));
    runtime.abort('operator cancel');
    expect(await p).toMatchObject({ kind: 'error', code: 'aborted', message: 'operator cancel' });
  });
});

describe('受限 global（卫生）', () => {
  it('脚本看不到宿主 API 与自唤醒内建；ctx 函数是只可调用的 Proxy', async () => {
    const fb = fakeBridge();
    const res = await run(`
      export default async (ctx) => ({
        keys: Object.keys(this),
        timer: typeof this.setTimeout,
        sab: typeof this.SharedArrayBuffer,
        atomics: typeof this.Atomics,
        weakref: typeof this.WeakRef,
        proc: typeof this.process,
        fetch: typeof this.fetch,
        promise: typeof Promise,
        ctor: typeof ctx.agent.constructor,
        proto: Object.getPrototypeOf(ctx.agent),
        frozen: Object.isFrozen(ctx),
        inputRealm: ctx.input.constructor === Object,
      });
    `, fb.bridge, { a: 1 });
    expect(res).toEqual({
      kind: 'done',
      value: { keys: [], timer: 'undefined', sab: 'undefined', atomics: 'undefined', weakref: 'undefined', proc: 'undefined', fetch: 'undefined', promise: 'function', ctor: 'undefined', proto: null, frozen: true, inputRealm: true },
    });
  });
});

describe('IPC 胶水（serveScriptHost）', () => {
  function pair() {
    const toRunner: ScriptToRunnerMessage[] = [];
    let handler: ((m: RunnerToScriptMessage) => void) | null = null;
    let disconnect: (() => void) | null = null;
    const waiters: Array<(m: ScriptToRunnerMessage) => void> = [];
    const transport: ScriptTransport = {
      send: (m) => {
        toRunner.push(m);
        for (const w of waiters.splice(0)) w(m);
      },
      onMessage: (h) => { handler = h; },
      onDisconnect: (h) => { disconnect = h; },
    };
    const next = () => new Promise<ScriptToRunnerMessage>((resolve) => waiters.push(resolve));
    return { transport, toRunner, next, deliver: (m: RunnerToScriptMessage) => handler!(m), disconnect: () => disconnect!() };
  }

  it('hello → start → call/reply → done', async () => {
    const p = pair();
    const session = serveScriptHost(p.transport, 4242);
    expect(p.toRunner[0]).toEqual({ t: 'hello', pid: 4242 });
    const callPromise = p.next();
    p.deliver({ t: 'start', source: `export default async (ctx) => (await ctx.agent({ cli: 'x', prompt: 'hi' })).value;`, input: null, cwd: '/', execConfigDigest: '', filename: 's.mjs' });
    const call = await callPromise;
    expect(call).toMatchObject({ t: 'call', op: 'agent', identity: '#0', scopePath: '', spec: { cli: 'x', prompt: 'hi' } });
    const donePromise = p.next();
    p.deliver({ t: 'reply', id: (call as { id: number }).id, result: { ok: true, value: 'replied', identity: '#0', attempt: 1, evidence: {} } });
    expect(await donePromise).toEqual({ t: 'done', value: 'replied' });
    expect(await session.finished).toBe('done');
  });

  it('reject 变成硬错误；abort 与 disconnect 结束会话', async () => {
    const p = pair();
    const session = serveScriptHost(p.transport);
    const callPromise = p.next();
    p.deliver({ t: 'start', source: `export default async (ctx) => { try { await ctx.log('x'); } catch {} return 1; }`, input: null, cwd: '/', execConfigDigest: '', filename: 's.mjs' });
    const call = await callPromise;
    const errPromise = p.next();
    p.deliver({ t: 'reject', id: (call as { id: number }).id, code: 'note_limit', message: 'too many notes' });
    expect(await errPromise).toMatchObject({ t: 'error', code: 'note_limit', message: 'too many notes' });
    expect(await session.finished).toBe('error');

    const q = pair();
    const s2 = serveScriptHost(q.transport);
    const c2 = q.next();
    q.deliver({ t: 'start', source: `export default async (ctx) => ctx.agent({ cli: 'x', prompt: 'never answered' });`, input: null, cwd: '/', execConfigDigest: '', filename: 's.mjs' });
    await c2;
    q.disconnect();
    expect(await s2.finished).toBe('aborted');
  });

  it('真实入口进程：带 IPC 启动 src/flow-script.ts，完成后退出 0', async () => {
    const child = spawnTsScript(join(process.cwd(), 'src', 'flow-script.ts'), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child);
    const messages: ScriptToRunnerMessage[] = [];
    const waitFor = (pred: (m: ScriptToRunnerMessage) => boolean) =>
      new Promise<ScriptToRunnerMessage>((resolve, reject) => {
        const found = messages.find(pred);
        if (found) return resolve(found);
        const onMsg = (m: unknown) => {
          if (pred(m as ScriptToRunnerMessage)) {
            child.off('message', onMsg);
            resolve(m as ScriptToRunnerMessage);
          }
        };
        child.on('message', onMsg);
        child.once('exit', (code) => reject(new Error(`exited ${code} before message`)));
      });
    child.on('message', (m) => messages.push(m as ScriptToRunnerMessage));
    let stderr = '';
    child.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });
    await waitFor((m) => m.t === 'hello');
    child.send({ t: 'start', source: `export default async (ctx) => { await ctx.log('from child'); return { pid: 'hidden', sum: 1 + 2 }; }`, input: null, cwd: '/', execConfigDigest: '', filename: 's.mjs' } satisfies RunnerToScriptMessage);
    const log = await waitFor((m) => m.t === 'call' && m.op === 'log');
    child.send({ t: 'reply', id: (log as { id: number }).id, result: undefined } satisfies RunnerToScriptMessage);
    const done = await waitFor((m) => m.t === 'done');
    expect(done).toEqual({ t: 'done', value: { pid: 'hidden', sum: 3 } });
    const code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
    expect(code, stderr).toBe(0);
  }, 30_000);
});
