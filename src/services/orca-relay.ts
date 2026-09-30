import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { locateExecutable } from '../utils/executable.js';
import { resolveOrcaBinary } from './orca-cli.js';

const HEADER_BYTES = 13;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

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
export function queryOrcaRelayPtyMetadata(ids: readonly string[]): Promise<Map<string, OrcaRelayPtyMetadata>> {
  const config = relayConfig();
  if (!config || ids.length === 0) return Promise.resolve(new Map());
  const { socketPath, relayDir, credentialFile } = config;

  let version: string;
  let endpointCredential: string;
  try {
    version = readFileSync(`${relayDir}/.version`, 'utf-8').trim();
    endpointCredential = readFileSync(credentialFile, 'utf-8').trim();
  } catch {
    return Promise.resolve(new Map());
  }

  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    const finish = (value: Map<string, OrcaRelayPtyMetadata>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const sendFrame = (type: number, payload: unknown) => {
      const body = Buffer.from(JSON.stringify(payload));
      const header = Buffer.alloc(HEADER_BYTES);
      header[0] = type;
      header.writeUInt32BE(1, 1);
      header.writeUInt32BE(0, 5);
      header.writeUInt32BE(body.length, 9);
      socket.write(Buffer.concat([header, body]));
    };
    const timer = setTimeout(() => finish(new Map()), 3_000);
    timer.unref?.();
    socket.once('connect', () => sendFrame(2, {
      type: 'orca-relay-handshake',
      version,
      endpointCredential,
    }));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= HEADER_BYTES) {
        const type = buffer[0]!;
        const length = buffer.readUInt32BE(9);
        if (length > MAX_FRAME_BYTES) return finish(new Map());
        if (buffer.length < HEADER_BYTES + length) return;
        const payload = buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
        buffer = buffer.subarray(HEADER_BYTES + length);
        let message: any;
        try { message = JSON.parse(payload.toString('utf-8')); } catch { continue; }
        if (!handshaken) {
          if (type !== 2 || message?.type !== 'orca-relay-handshake-ok') return finish(new Map());
          handshaken = true;
          sendFrame(1, { jsonrpc: '2.0', id: 1, method: 'pty.serialize', params: { ids } });
          continue;
        }
        if (type !== 1 || message?.id !== 1) continue;
        if (message.error || typeof message.result !== 'string') return finish(new Map());
        try {
          const rows = JSON.parse(message.result) as SerializedPty[];
          return finish(new Map(rows.flatMap(row => (
            typeof row?.id === 'string' && Number.isInteger(row?.pid) && row.pid > 0
              ? [[row.id, {
                pid: row.pid,
                ...(Number.isInteger(row.cols) && row.cols! > 0 ? { cols: row.cols } : {}),
                ...(Number.isInteger(row.rows) && row.rows! > 0 ? { rows: row.rows } : {}),
              }] as const]
              : []
          ))));
        } catch {
          return finish(new Map());
        }
      }
    });
    socket.once('error', () => finish(new Map()));
    socket.once('close', () => finish(new Map()));
  });
}
