import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface OrcaRuntimeMetadata {
  runtimeId: string;
  authToken: string;
  transports: Array<{ kind: string; endpoint: string }>;
}

export class OrcaRpcError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface OrcaRuntime {
  call<T>(method: string, params?: unknown): Promise<T>;
}

export function orcaUserDataPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORCA_USER_DATA_PATH) return env.ORCA_USER_DATA_PATH;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'orca');
  if (process.platform === 'win32') {
    if (!env.APPDATA) throw new Error('APPDATA is required to locate the Orca runtime');
    return join(env.APPDATA, 'orca');
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'orca');
}

/** Uses Orca's authenticated local CLI transport; credentials never enter argv or logs. */
export class OrcaRuntimeClient implements OrcaRuntime {
  constructor(readonly userDataPath = orcaUserDataPath(), private readonly timeoutMs = 30_000) {}

  async call<T>(method: string, params: unknown = {}): Promise<T> {
    let metadata: OrcaRuntimeMetadata;
    try {
      metadata = JSON.parse(readFileSync(join(this.userDataPath, 'orca-runtime.json'), 'utf8'));
    } catch {
      throw new OrcaRpcError('runtime_unavailable', 'Start Orca on the Botmux execution host first');
    }
    const endpoint = metadata.transports?.find(t => t.kind === 'unix' || t.kind === 'named-pipe')?.endpoint;
    if (!endpoint || !metadata.authToken || !metadata.runtimeId) {
      throw new OrcaRpcError('runtime_unavailable', 'Orca runtime metadata is incomplete');
    }
    return requestOrca<T>({ metadata, endpoint, method, params, timeoutMs: this.timeoutMs });
  }
}

function requestOrca<T>(args: {
  metadata: OrcaRuntimeMetadata; endpoint: string; method: string; params: unknown; timeoutMs: number;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection(args.endpoint);
    let buffer = '';
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new OrcaRpcError('runtime_timeout', 'Orca request outcome is unknown')), args.timeoutMs);
    socket.setEncoding('utf8');
    socket.once('error', () => finish(new OrcaRpcError('runtime_unavailable', 'Cannot connect to Orca runtime')));
    socket.once('close', () => finish(new OrcaRpcError('runtime_unavailable', 'Orca closed the connection before replying')));
    socket.once('connect', () => socket.write(JSON.stringify({
      id, authToken: args.metadata.authToken, method: args.method, params: args.params,
    }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        finish(new OrcaRpcError('invalid_response', 'Orca response exceeds the size limit'));
        return;
      }
      let end: number;
      while (!settled && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let frame: any;
        try { frame = JSON.parse(line); } catch {
          finish(new OrcaRpcError('invalid_response', 'Orca returned invalid JSON'));
          return;
        }
        if (frame?._keepalive === true) continue;
        if (frame?.id !== id || (frame._meta?.runtimeId && frame._meta.runtimeId !== args.metadata.runtimeId)) {
          finish(new OrcaRpcError('invalid_response', 'Orca response identity changed'));
        } else if (frame.ok === true && 'result' in frame) {
          finish(undefined, frame.result);
        } else {
          finish(new OrcaRpcError(String(frame.error?.code || 'invalid_response'), String(frame.error?.message || 'Orca request failed')));
        }
      }
    });
  });
}
