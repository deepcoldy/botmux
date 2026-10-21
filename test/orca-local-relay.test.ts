import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, Socket } from 'node:net';

const mockState = vi.hoisted(() => ({
  processEnv: 'ORCA_TERMINAL_HANDLE=term_offline\0ORCA_WORKTREE_ID=repo::/work\0',
}));

vi.mock('../src/services/orca-processes.js', () => ({
  scanLocalOrcaCliPids: () => new Map([['term_offline', { pid: 124, cliId: 'traex' }]]),
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((path: unknown, ...args: unknown[]) => path === '/proc/123/environ'
      ? mockState.processEnv
      : (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...args)) as typeof actual.readFileSync,
  };
});

import { callLocalOrcaRelay } from '../src/services/orca-local-relay.js';

const servers: Server[] = [];
const sockets = new Set<Socket>();
const originalRemoteDir = process.env.ORCA_REMOTE_DIR;
let relayRoot = '';

beforeEach(() => {
  relayRoot = mkdtempSync(join(tmpdir(), 'botmux-orca-relay-'));
  process.env.ORCA_REMOTE_DIR = relayRoot;
  mockState.processEnv = 'ORCA_TERMINAL_HANDLE=term_offline\0ORCA_WORKTREE_ID=repo::/work\0';
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  rmSync(relayRoot, { recursive: true, force: true });
  if (originalRemoteDir === undefined) delete process.env.ORCA_REMOTE_DIR;
  else process.env.ORCA_REMOTE_DIR = originalRemoteDir;
});

function frame(type: number, value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(13);
  header[0] = type;
  header.writeUInt32BE(body.length, 9);
  return Buffer.concat([header, body]);
}

async function relay(options: {
  online?: boolean;
  reuseAfterWrite?: boolean;
  forged?: boolean;
  incarnation?: string | null;
  foreground?: string;
  cols?: number;
  rows?: number;
} = {}) {
  const dir = join(relayRoot, `relay-test-${servers.length}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'relay.sock');
  writeFileSync(join(dir, '.version'), 'test-version');
  writeFileSync(`${path}.credential`, 'credential');
  const writes: unknown[] = [];
  const requests: string[] = [];
  const server = createServer(socket => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 13) {
        const bytes = buffer.readUInt32BE(9);
        if (buffer.length < 13 + bytes) return;
        const type = buffer[0];
        const value = JSON.parse(buffer.subarray(13, 13 + bytes).toString('utf-8'));
        buffer = buffer.subarray(13 + bytes);
        if (type === 2) {
          expect(value).toMatchObject({ version: 'test-version', endpointCredential: 'credential' });
          socket.write(frame(2, { type: 'orca-relay-handshake-ok' }));
          continue;
        }
        requests.push(value.method);
        let result: unknown;
        let error: unknown;
        const handle = options.forged ? 'term_other' : 'term_offline';
        switch (value.method) {
          case 'pty.openClient':
            expect(value.params.requestedRole).toBe('subscriber');
            result = { protocolVersion: 1, role: 'subscriber' };
            break;
          case 'pty.listProcesses':
            result = [{ id: 'pty-1', terminalHandle: handle, title: options.foreground ?? 'traecli',
              incarnationId: options.incarnation === null ? undefined : writes.length && options.reuseAfterWrite ? 'inc-reused' : options.incarnation ?? 'inc-1' }];
            break;
          case 'pty.serialize':
            result = JSON.stringify([{
              id: 'pty-1', terminalHandle: handle, worktreeId: 'repo::/work', cwd: '/work', pid: 123,
              cols: options.cols ?? 80, rows: options.rows ?? 24,
            }]);
            break;
          case 'orca.cli':
            if (options.online) result = { stdout: JSON.stringify({ ok: true, result: { terminal: { status: 'running', source: 'screen', tail: ['desktop screen'] } } }) };
            else error = { code: -32000, message: 'No owning Orca client is connected to the relay' };
            break;
          case 'pty.attach':
            result = { incarnationId: 'inc-1', replay: '\x1b[2J\x1b[Horiginal session\r\n\x1b[1m›\x1b[0m \x1b[2mask a question\x1b[0m\x1b[2;3H' };
            break;
          case 'pty.data':
            writes.push(value.params);
            continue;
          default: error = { code: -32601, message: 'Method not found' };
        }
        socket.write(frame(1, { jsonrpc: '2.0', method: 'pty.data', params: { id: 'pty-unrelated', data: 'unsolicited output' } }));
        socket.write(frame(1, { jsonrpc: '2.0', id: value.id, ...(error ? { error } : { result }) }));
        socket.write(frame(1, { jsonrpc: '2.0', method: 'pty.data', params: { id: 'pty-unrelated', data: 'after reply' } }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(path, resolve));
  return { writes, requests };
}

describe.skipIf(process.platform !== 'linux')('local Orca relay without its desktop owner', () => {
  it('discovers the original process with an authenticated root and stable incarnation', async () => {
    await relay();
    expect(await callLocalOrcaRelay(['terminal', 'list'])).toMatchObject({ ok: true, value: { terminals: [{
      handle: 'term_offline', incarnationId: 'inc-1', agentIdentity: 'trae', pid: 123, cols: 80, rows: 24,
    }] } });
  });

  it('keeps the CLI identity while one of its tools owns the foreground', async () => {
    await relay({ foreground: 'bash' });
    expect(await callLocalOrcaRelay(['terminal', 'list'])).toMatchObject({ ok: true, value: { terminals: [{ agentIdentity: 'trae' }] } });
  });

  it('reads the original terminal after all desktop clients disconnect', async () => {
    await relay();
    expect(await callLocalOrcaRelay(['terminal', 'read', '--terminal', 'term_offline', '--screen'])).toMatchObject({
      ok: true, value: { terminal: { status: 'running', source: 'screen', tail: ['original session', '› ask a question'] } },
    });
  });

  it('uses the desktop snapshot while it is online, preserving its pending output', async () => {
    const fake = await relay({ online: true });
    expect(await callLocalOrcaRelay(['terminal', 'read', '--terminal', 'term_offline', '--screen'])).toMatchObject({
      ok: true, value: { terminal: { tail: ['desktop screen'] } },
    });
    expect(fake.requests).not.toContain('pty.attach');
  });

  it('submits text and Enter once to the same original PTY after disconnect', async () => {
    const fake = await relay();
    expect(await callLocalOrcaRelay(['terminal', 'send', '--terminal', 'term_offline', '--text', '继续原来的任务', '--enter']))
      .toMatchObject({ ok: true, value: { send: { accepted: true } } });
    expect(fake.writes).toEqual([{ id: 'pty-1', data: '继续原来的任务\r' }]);
  });

  it('does not retry a write whose process incarnation changed before confirmation', async () => {
    const fake = await relay({ reuseAfterWrite: true });
    expect(await callLocalOrcaRelay(['terminal', 'send', '--terminal', 'term_offline', '--text', 'once', '--enter']))
      .toMatchObject({ ok: false, kind: 'unavailable' });
    expect(fake.writes).toHaveLength(1);
  });

  it('refuses a changed persisted incarnation before writing any input', async () => {
    const fake = await relay();
    expect(await callLocalOrcaRelay(['terminal', 'send', '--terminal', 'term_offline', '--text', 'never', '--enter'], 8_000, {
      terminalHandle: 'term_offline', incarnationId: 'inc-original', worktreeId: 'repo::/work', agentIdentity: 'trae',
    })).toMatchObject({ ok: false, kind: 'missing' });
    expect(fake.writes).toEqual([]);
  });

  it('refuses a handle reported by two relays rather than choosing one', async () => {
    const a = await relay();
    const b = await relay({ incarnation: 'inc-other' });
    expect(await callLocalOrcaRelay(['terminal', 'list'])).toEqual({ ok: true, value: { terminals: [] } });
    expect(await callLocalOrcaRelay(['terminal', 'send', '--terminal', 'term_offline', '--text', 'never', '--enter']))
      .toMatchObject({ ok: false, kind: 'unavailable' });
    expect([...a.writes, ...b.writes]).toEqual([]);
  });

  it.each([{ forged: true }, { incarnation: null }])('rejects unverifiable relay process metadata: %j', async options => {
    await relay(options);
    expect(await callLocalOrcaRelay(['terminal', 'list'])).toEqual({ ok: true, value: { terminals: [] } });
  });

  it('rejects a process whose terminal handle matches but worktree ownership does not', async () => {
    mockState.processEnv = 'ORCA_TERMINAL_HANDLE=term_offline\0ORCA_WORKTREE_ID=repo::/other\0';
    await relay();
    expect(await callLocalOrcaRelay(['terminal', 'list'])).toEqual({ ok: true, value: { terminals: [] } });
  });

  it.each([{ cols: 501, rows: 24 }, { cols: 80, rows: 501 }])('rejects unsafe relay geometry: %j', async dimensions => {
    await relay(dimensions);
    expect(await callLocalOrcaRelay(['terminal', 'list'])).toEqual({ ok: true, value: { terminals: [] } });
  });
});
