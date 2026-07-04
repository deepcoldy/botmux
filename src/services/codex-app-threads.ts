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

class CodexAppServerProbe {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdoutBuffer = '';
  private pending = new Map<number, PendingRequest>();
  private lastStderr = '';
  private closed = false;

  constructor(codexBin: string, cwd: string) {
    this.child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', chunk => this.onStdout(chunk.toString('utf8')));
    this.child.stderr.on('data', chunk => {
      this.lastStderr = (this.lastStderr + chunk.toString('utf8')).slice(-8000);
    });
    this.child.on('error', err => this.failAll(new Error(`Failed to start Codex app-server: ${err.message}`)));
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`Codex app-server exited (code=${code}, signal=${signal})${this.lastStderr ? `\n${this.lastStderr}` : ''}`));
    });
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

  close(): void {
    this.closed = true;
    try { this.child.kill(); } catch { /* already gone */ }
    this.failAll(new Error('Codex app-server probe closed'));
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
