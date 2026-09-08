/**
 * script host：在受限 `vm` context 里执行脚本，把 `ctx` 调用翻译成对 runner 的 RPC
 * （设计文档 §4.2、§5.2、§6.1、§10）。
 *
 * 这里没有任何持久化、没有任何进程管理；它只做三件事：
 *   1. 卫生：lint → 改写 default export → 在删掉宿主 API 与自唤醒内建的 context 里加载；
 *   2. 结构：显式 scope（ctx）、位置身份、组合器、生命周期硬错误；
 *   3. 翻译：`agent/signal/log/position` → `bridge`（进程内测试用假 bridge，入口用 IPC）。
 *
 * 任何硬错误一旦发生就是终局：运行时进入 fatal 状态，之后所有 ctx 调用都被拒绝，
 * 脚本自己 catch 不掉；结果以第一次硬错误为准。
 */
import vm from 'node:vm';
import { contentHash, parallelBranchScope, pipelineStageScope, positionIdentity } from './identity.js';
import { assertSchema, SchemaInvalidError } from './schema.js';
import { assertScriptLint, ScriptLintError, transformDefaultExport } from './script-lint.js';
import type { AgentSpec, Outcome, SignalSpec } from './types.js';

export type HardErrorCode =
  | 'lint_failed'
  | 'default_export_not_function'
  | 'script_threw'
  | 'invalid_spec'
  | 'schema_invalid'
  | 'concurrency_outside_combinator'
  | 'ctx_revoked'
  | 'unawaited_effect'
  | 'runner_rejected'
  | 'aborted';

export class ScriptHardError extends Error {
  constructor(readonly code: HardErrorCode, message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'ScriptHardError';
  }
}

export interface AgentCall {
  identity: string;
  scopePath: string;
  content: string;
  spec: AgentSpec;
}

export interface SignalCall {
  identity: string;
  scopePath: string;
  content: string;
  spec: SignalSpec;
}

export interface PositionCall {
  identity: string;
  scopePath: string;
  kind: 'parallel' | 'pipeline';
  size: number;
}

/** runner 侧（或测试假件）实现。拒绝时抛 `ScriptHardError`（或任意错误，按 runner_rejected 处理）。 */
export interface HostBridge {
  agent(call: AgentCall): Promise<Outcome>;
  signal(call: SignalCall): Promise<Outcome>;
  log(call: { scopePath: string; text: string }): Promise<void>;
  position(call: PositionCall): void;
}

export interface ScriptRunOptions {
  source: string;
  input: unknown;
  bridge: HostBridge;
  /** 触发时 cwd 的 realpath 与 exec 配置摘要：内容哈希的分量，由 runner 决定。 */
  cwd: string;
  execConfigDigest: string;
  /** 脚本在 vm 里的文件名（错误堆栈用）。 */
  filename?: string;
}

export type ScriptRunResult =
  | { kind: 'done'; value: unknown }
  | { kind: 'error'; code: HardErrorCode; message: string; stack?: string; detail?: unknown };

const REMOVED_GLOBALS = ['SharedArrayBuffer', 'Atomics', 'FinalizationRegistry', 'WeakRef'];

/** 只允许调用、其余一概不可见的 Proxy 工厂——在 context 内创建，原型链落在 context 的 realm。 */
const PROXY_FACTORY_SOURCE = `(function (target) {
  return new Proxy(target, {
    get() { return undefined; },
    has() { return false; },
    ownKeys() { return []; },
    getOwnPropertyDescriptor() { return undefined; },
    getPrototypeOf() { return null; },
    setPrototypeOf() { return false; },
    defineProperty() { return false; },
    set() { return false; },
    deleteProperty() { return false; },
    construct() { throw new TypeError('not a constructor'); },
  });
})`;

class Scope {
  seq = 0;
  revoked = false;
  /** 在途的副作用或组合器数；>0 时再来一个就是结构外并发。 */
  inflight = 0;

  constructor(readonly scopePath: string) {}

  nextPosition(): string {
    return positionIdentity(this.scopePath, this.seq++);
  }
}

function isOutcome(value: unknown): value is Outcome {
  return !!value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean' && typeof (value as { identity?: unknown }).identity === 'string';
}

function requireString(spec: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const v = spec[key];
  if (v === undefined) {
    if (required) throw new ScriptHardError('invalid_spec', `${key} is required`);
    return undefined;
  }
  if (typeof v !== 'string' || (required && v.length === 0)) throw new ScriptHardError('invalid_spec', `${key} must be a non-empty string`);
  return v;
}

function requireTimeout(spec: Record<string, unknown>): number | undefined {
  const v = spec.timeoutMs;
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new ScriptHardError('invalid_spec', 'timeoutMs must be a positive number');
  return v;
}

function normalizeAgentSpec(raw: unknown): AgentSpec {
  if (!raw || typeof raw !== 'object') throw new ScriptHardError('invalid_spec', 'agent(spec) needs an object');
  const spec = raw as Record<string, unknown>;
  const out: AgentSpec = { cli: requireString(spec, 'cli', true)!, prompt: requireString(spec, 'prompt', true)! };
  const session = requireString(spec, 'session', false);
  const model = requireString(spec, 'model', false);
  const cwd = requireString(spec, 'cwd', false);
  const timeoutMs = requireTimeout(spec);
  if (session !== undefined) out.session = session;
  if (model !== undefined) out.model = model;
  if (cwd !== undefined) out.cwd = cwd;
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  if (spec.schema !== undefined) {
    try {
      assertSchema(spec.schema);
    } catch (err) {
      if (err instanceof SchemaInvalidError) throw new ScriptHardError('schema_invalid', err.message, err.issues);
      throw err;
    }
    out.schema = JSON.parse(JSON.stringify(spec.schema)) as unknown;
  }
  return out;
}

function normalizeSignalSpec(raw: unknown): SignalSpec {
  if (!raw || typeof raw !== 'object') throw new ScriptHardError('invalid_spec', 'signal(spec) needs an object');
  const spec = raw as Record<string, unknown>;
  const prompt = requireString(spec, 'prompt', true)!;
  if (spec.schema === undefined) throw new ScriptHardError('invalid_spec', 'signal(spec) requires schema');
  try {
    assertSchema(spec.schema);
  } catch (err) {
    if (err instanceof SchemaInvalidError) throw new ScriptHardError('schema_invalid', err.message, err.issues);
    throw err;
  }
  const out: SignalSpec = { prompt, schema: JSON.parse(JSON.stringify(spec.schema)) as unknown };
  const timeoutMs = requireTimeout(spec);
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  return out;
}

export class ScriptRuntime {
  private readonly context: vm.Context;
  private readonly wrap: (fn: (...args: unknown[]) => unknown) => unknown;
  private readonly cloneIn: (json: string) => unknown;
  private fatal: ScriptHardError | null = null;
  private fatalResolve: ((err: ScriptHardError) => void) | null = null;
  private readonly fatalPromise: Promise<ScriptHardError>;

  constructor(private readonly opts: ScriptRunOptions) {
    const sandbox = Object.create(null) as Record<string, unknown>;
    this.context = vm.createContext(sandbox, { name: 'botmux-flow-script' });
    for (const name of REMOVED_GLOBALS) {
      vm.runInContext(`delete globalThis[${JSON.stringify(name)}]; void 0;`, this.context);
    }
    this.wrap = vm.runInContext(PROXY_FACTORY_SOURCE, this.context) as typeof this.wrap;
    this.cloneIn = vm.runInContext('JSON.parse', this.context) as typeof this.cloneIn;
    this.fatalPromise = new Promise<ScriptHardError>((resolve) => {
      this.fatalResolve = resolve;
    });
  }

  /** 把宿主值克隆成 context realm 的对象（卫生：脚本拿不到宿主 Object/Function）。 */
  private intoContext(value: unknown): unknown {
    if (value === undefined) return undefined;
    return this.cloneIn(JSON.stringify(value));
  }

  private raise(err: ScriptHardError): never {
    if (!this.fatal) {
      this.fatal = err;
      this.fatalResolve?.(err);
    }
    throw err;
  }

  private guard(scope: Scope, what: string): void {
    if (this.fatal) throw this.fatal;
    if (scope.revoked) this.raise(new ScriptHardError('ctx_revoked', `${what} called on a revoked ctx (scope ${JSON.stringify(scope.scopePath)}); branch ctx must not escape its thunk`));
    if (scope.inflight > 0) {
      this.raise(new ScriptHardError('concurrency_outside_combinator', `${what} called while another effect is in flight on the same ctx (scope ${JSON.stringify(scope.scopePath)}); use parallel() or pipeline()`));
    }
  }

  private async effect<T>(scope: Scope, what: string, run: (identity: string) => Promise<T>): Promise<T> {
    this.guard(scope, what);
    const identity = scope.nextPosition();
    scope.inflight++;
    try {
      return await run(identity);
    } finally {
      scope.inflight--;
    }
  }

  private makeCtx(scope: Scope): unknown {
    const bridge = this.opts.bridge;
    const wrapOutcome = async (p: Promise<Outcome>): Promise<unknown> => {
      let outcome: Outcome;
      try {
        outcome = await p;
      } catch (err) {
        if (err instanceof ScriptHardError) this.raise(err);
        this.raise(new ScriptHardError('runner_rejected', err instanceof Error ? err.message : String(err)));
      }
      return this.intoContext(outcome);
    };

    const agent = (raw: unknown) =>
      this.effect(scope, 'agent', async (identity) => {
        const spec = normalizeAgentSpec(raw);
        const content = contentHash({
          kind: 'agent',
          cli: spec.cli,
          model: spec.model,
          cwd: spec.cwd ?? this.opts.cwd,
          execConfigDigest: this.opts.execConfigDigest,
          prompt: spec.prompt,
          schema: spec.schema,
        });
        return wrapOutcome(bridge.agent({ identity, scopePath: scope.scopePath, content, spec }));
      });

    const signal = (raw: unknown) =>
      this.effect(scope, 'signal', async (identity) => {
        const spec = normalizeSignalSpec(raw);
        const content = contentHash({ kind: 'signal', prompt: spec.prompt, schema: spec.schema, execConfigDigest: this.opts.execConfigDigest });
        return wrapOutcome(bridge.signal({ identity, scopePath: scope.scopePath, content, spec }));
      });

    const log = async (text: unknown): Promise<void> => {
      if (this.fatal) throw this.fatal;
      if (scope.revoked) this.raise(new ScriptHardError('ctx_revoked', 'log called on a revoked ctx'));
      if (typeof text !== 'string') this.raise(new ScriptHardError('invalid_spec', 'log(text) needs a string'));
      try {
        await bridge.log({ scopePath: scope.scopePath, text });
      } catch (err) {
        if (err instanceof ScriptHardError) this.raise(err);
        this.raise(new ScriptHardError('runner_rejected', err instanceof Error ? err.message : String(err)));
      }
    };

    const parallel = (thunks: unknown) =>
      this.effect(scope, 'parallel', async (position) => {
        if (!Array.isArray(thunks) || thunks.some((t) => typeof t !== 'function')) {
          this.raise(new ScriptHardError('invalid_spec', 'parallel(thunks) needs an array of functions (branchCtx) => …'));
        }
        bridge.position({ identity: position, scopePath: scope.scopePath, kind: 'parallel', size: thunks.length });
        const results = await Promise.all(
          (thunks as Array<(c: unknown) => unknown>).map((thunk, i) => this.runBranch(parallelBranchScope(position, i), (c) => thunk(c))),
        );
        return this.intoContext(results.map((r) => this.normalizeOutcome(r)));
      });

    const pipeline = (items: unknown, ...stages: unknown[]) =>
      this.effect(scope, 'pipeline', async (position) => {
        if (!Array.isArray(items)) this.raise(new ScriptHardError('invalid_spec', 'pipeline(items, ...stages) needs an array of items'));
        if (stages.length === 0 || stages.some((s) => typeof s !== 'function')) {
          this.raise(new ScriptHardError('invalid_spec', 'pipeline(items, ...stages) needs at least one stage function (value, item, branchCtx) => …'));
        }
        bridge.position({ identity: position, scopePath: scope.scopePath, kind: 'pipeline', size: (items as unknown[]).length });
        const results = await Promise.all(
          (items as unknown[]).map(async (item, i) => {
            let value: unknown = item;
            let last: unknown = item;
            for (let s = 0; s < stages.length; s++) {
              const stage = stages[s] as (value: unknown, item: unknown, c: unknown) => unknown;
              const r = await this.runBranch(pipelineStageScope(position, i, s), (c) => stage(value, item, c));
              last = r;
              if (isOutcome(r)) {
                if (!r.ok) break; // 短路
                value = r.value;
              } else {
                value = r;
              }
            }
            return this.normalizeOutcome(last);
          }),
        );
        return this.intoContext(results);
      });

    const ctx = vm.runInContext('({})', this.context) as Record<string, unknown>;
    ctx.input = this.intoContext(this.opts.input);
    ctx.agent = this.wrap(agent as (...args: unknown[]) => unknown);
    ctx.signal = this.wrap(signal as (...args: unknown[]) => unknown);
    ctx.log = this.wrap(log as (...args: unknown[]) => unknown);
    ctx.parallel = this.wrap(parallel as (...args: unknown[]) => unknown);
    ctx.pipeline = this.wrap(pipeline as (...args: unknown[]) => unknown);
    Object.freeze(ctx);
    return ctx;
  }

  /** 跑一个分支 thunk：新 scope → 调用 → 结算时撤销并检查未等待的副作用。 */
  private async runBranch(scopePath: string, call: (ctx: unknown) => unknown): Promise<unknown> {
    const scope = new Scope(scopePath);
    const ctx = this.makeCtx(scope);
    let result: unknown;
    try {
      result = await call(ctx);
    } catch (err) {
      scope.revoked = true;
      throw err;
    }
    scope.revoked = true;
    if (scope.inflight > 0) {
      this.raise(new ScriptHardError('unawaited_effect', `branch ${JSON.stringify(scopePath)} returned with ${scope.inflight} effect(s) still in flight; await every ctx call before returning`));
    }
    return result;
  }

  private normalizeOutcome(value: unknown): Outcome {
    if (isOutcome(value)) return value;
    return { ok: true, value, identity: '', attempt: 0, evidence: { source: 'none' } };
  }

  async run(): Promise<ScriptRunResult> {
    try {
      assertScriptLint(this.opts.source);
    } catch (err) {
      if (err instanceof ScriptLintError) return { kind: 'error', code: 'lint_failed', message: err.message, detail: err.issues };
      throw err;
    }
    const holder = vm.runInContext('({})', this.context) as { main?: unknown };
    (this.context as Record<string, unknown>).__botmux_flow = holder;
    const transformed = transformDefaultExport(this.opts.source, '__botmux_flow.main');
    try {
      vm.runInContext(transformed, this.context, { filename: this.opts.filename ?? 'flow-script.mjs' });
    } catch (err) {
      return errorResult('script_threw', err);
    } finally {
      delete (this.context as Record<string, unknown>).__botmux_flow;
    }
    if (typeof holder.main !== 'function') {
      return { kind: 'error', code: 'default_export_not_function', message: `default export is ${typeof holder.main}, expected a function (ctx) => …` };
    }

    const root = new Scope('');
    const ctx = this.makeCtx(root);
    const scriptPromise = (async () => {
      const value = await (holder.main as (c: unknown) => unknown)(ctx);
      root.revoked = true;
      if (root.inflight > 0) {
        this.raise(new ScriptHardError('unawaited_effect', `script returned with ${root.inflight} effect(s) still in flight on the root ctx`));
      }
      return value;
    })();

    // 硬错误一旦发生就以它为准，不等脚本自己怎么收场（它可能 catch 掉再继续）。
    const outcome = await Promise.race([
      scriptPromise.then((value) => ({ kind: 'done' as const, value }), (err: unknown) => ({ kind: 'threw' as const, err })),
      this.fatalPromise.then((err) => ({ kind: 'fatal' as const, err })),
    ]);
    // 让脚本的拒绝不变成 unhandledRejection
    scriptPromise.catch(() => {});

    if (outcome.kind === 'fatal') return errorResult(outcome.err.code, outcome.err, outcome.err.detail);
    if (outcome.kind === 'threw') {
      if (outcome.err instanceof ScriptHardError) return errorResult(outcome.err.code, outcome.err, outcome.err.detail);
      return errorResult('script_threw', outcome.err);
    }
    if (this.fatal) return errorResult(this.fatal.code, this.fatal, this.fatal.detail);
    // 返回值必须能过 JSON（journal 与 --check-replay 都按 JSON 比较）
    try {
      return { kind: 'done', value: outcome.value === undefined ? null : JSON.parse(JSON.stringify(outcome.value)) };
    } catch (err) {
      return errorResult('script_threw', new Error(`script return value is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /** runner 要求中止：之后所有 ctx 调用拒绝。 */
  abort(reason: string): void {
    if (!this.fatal) {
      this.fatal = new ScriptHardError('aborted', reason);
      this.fatalResolve?.(this.fatal);
    }
  }
}

/** vm context 里抛出的 Error 不是宿主 realm 的 `Error` 实例，按形状取 message/stack。 */
function errorResult(code: HardErrorCode, err: unknown, detail?: unknown): ScriptRunResult {
  const shaped = err && typeof err === 'object' ? (err as { message?: unknown; stack?: unknown }) : null;
  const message = shaped && typeof shaped.message === 'string' ? shaped.message : String(err);
  const stack = shaped && typeof shaped.stack === 'string' ? shaped.stack : undefined;
  return { kind: 'error', code, message, ...(stack ? { stack } : {}), ...(detail !== undefined ? { detail } : {}) };
}

export async function runScript(opts: ScriptRunOptions): Promise<ScriptRunResult> {
  return new ScriptRuntime(opts).run();
}
