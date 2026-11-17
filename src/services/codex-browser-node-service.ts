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
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private serial = 0;
  private closed = false;
  private readonly wire = createBrowserWireCodec();
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(
    private readonly root: string,
    private readonly runtime: () => Runtime,
    private readonly nodeCommand = 'node',
    private readonly requestTimeoutMs = DEFAULT_BROWSER_NODE_REQUEST_TIMEOUT_MS,
  ) {}

  async handleRpc(request: { method: string; params?: unknown }): Promise<unknown> {
    await this.start();
    return this.request('rpc', request);
  }

  async handleTurnEnded(event: unknown): Promise<void> {
    if (this.child) await this.request('turnEnded', event);
  }

  private start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Browser Node runtime is closed'));
    return this.starting ??= this.launch();
  }

  private async launch(): Promise<void> {
    const env = { ...process.env };
    delete env.BUN_BE_BUN;
    const source = BROWSER_NODE_WORKER_SOURCE.replace('__BOTMUX_BROWSER_CODEC__', createBrowserWireCodec.toString());
    const child = spawn(this.nodeCommand, ['--input-type=module', '--eval', source], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    child.stderr.on('data', () => {}); // Never forward credential-bearing SDK diagnostics.
    let ready!: () => void;
    let failed!: (e: Error) => void;
    const connected = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    const timer = setTimeout(() => failed(new Error('Browser Node runtime startup timed out')), 10_000);
    const stop = () => {
      const error = new Error('Browser Node runtime exited; verify Node.js 22+ and start a fresh browser connection');
      failed(error);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear();
    };
    child.once('error', stop);
    child.once('exit', stop);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { child.kill(); return; }
      let message: Json;
      try { message = this.wire.decode(JSON.parse(line)); } catch { child.kill(); return; }
      if (message.type === 'ready') ready();
      else if (message.type === 'result') {
        const p = this.pending.get(message.id);
        if (!p) return;
        this.pending.delete(message.id); clearTimeout(p.timer);
        typeof message.error === 'string' ? p.reject(new Error(message.error)) : p.resolve(message.value);
      } else if (message.type === 'callback') {
        void this.callback(message.method, message.params).then(
          value => this.send({ type: 'callback-result', id: message.id, value }),
          () => this.send({ type: 'callback-result', id: message.id, error: 'Browser runtime callback failed' }),
        ).catch(() => child.kill());
      }
    });
    try {
      await connected;
      await this.request('initialize', { modulePath: join(this.root, 'scripts/browser-service.mjs') });
    } catch (error) { child.kill(); throw error; }
    finally { clearTimeout(timer); }
  }

  private send(message: unknown): void {
    const line = JSON.stringify(this.wire.encode(message));
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('Browser runtime message is too large');
    if (!this.child || this.child.killed || !this.child.stdin.writable) throw new Error('Browser Node runtime is unavailable');
    this.child.stdin.write(line + '\n');
  }

  private request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Browser Node runtime is closed'));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error('Browser runtime request capacity exceeded'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Browser Node runtime request timed out')); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ type: 'request', id, method, params, meta: this.runtime().requestMeta }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error as Error); }
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
        const response = await r.fetch(params.url, {
          method: params.method, headers: params.headers,
          ...(params.body ? { body: Buffer.from(params.body, 'base64') } : {}),
          // Match the authenticated-fetch MCP transport's own 40s budget instead
          // of aborting calls that transport would still allow.
          signal: AbortSignal.timeout(40_000),
        });
        return { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body: Buffer.from(await response.arrayBuffer()).toString('base64') };
      }
      default: throw new Error('Unsupported browser runtime callback');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.child?.kill();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Browser Node runtime is closed')); }
    this.pending.clear();
  }
}
