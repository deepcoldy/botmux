import { createConnection, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { locateExecutable } from '../utils/executable.js';
import { resolveOrcaBinary } from './orca-cli.js';

const MAX_BYTES = 16 * 1024 * 1024;

export interface OrcaRelayEndpoint { socketPath: string; version: string; credential: string }

interface SerializedPty {
  id: string;
  pid: number;
  cols?: number;
  rows?: number;
}
export interface OrcaRelayPtyMetadata {
  pid: number;
  cols?: number;
  rows?: number;
}

function relayConfig(): { socketPath: string; relayDir: string; credentialFile: string } | undefined {
  const fromEnv = {
    socketPath: process.env.ORCA_RELAY_SOCKET_PATH,
    relayDir: process.env.ORCA_RELAY_DIR,
    credentialFile: process.env.ORCA_RELAY_CREDENTIAL_FILE,
  };
  if (fromEnv.socketPath && fromEnv.relayDir && fromEnv.credentialFile) {
    return fromEnv as { socketPath: string; relayDir: string; credentialFile: string };
  }
  const resolved = resolveOrcaBinary();
  const executable = isAbsolute(resolved) ? resolved : locateExecutable(resolved);
  if (!executable) return undefined;
  let wrapper: string;
  try { wrapper = readFileSync(executable, 'utf-8').slice(0, 32_768); } catch { return undefined; }
  const defaultValue = (key: string): string | undefined => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return wrapper.match(new RegExp(`^${escaped}=\\$\\{${escaped}:-'([^'\\r\\n]+)'\\}$`, 'm'))?.[1];
  };
  const socketPath = fromEnv.socketPath ?? defaultValue('ORCA_RELAY_SOCKET_PATH');
  const relayDir = fromEnv.relayDir ?? defaultValue('ORCA_RELAY_DIR');
  const credentialFile = fromEnv.credentialFile ?? defaultValue('ORCA_RELAY_CREDENTIAL_FILE');
  if (!socketPath || !relayDir || !credentialFile) return undefined;
  if (![socketPath, relayDir, credentialFile].every(isAbsolute)) return undefined;
  return { socketPath, relayDir, credentialFile };
}

/** Read PTY root PIDs from the already-running Orca SSH relay. This is a
 * read-only authenticated side channel used only to bind local transcripts;
 * terminal discovery and control continue to use Orca's public CLI. */
export async function queryOrcaRelayPtyMetadata(ids: readonly string[]): Promise<Map<string, OrcaRelayPtyMetadata>> {
  const config = relayConfig();
  if (!config || ids.length === 0) return new Map();
  let client: OrcaRelayClient | undefined;
  try {
    const version = readFileSync(`${config.relayDir}/.version`, 'utf-8').trim();
    const credential = readFileSync(config.credentialFile, 'utf-8').trim();
    client = await OrcaRelayClient.open({ socketPath: config.socketPath, version, credential }, 3_000);
    const serialized = await client.request('pty.serialize', { ids });
    if (typeof serialized !== 'string') return new Map();
    const rows = JSON.parse(serialized) as SerializedPty[];
    if (!Array.isArray(rows)) return new Map();
    return new Map(rows.flatMap(row => (
      typeof row?.id === 'string' && Number.isInteger(row?.pid) && row.pid > 0
        ? [[row.id, {
          pid: row.pid,
          ...(Number.isInteger(row.cols) && row.cols! > 0 ? { cols: row.cols } : {}),
          ...(Number.isInteger(row.rows) && row.rows! > 0 ? { rows: row.rows } : {}),
        }] as const]
        : []
    )));
  } catch { return new Map(); }
  finally { client?.close(); }
}

export class OrcaRelayClient {
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private pending?: { id: number; resolve(value: unknown): void; reject(error: Error): void };
  private readonly socket: Socket;
  private readonly timer: ReturnType<typeof setTimeout>;
  private failure?: Error;

  private constructor(endpoint: OrcaRelayEndpoint, timeoutMs: number, ready: (client: OrcaRelayClient) => void, reject: (error: Error) => void) {
    this.socket = createConnection(endpoint.socketPath);
    this.timer = setTimeout(() => this.fail(new Error('Orca local relay connection timed out')), timeoutMs);
    let handshaken = false;
    this.socket.once('connect', () => this.send(2, {
      type: 'orca-relay-handshake', version: endpoint.version, endpointCredential: endpoint.credential,
    }));
    this.socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_BYTES) return this.fail(new Error('Orca relay response too large'));
      while (this.buffer.length >= 13) {
        const type = this.buffer[0];
        const bytes = this.buffer.readUInt32BE(9);
        if (bytes > MAX_BYTES) return this.fail(new Error('Orca relay frame too large'));
        if (this.buffer.length < 13 + bytes) return;
        const body = this.buffer.subarray(13, 13 + bytes);
        this.buffer = this.buffer.subarray(13 + bytes);
        if (type !== 1 && type !== 2) continue;
        let message: any;
        try { message = JSON.parse(body.toString('utf-8')); } catch { return this.fail(new Error('Invalid Orca relay response')); }
        if (!handshaken) {
          if (type !== 2 || message?.type !== 'orca-relay-handshake-ok') return this.fail(new Error('Orca relay handshake refused'));
          handshaken = true;
          ready(this);
          continue;
        }
        if (type !== 1 || !this.pending || message?.id !== this.pending.id) continue;
        const pending = this.pending!;
        this.pending = undefined;
        if (message.error) pending.reject(new Error(String(message.error.message ?? 'Orca relay request failed')));
        else if (!Object.hasOwn(message, 'result')) pending.reject(new Error('Invalid Orca relay result'));
        else pending.resolve(message.result);
      }
    });
    this.socket.once('error', error => this.fail(error));
    this.socket.once('close', () => { reject(this.failure ?? new Error('Orca relay socket closed')); this.fail(new Error('Orca relay socket closed')); });
  }

  static open(endpoint: OrcaRelayEndpoint, timeoutMs: number): Promise<OrcaRelayClient> {
    return new Promise((resolve, reject) => { new OrcaRelayClient(endpoint, timeoutMs, resolve, reject); });
  }

  private send(type: number, message: unknown): void {
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_BYTES) throw new Error('Orca relay request too large');
    const header = Buffer.alloc(13);
    header[0] = type;
    header.writeUInt32BE(body.length, 9);
    this.socket.write(Buffer.concat([header, body]));
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error('Orca relay request already pending'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending = { id, resolve, reject };
      this.send(1, { jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.failure) throw this.failure;
    this.send(1, { jsonrpc: '2.0', method, params });
  }

  close(): void { this.fail(new Error('Orca relay client closed')); }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.timer);
    this.pending?.reject(error);
    this.pending = undefined;
    this.socket.destroy();
  }
}
