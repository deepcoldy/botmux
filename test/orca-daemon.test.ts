import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryOrcaDaemonSessions } from '../src/services/orca-daemon.js';

const originalEnv = process.env.ORCA_DAEMON_DIR;
const dirs: string[] = [];

afterEach(() => {
  if (originalEnv === undefined) delete process.env.ORCA_DAEMON_DIR;
  else process.env.ORCA_DAEMON_DIR = originalEnv;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ServeOptions {
  version: number;
  sessions?: unknown[];
  helloOk?: boolean;
}

function serveDaemon(socketPath: string, options: ServeOptions): Promise<{ close(): Promise<void> }> {
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf-8');
    let buffer = '';
    let handshaken = false;
    socket.on('data', chunk => {
      buffer += chunk;
      let separator: number;
      while ((separator = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 1);
        const message = JSON.parse(line);
        if (!handshaken) {
          expect(message).toMatchObject({
            type: 'hello',
            version: options.version,
            token: `token-${options.version}`,
            role: 'control',
          });
          expect(String(message.clientId)).toMatch(/^botmux-/);
          handshaken = true;
          socket.write(`${JSON.stringify({ type: 'hello', ok: options.helloOk !== false })}\n`);
          continue;
        }
        expect(message).toMatchObject({ id: '1', type: 'listSessions' });
        socket.write(`${JSON.stringify({ id: '1', payload: { sessions: options.sessions ?? [] } })}\n`);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve({
      close: () => new Promise<void>(done => server.close(() => done())),
    }));
  });
}

function daemonDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-orca-daemon-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe.skipIf(process.platform === 'win32')('Orca terminal daemon metadata client', () => {
  it('handshakes with the daemon protocol and decodes live session metadata', async () => {
    const dir = daemonDir({ 'daemon-v43.token': 'token-43' });
    const socketPath = join(dir, 'daemon-v43.sock');
    process.env.ORCA_DAEMON_DIR = dir;
    const daemon = await serveDaemon(socketPath, {
      version: 43,
      sessions: [
        {
          sessionId: 'serve-3687641d',
          incarnationId: 'inc_1',
          terminalHandle: 'term_1',
          pid: 100,
          cols: 120,
          rows: 40,
          isAlive: true,
        },
        { sessionId: 'serve-dead', terminalHandle: 'term_dead', pid: 200, cols: 80, rows: 24, isAlive: false },
        { sessionId: 'serve-badpid', terminalHandle: 'term_badpid', pid: 0, cols: 80, rows: 24, isAlive: true },
        { sessionId: 'serve-bare', terminalHandle: 'term_bare', pid: 300, isAlive: true },
      ],
    });
    try {
      await expect(queryOrcaDaemonSessions()).resolves.toEqual(new Map([
        ['term_1', { pid: 100, cols: 120, rows: 40 }],
        ['term_bare', { pid: 300 }],
      ]));
    } finally {
      await daemon.close();
    }
  });

  it('prefers the highest daemon version that has a readable token', async () => {
    const dir = daemonDir({
      'daemon-v42.token': 'token-42',
      'daemon-v42.sock': '', // stale instance without a listener must lose to v43
      'daemon-v44.sock': '', // highest version but tokenless must never be picked
      'daemon-v43.token': 'token-43',
    });
    process.env.ORCA_DAEMON_DIR = dir;
    const daemon = await serveDaemon(join(dir, 'daemon-v43.sock'), {
      version: 43,
      sessions: [{ terminalHandle: 'term_1', pid: 100, cols: 120, rows: 40 }],
    });
    try {
      await expect(queryOrcaDaemonSessions()).resolves.toEqual(new Map([
        ['term_1', { pid: 100, cols: 120, rows: 40 }],
      ]));
    } finally {
      await daemon.close();
    }
  });

  it('fails closed when the daemon rejects the handshake', async () => {
    const dir = daemonDir({ 'daemon-v9.token': 'token-9' });
    process.env.ORCA_DAEMON_DIR = dir;
    const daemon = await serveDaemon(join(dir, 'daemon-v9.sock'), { version: 9, helloOk: false });
    try {
      await expect(queryOrcaDaemonSessions()).resolves.toEqual(new Map());
    } finally {
      await daemon.close();
    }
  });

  it('fails closed without a daemon directory or with an unreachable socket', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'botmux-orca-daemon-'));
    dirs.push(empty);
    process.env.ORCA_DAEMON_DIR = empty;
    await expect(queryOrcaDaemonSessions()).resolves.toEqual(new Map());

    const dir = daemonDir({ 'daemon-v50.token': 'token-50', 'daemon-v50.sock': '' });
    process.env.ORCA_DAEMON_DIR = dir;
    await expect(queryOrcaDaemonSessions()).resolves.toEqual(new Map());
  });
});
