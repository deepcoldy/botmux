import { createConnection } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** The orcad terminal daemon owns the PTYs of server-mode terminals and
 * outlives orcad restarts. It exposes per-session shell pid + geometry that
 * the orcad runtime RPC does not. This is a read-only side channel used only
 * to bind local transcripts and pane geometry; discovery and control keep
 * using the Orca CLI. */

export interface OrcaDaemonSessionMetadata {
  pid: number;
  cols?: number;
  rows?: number;
}

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

interface DaemonEndpoint {
  socketPath: string;
  version: number;
  token: string;
}

function findDaemonEndpoint(): DaemonEndpoint | undefined {
  const dir = process.env.ORCA_DAEMON_DIR || join(homedir(), '.orca', 'daemon');
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return undefined; }
  const versions = entries
    .flatMap((name) => {
      const match = /^daemon-v(\d+)\.sock$/.exec(name);
      return match ? [Number(match[1]!)] : [];
    })
    .sort((a, b) => b - a);
  for (const version of versions) {
    let token: string;
    try { token = readFileSync(join(dir, `daemon-v${version}.token`), 'utf-8').trim(); } catch { continue; }
    if (!token) continue;
    return { socketPath: join(dir, `daemon-v${version}.sock`), version, token };
  }
  return undefined;
}

interface DaemonListSessionsPayload {
  sessions?: Array<{
    terminalHandle?: string;
    pid?: number;
    cols?: number;
    rows?: number;
    isAlive?: boolean;
  }>;
}

/** Ask the terminal daemon for every live session it owns, keyed by terminal
 * handle (the same `term_<uuid>` the CLI reports). Any error, timeout, or
 * protocol mismatch fails closed to an empty map — callers degrade to
 * unverified geometry, exactly like cross-host relay targets.
 * shortcut: a stale higher-version daemon file (left after a failed orcad
 * upgrade) shadows the live lower version and we fail closed; escape with
 * ORCA_DAEMON_DIR if that ever bites. */
export function queryOrcaDaemonSessions(): Promise<Map<string, OrcaDaemonSessionMetadata>> {
  const endpoint = findDaemonEndpoint();
  if (!endpoint) return Promise.resolve(new Map());

  return new Promise((resolve) => {
    const socket = createConnection(endpoint.socketPath);
    let settled = false;
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    const finish = (value: Map<string, OrcaDaemonSessionMetadata>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const sendLine = (message: unknown) => {
      socket.write(`${JSON.stringify(message)}\n`);
    };
    const timer = setTimeout(() => finish(new Map()), 3_000);
    timer.unref?.();
    socket.once('connect', () => sendLine({
      type: 'hello',
      version: endpoint.version,
      token: endpoint.token,
      clientId: `botmux-${randomUUID()}`,
      role: 'control',
    }));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BUFFER_BYTES) return finish(new Map());
      let separator: number;
      while ((separator = buffer.indexOf(0x0a)) >= 0) {
        const line = buffer.subarray(0, separator);
        buffer = buffer.subarray(separator + 1);
        let message: any;
        try { message = JSON.parse(line.toString('utf-8')); } catch { continue; }
        if (!handshaken) {
          if (message?.type !== 'hello' || message.ok !== true) return finish(new Map());
          handshaken = true;
          sendLine({ id: '1', type: 'listSessions' });
          continue;
        }
        if (message?.id !== '1') continue;
        const sessions = (message.payload as DaemonListSessionsPayload | undefined)?.sessions;
        if (!Array.isArray(sessions)) return finish(new Map());
        const byHandle = new Map<string, OrcaDaemonSessionMetadata>();
        for (const session of sessions) {
          // Dead sessions keep stale root pids that could bind a recycled pid's process tree.
          if (typeof session?.terminalHandle !== 'string'
            || session.isAlive === false
            || !Number.isInteger(session.pid) || session.pid! <= 0) continue;
          byHandle.set(session.terminalHandle, {
            pid: session.pid!,
            ...(Number.isInteger(session.cols) && session.cols! > 0 ? { cols: session.cols! } : {}),
            ...(Number.isInteger(session.rows) && session.rows! > 0 ? { rows: session.rows! } : {}),
          });
        }
        return finish(byHandle);
      }
    });
    socket.once('error', () => finish(new Map()));
    socket.once('close', () => finish(new Map()));
  });
}
