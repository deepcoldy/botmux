import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryOrcaRelayPtyMetadata } from '../src/services/orca-relay.js';

const originalEnv = {
  path: process.env.PATH,
  socket: process.env.ORCA_RELAY_SOCKET_PATH,
  dir: process.env.ORCA_RELAY_DIR,
  credential: process.env.ORCA_RELAY_CREDENTIAL_FILE,
  bin: process.env.ORCA_REMOTE_CLI_BIN_DIR,
};
const dirs: string[] = [];

afterEach(() => {
  process.env.PATH = originalEnv.path;
  if (originalEnv.socket === undefined) delete process.env.ORCA_RELAY_SOCKET_PATH;
  else process.env.ORCA_RELAY_SOCKET_PATH = originalEnv.socket;
  if (originalEnv.dir === undefined) delete process.env.ORCA_RELAY_DIR;
  else process.env.ORCA_RELAY_DIR = originalEnv.dir;
  if (originalEnv.credential === undefined) delete process.env.ORCA_RELAY_CREDENTIAL_FILE;
  else process.env.ORCA_RELAY_CREDENTIAL_FILE = originalEnv.credential;
  if (originalEnv.bin === undefined) delete process.env.ORCA_REMOTE_CLI_BIN_DIR;
  else process.env.ORCA_REMOTE_CLI_BIN_DIR = originalEnv.bin;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function frame(type: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(13);
  header[0] = type;
  header.writeUInt32BE(1, 1);
  header.writeUInt32BE(0, 5);
  header.writeUInt32BE(body.length, 9);
  return Buffer.concat([header, body]);
}

function serveRelay(socketPath: string): Promise<{ close(): Promise<void> }> {
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 13) {
        const type = buffer[0]!;
        const length = buffer.readUInt32BE(9);
        if (buffer.length < 13 + length) return;
        const payload = JSON.parse(buffer.subarray(13, 13 + length).toString('utf-8'));
        buffer = buffer.subarray(13 + length);
        if (!handshaken) {
          expect(type).toBe(2);
          expect(payload).toMatchObject({ type: 'orca-relay-handshake', endpointCredential: 'credential' });
          handshaken = true;
          socket.write(frame(2, { type: 'orca-relay-handshake-ok', version: 'test-version' }));
          continue;
        }
        expect(payload).toMatchObject({ method: 'pty.serialize', params: { ids: ['pty-1'] } });
        socket.write(frame(1, {
          jsonrpc: '2.0',
          id: 1,
          result: JSON.stringify([{ id: 'pty-1', pid: 123, cols: 104, rows: 50 }]),
        }));
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

describe.skipIf(process.platform === 'win32')('Orca relay metadata client', () => {
  it('performs the authenticated handshake and decodes PTY geometry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-orca-relay-'));
    dirs.push(dir);
    const socketPath = join(dir, 'relay.sock');
    writeFileSync(join(dir, '.version'), 'test-version');
    writeFileSync(join(dir, 'credential'), 'credential');
    process.env.ORCA_RELAY_SOCKET_PATH = socketPath;
    process.env.ORCA_RELAY_DIR = dir;
    process.env.ORCA_RELAY_CREDENTIAL_FILE = join(dir, 'credential');
    const relay = await serveRelay(socketPath);
    try {
      await expect(queryOrcaRelayPtyMetadata(['pty-1'])).resolves.toEqual(new Map([
        ['pty-1', { pid: 123, cols: 104, rows: 50 }],
      ]));
    } finally {
      await relay.close();
    }
  });

  it('recovers relay paths from the installed Orca wrapper without extra configuration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-orca-wrapper-'));
    dirs.push(dir);
    const socketPath = join(dir, 'relay.sock');
    const credentialFile = join(dir, 'credential');
    writeFileSync(join(dir, '.version'), 'test-version');
    writeFileSync(credentialFile, 'credential');
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const wrapper = join(binDir, 'orca');
    writeFileSync(wrapper, [
      '#!/bin/sh',
      `ORCA_RELAY_DIR=\${ORCA_RELAY_DIR:-'${dir}'}`,
      `ORCA_RELAY_SOCKET_PATH=\${ORCA_RELAY_SOCKET_PATH:-'${socketPath}'}`,
      `ORCA_RELAY_CREDENTIAL_FILE=\${ORCA_RELAY_CREDENTIAL_FILE:-'${credentialFile}'}`,
    ].join('\n'));
    chmodSync(wrapper, 0o755);
    delete process.env.ORCA_RELAY_SOCKET_PATH;
    delete process.env.ORCA_RELAY_DIR;
    delete process.env.ORCA_RELAY_CREDENTIAL_FILE;
    process.env.ORCA_REMOTE_CLI_BIN_DIR = binDir;
    process.env.PATH = '';
    const relay = await serveRelay(socketPath);
    try {
      expect((await queryOrcaRelayPtyMetadata(['pty-1'])).get('pty-1')).toEqual({
        pid: 123,
        cols: 104,
        rows: 50,
      });
    } finally {
      await relay.close();
    }
  });
});
