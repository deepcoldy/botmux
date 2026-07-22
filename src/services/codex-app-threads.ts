import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveCommand } from '../adapters/cli/registry.js';

type JsonObject = Record<string, any>;

interface PendingRequest {
  method: string;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export interface CodexAppThreadSummary {
  threadId: string;
  name?: string;
  preview: string;
  cwd: string;
  updatedAtMs?: number;
  createdAtMs?: number;
  path?: string;
  source?: string;
  status?: string;
}

export interface ListCodexAppThreadsOptions {
  codexBin?: string;
  cwd?: string;
  limit?: number;
  searchTerm?: string;
  timeoutMs?: number;
}

export interface SetCodexAppThreadNameOptions {
  threadId: string;
  name: string;
  codexBin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  detached?: boolean;
  waitForExistingName?: boolean;
  waitForUpdatedAfter?: number;
  registerForceClose?: (forceClose: () => void) => (() => void);
}

export interface ReadCodexAppThreadMetadataOptions {
  threadId: string;
  codexBin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  detached?: boolean;
  registerForceClose?: (forceClose: () => void) => (() => void);
}

export interface CodexAppThreadMetadata {
  name?: string;
  updatedAt?: number;
}

class CodexAppServerProbe {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdoutBuffer = '';
  private pending = new Map<number, PendingRequest>();
  private lastStderr = '';
  private closed = false;
  private killTimer: NodeJS.Timeout | undefined;
  private abortSignal: AbortSignal | undefined;
  private abortHandler: (() => void) | undefined;
  private useProcessGroup: boolean;
  private unregisterForceClose: (() => void) | undefined;

  constructor(
    codexBin: string,
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
    signal?: AbortSignal,
    detached = false,
    registerForceClose?: (forceClose: () => void) => (() => void),
  ) {
    this.useProcessGroup = detached && process.platform !== 'win32';
    this.child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: this.useProcessGroup,
    });
    this.unregisterForceClose = registerForceClose?.(() => this.forceClose());
    this.child.stdout.on('data', chunk => this.onStdout(chunk.toString('utf8')));
    this.child.stderr.on('data', chunk => {
      this.lastStderr = (this.lastStderr + chunk.toString('utf8')).slice(-8000);
    });
    this.child.on('error', err => {
      this.closed = true;
      this.detachAbortHandler();
      this.unregisterForceClose?.();
      this.unregisterForceClose = undefined;
      this.failAll(new Error(`Failed to start Codex app-server: ${err.message}`));
    });
    this.child.on('exit', (code, signal) => {
      if (this.killTimer) clearTimeout(this.killTimer);
      this.detachAbortHandler();
      this.unregisterForceClose?.();
      this.unregisterForceClose = undefined;
      this.closed = true;
      this.failAll(new Error(`Codex app-server exited (code=${code}, signal=${signal})${this.lastStderr ? `\n${this.lastStderr}` : ''}`));
    });
    if (signal) {
      this.abortSignal = signal;
      this.abortHandler = () => this.close();
      if (signal.aborted) this.close();
      else signal.addEventListener('abort', this.abortHandler, { once: true });
    }
  }

  async initialize(timeoutMs: number): Promise<void> {
    await this.withTimeout(this.request('initialize', {
      clientInfo: { name: 'botmux-codex-app-thread-picker', version: '0.0.0' },
      capabilities: {
        experimentalApi: true,
        suppressNotifications: ['thread/started', 'thread/status/changed'],
      },
    }), timeoutMs, 'initialize');
    this.notify('initialized');
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'));
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const msg: JsonObject = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  async waitForThreadName(threadId: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.closed) throw new Error('Codex app-server is closed');
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Codex app-server thread name was not ready after ${timeoutMs}ms`);
      }
      const { name } = await this.readThreadMetadata(threadId, Math.min(remaining, 2000));
      if (name) return name;
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
  }

  async waitForThreadUpdatedAfter(threadId: string, baseline: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const { updatedAt } = await this.readThreadMetadata(threadId, Math.min(remaining, 2000));
      if (updatedAt !== undefined && updatedAt > baseline) return;
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
  }

  async readThreadMetadata(threadId: string, timeoutMs: number): Promise<CodexAppThreadMetadata> {
    const result = await this.withTimeout(this.request('thread/read', {
      threadId,
      includeTurns: false,
    }), timeoutMs, 'thread/read');
    const name = typeof result?.thread?.name === 'string' ? result.thread.name.trim() : '';
    const updatedAt = typeof result?.thread?.updatedAt === 'number' ? result.thread.updatedAt : undefined;
    return {
      ...(name ? { name } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachAbortHandler();
    this.killChildGroup('SIGTERM');
    this.killTimer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.forceClose();
      }
    }, 2000);
    this.killTimer.unref?.();
    this.failAll(new Error('Codex app-server probe closed'));
  }

  forceClose(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    this.closed = true;
    this.detachAbortHandler();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.killChildGroup('SIGKILL');
    }
    this.failAll(new Error('Codex app-server probe force-closed'));
  }

  async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Codex app-server ${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private onStdout(data: string): void {
    this.stdoutBuffer += data;
    for (;;) {
      const nl = this.stdoutBuffer.indexOf('\n');
      if (nl < 0) return;
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonObject;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`${pending.method}: ${JSON.stringify(msg.error)}`));
        else pending.resolve(msg.result);
      }
    }
  }

  private failAll(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  private detachAbortHandler(): void {
    if (this.abortSignal && this.abortHandler) {
      this.abortSignal.removeEventListener('abort', this.abortHandler);
    }
    this.abortSignal = undefined;
    this.abortHandler = undefined;
  }

  private killChildGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid && this.useProcessGroup) {
      try {
        process.kill(-pid, signal);
        return;
      } catch { /* fall back to the direct child */ }
    }
    try { this.child.kill(signal); } catch { /* already gone */ }
  }
}

function stringifyStatus(status: unknown): string | undefined {
  if (!status) return undefined;
  if (typeof status === 'string') return status;
  if (typeof status === 'object' && typeof (status as any).type === 'string') return (status as any).type;
  return undefined;
}

function normalizeThread(raw: JsonObject): CodexAppThreadSummary | null {
  const threadId = typeof raw.id === 'string' ? raw.id : undefined;
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : undefined;
  if (!threadId || !cwd) return null;

  const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : undefined;
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : undefined;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined;
  const preview = typeof raw.preview === 'string' ? raw.preview.trim() : '';
  const source = typeof raw.source === 'string' ? raw.source : undefined;

  return {
    threadId,
    name,
    preview,
    cwd,
    updatedAtMs: updatedAt !== undefined ? updatedAt * 1000 : undefined,
    createdAtMs: createdAt !== undefined ? createdAt * 1000 : undefined,
    path: typeof raw.path === 'string' ? raw.path : undefined,
    source,
    status: stringifyStatus(raw.status),
  };
}

export async function listCodexAppThreads(opts: ListCodexAppThreadsOptions = {}): Promise<CodexAppThreadSummary[]> {
  const timeoutMs = opts.timeoutMs ?? 7000;
  const codexBin = resolveCommand(opts.codexBin ?? 'codex');
  const cwd = opts.cwd ?? process.cwd();
  const client = new CodexAppServerProbe(codexBin, cwd);
  try {
    await client.initialize(timeoutMs);
    const result = await client.withTimeout(client.request('thread/list', {
      limit: opts.limit ?? 30,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
      useStateDbOnly: true,
      searchTerm: opts.searchTerm && opts.searchTerm.trim() ? opts.searchTerm.trim() : null,
    }), timeoutMs, 'thread/list');
    const rows: JsonObject[] = Array.isArray(result?.data) ? result.data : [];
    const normalized: Array<CodexAppThreadSummary | null> = rows.map((row: JsonObject) => normalizeThread(row));
    return normalized.filter((thread): thread is CodexAppThreadSummary => !!thread);
  } finally {
    client.close();
  }
}

/** 在 Codex 首条消息元数据落盘后，通过原生接口设置最终会话标题。 */
export async function setCodexAppThreadName(opts: SetCodexAppThreadNameOptions): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 7000;
  const codexBin = resolveCommand(opts.codexBin ?? 'codex');
  const cwd = opts.cwd ?? process.cwd();
  const client = new CodexAppServerProbe(
    codexBin,
    cwd,
    opts.env,
    opts.signal,
    opts.detached,
    opts.registerForceClose,
  );
  try {
    await client.initialize(timeoutMs);
    if (opts.waitForExistingName) {
      await client.waitForThreadName(opts.threadId, timeoutMs);
    }
    if (opts.waitForUpdatedAfter !== undefined) {
      await client.waitForThreadUpdatedAfter(opts.threadId, opts.waitForUpdatedAfter, timeoutMs);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await client.withTimeout(client.request('thread/name/set', {
        threadId: opts.threadId,
        name: opts.name,
      }), timeoutMs, 'thread/name/set');
      const metadata = await client.readThreadMetadata(opts.threadId, timeoutMs);
      if (metadata.name === opts.name) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('Codex app-server thread name did not persist after 3 attempts');
  } finally {
    client.close();
  }
}

/** 读取 resume 前的线程更新时间，用于等待下一次 append 的元数据补丁完成。 */
export async function readCodexAppThreadMetadata(
  opts: ReadCodexAppThreadMetadataOptions,
): Promise<CodexAppThreadMetadata> {
  const timeoutMs = opts.timeoutMs ?? 7000;
  const codexBin = resolveCommand(opts.codexBin ?? 'codex');
  const cwd = opts.cwd ?? process.cwd();
  const client = new CodexAppServerProbe(
    codexBin,
    cwd,
    opts.env,
    opts.signal,
    opts.detached,
    opts.registerForceClose,
  );
  try {
    await client.initialize(timeoutMs);
    return await client.readThreadMetadata(opts.threadId, timeoutMs);
  } finally {
    client.close();
  }
}
