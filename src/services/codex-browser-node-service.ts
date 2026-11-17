import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { BROWSER_NODE_WORKER_SOURCE } from './codex-browser-node-worker-source.js';

type Json = Record<string, any>;
type Runtime = Json & { fetch: typeof fetch };
const MAX_PENDING = 128;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
/**
 * Match the broker's outer TOOL_TIMEOUT_MS budget in codex-browser-broker.ts.
 * A shorter watchdog would cut off work the typed tool still advertises:
 * per-operation timeouts reach 60s and a Lark approval can run for 600s.
 * Liveness is still detected immediately when the child exits, so this only
 * bounds a child that stays alive without answering.
 */
export const DEFAULT_BROWSER_NODE_REQUEST_TIMEOUT_MS = 660_000;
/** Covers process spawn, the worker's ready handshake and the plugin's own
 *  dynamic import/initialization, all of which are one startup sequence. */
export const DEFAULT_BROWSER_NODE_STARTUP_TIMEOUT_MS = 10_000;
/** Grace period between SIGTERM and the forced SIGKILL when tearing a child down. */
export const DEFAULT_BROWSER_NODE_TERMINATE_GRACE_MS = 2_000;

interface PendingEntry {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One spawned child plus the state that belongs to it alone. A new launch
 *  gets a new context, so a late exit/error from a previous generation can
 *  never touch the next child's pending requests. */
interface LaunchContext {
  child: ChildProcessWithoutNullStreams;
  pending: Map<number, PendingEntry>;
  exited: Promise<void>;
  markExited: () => void;
}

// Encode objects as entries, so page-controlled keys cannot impersonate a wire
// tag. The browser service also returns byte arrays (for example screenshots).
export function createBrowserWireCodec() {
  function encode(v: any): any {
    if (v === undefined) return { t: 'u' };
    if (typeof v === 'bigint') return { t: 'b', v: String(v) };
    if (v instanceof Uint8Array) return { t: 'x', v: Buffer.from(v).toString('base64') };
    if (Array.isArray(v)) return { t: 'a', v: v.map(encode) };
    if (v && typeof v === 'object') return { t: 'o', v: Object.entries(v).map(([k, x]) => [k, encode(x)]) };
    if (typeof v === 'function' || typeof v === 'symbol') throw new Error('Unsupported browser wire value');
    return { t: 'v', v };
  }
  function decode(v: any): any {
    switch (v.t) {
      case 'u': return undefined;
      case 'b': return BigInt(v.v);
      case 'x': return new Uint8Array(Buffer.from(v.v, 'base64'));
      case 'a': return v.v.map(decode);
      case 'o': return Object.fromEntries(v.v.map(([k, x]: [string, any]) => [k, decode(x)]));
      case 'v': return v.v;
      default: throw new Error('Invalid browser wire value');
    }
  }
  return { encode, decode };
}

/** Only the service half of the existing plugin moves into a Node process.
 * The typed Botmux tool, caller identity, approvals and authenticated fetch stay
 * with the owning broker. No new browser control endpoint is exposed. */
export class CodexBrowserNodeService {
  private current?: LaunchContext;
  private starting?: Promise<void>;
  /** Shared teardown: every close() caller awaits the same reaping cycle, so a
   *  concurrent caller can never return while the child is still alive. */
  private closing?: Promise<void>;
  private serial = 0;
  private closed = false;
  private readonly wire = createBrowserWireCodec();
  constructor(
    private readonly root: string,
    private readonly runtime: () => Runtime,
    private readonly nodeCommand = 'node',
    private readonly requestTimeoutMs = DEFAULT_BROWSER_NODE_REQUEST_TIMEOUT_MS,
    private readonly startupTimeoutMs = DEFAULT_BROWSER_NODE_STARTUP_TIMEOUT_MS,
    private readonly terminateGraceMs = DEFAULT_BROWSER_NODE_TERMINATE_GRACE_MS,
  ) {}

  async handleRpc(request: { method: string; params?: unknown }): Promise<unknown> {
    await this.start();
    return this.request('rpc', request);
  }

  async handleTurnEnded(event: unknown): Promise<void> {
    if (this.current) await this.request('turnEnded', event);
  }

  private start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Browser Node runtime is closed'));
    const launch = this.starting ??= this.launch();
    // A failed launch must not be cached as the permanent state: allow the next
    // call to spawn a fresh child instead of replaying the same rejection.
    launch.catch(() => { if (this.starting === launch) this.starting = undefined; });
    return launch;
  }

  private async launch(): Promise<void> {
    const env = { ...process.env };
    delete env.BUN_BE_BUN;
    const source = BROWSER_NODE_WORKER_SOURCE.replace('__BOTMUX_BROWSER_CODEC__', createBrowserWireCodec.toString());
    const child = spawn(this.nodeCommand, ['--input-type=module', '--eval', source], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let markExited!: () => void;
    const exited = new Promise<void>(resolve => { markExited = resolve; });
    const ctx: LaunchContext = {
      child,
      pending: new Map<number, PendingEntry>(),
      exited,
      markExited,
    };
    this.current = ctx;
    child.stderr.on('data', () => {}); // Never forward credential-bearing SDK diagnostics.
    let ready!: () => void;
    let failStartup!: (e: Error) => void;
    const connected = new Promise<void>(resolve => { ready = resolve; });
    // Stays pending on success; the catch handler keeps a later exit-driven
    // reject from surfacing as an unhandled rejection.
    const startupFailure = new Promise<never>((_, reject) => { failStartup = reject; });
    startupFailure.catch(() => {});
    let contextFailed = false;
    const watchdog = setTimeout(
      () => failStartup(new Error(`Browser Node runtime is unavailable: startup timed out after ${this.startupTimeoutMs}ms`)),
      this.startupTimeoutMs,
    );
    const failContext = (error: Error): void => {
      // Generation isolation comes from the per-context pending map and
      // startupFailure: this closure can only settle this ctx's own state, so
      // it must still run after close() cleared `current`. A local flag makes
      // exit/error/watchdog idempotent without consulting the shared pointer.
      if (contextFailed) return;
      contextFailed = true;
      failStartup(error);
      for (const p of ctx.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      ctx.pending.clear();
    };
    const exitError = new Error('Browser Node runtime exited; verify Node.js 22+ and start a fresh browser connection');
    child.once('exit', () => { ctx.markExited(); failContext(exitError); });
    child.once('error', error => { ctx.markExited(); failContext(error instanceof Error ? error : new Error(String(error))); });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { child.kill(); return; }
      let message: Json;
      try { message = this.wire.decode(JSON.parse(line)); } catch { child.kill(); return; }
      if (message.type === 'ready') ready();
      else if (message.type === 'result') {
        const p = ctx.pending.get(message.id);
        if (!p) return;
        ctx.pending.delete(message.id); clearTimeout(p.timer);
        typeof message.error === 'string' ? p.reject(new Error(message.error)) : p.resolve(message.value);
      } else if (message.type === 'callback') {
        void this.callback(message.method, message.params).then(
          value => this.send(ctx, { type: 'callback-result', id: message.id, value }),
          () => this.send(ctx, { type: 'callback-result', id: message.id, error: 'Browser runtime callback failed' }),
        ).catch(() => child.kill());
      }
    });
    try {
      // One watchdog bounds the whole startup sequence, including the plugin's
      // dynamic import inside the initialize request; a hanging top-level await
      // must not fall through to the much larger per-request budget.
      await Promise.race([connected, startupFailure]);
      await Promise.race([
        this.request('initialize', { modulePath: join(this.root, 'scripts/browser-service.mjs') }),
        startupFailure,
      ]);
    } catch (error) {
      // Reap the failed generation fully (SIGTERM -> bounded grace -> SIGKILL)
      // before allowing a retry: the old child's exit is therefore already
      // consumed and cannot interfere with the next generation.
      await this.terminateContext(ctx);
      if (this.current === ctx) this.current = undefined;
      throw error;
    } finally { clearTimeout(watchdog); }
  }

  /** SIGTERM, wait for the actual exit, then SIGKILL after a bounded grace.
   *  The hard cap only covers an unreapable process (e.g. zombie); callers
   *  never wait indefinitely. Every backing timer is cleared once its race
   *  settles, so an early exit leaves no retained Timeout handle. */
  private async terminateContext(ctx: LaunchContext): Promise<void> {
    const { child } = ctx;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>(resolve => {
      graceTimer = setTimeout(resolve, this.terminateGraceMs);
    });
    await Promise.race([ctx.exited, grace]);
    clearTimeout(graceTimer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      const hardCap = new Promise<void>(resolve => {
        hardTimer = setTimeout(resolve, 5_000);
      });
      await Promise.race([ctx.exited, hardCap]);
      clearTimeout(hardTimer);
    }
  }

  private send(ctx: LaunchContext, message: unknown): void {
    const line = JSON.stringify(this.wire.encode(message));
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('Browser runtime message is too large');
    const { child } = ctx;
    if (child.killed || !child.stdin.writable) throw new Error('Browser Node runtime is unavailable');
    child.stdin.write(line + '\n');
  }

  private request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Browser Node runtime is closed'));
    const ctx = this.current;
    if (!ctx) return Promise.reject(new Error('Browser Node runtime is unavailable'));
    if (ctx.pending.size >= MAX_PENDING) return Promise.reject(new Error('Browser runtime request capacity exceeded'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ctx.pending.delete(id); reject(new Error('Browser Node runtime request timed out')); }, this.requestTimeoutMs);
      ctx.pending.set(id, { resolve, reject, timer });
      try { this.send(ctx, { type: 'request', id, method, params, meta: this.runtime().requestMeta }); }
      catch (error) { ctx.pending.delete(id); clearTimeout(timer); reject(error as Error); }
    });
  }

  private async callback(method: string, params: any): Promise<unknown> {
    const r = this.runtime();
    switch (method) {
      case 'config.read': return r.config.read(params);
      case 'config.readRequirements': return r.config.readRequirements();
      case 'config.readToml': return r.config.readToml(params);
      case 'config.writeToml': return r.config.writeToml(params.path, params.value);
      case 'createElicitation': return r.createElicitation(params);
      case 'fetch': {
        // No parent-side AbortSignal: the owner fetch (CodexBrowserAuthenticatedFetch)
        // starts its own per-call transport budget only after its serialized queue
        // releases. An outer timeout created here would include that queue wait and
        // abort calls the inner budget would still allow. The per-request watchdog
        // still bounds a fetch that never settles at all.
        const response = await r.fetch(params.url, {
          method: params.method, headers: params.headers,
          ...(params.body ? { body: Buffer.from(params.body, 'base64') } : {}),
        });
        return { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body: Buffer.from(await response.arrayBuffer()).toString('base64') };
      }
      default: throw new Error('Unsupported browser runtime callback');
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const ctx = this.current;
    this.current = undefined;
    this.starting = undefined;
    this.closing = (async () => {
      if (!ctx) return;
      // Settle this generation's own waiters immediately; its exit/error
      // handler can no longer reach them once `current` is cleared.
      const closedError = new Error('Browser Node runtime is closed');
      for (const p of ctx.pending.values()) { clearTimeout(p.timer); p.reject(closedError); }
      ctx.pending.clear();
      await this.terminateContext(ctx);
    })();
    return this.closing;
  }
}
