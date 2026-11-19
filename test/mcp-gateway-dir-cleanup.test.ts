import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  pinSessionMcpGatewaySocketRoot,
  removeSessionMcpGatewayDir,
  sessionMcpGatewaySocketDir,
  sweepOrphanSessionMcpGatewayDirs,
} from '../src/core/plugins/mcp/socket-dir.js';
import { readMcpGatewayLaunchRecord, writeMcpGatewayLaunchRecord } from '../src/core/plugins/mcp/launch-record.js';

// Short root: g.sock must stay under the AF_UNIX path limit. Pinned once for
// this file, exactly like the worker pins its inherited tmpdir().
const socketRoot = mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'bmcp-sweep-'));
pinSessionMcpGatewaySocketRoot(socketRoot);
const uid = process.getuid?.() ?? 0;
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => rmSync(socketRoot, { recursive: true, force: true }));

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bmcp-sweep-data-'));
  dirs.push(dir);
  return dir;
}

function gatewayDir(sessionId: string, data: string, ageMs = 10 * 60_000): string {
  const dir = sessionMcpGatewaySocketDir(sessionId, data);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, 'auth'), 'token\n', { mode: 0o600 });
  const at = new Date(Date.now() - ageMs);
  utimesSync(dir, at, at);
  dirs.push(dir);
  return dir;
}

async function listen(socketPath: string): Promise<void> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
}

const noLive = async () => new Set<string>();

describe.skipIf(process.getuid === undefined)('closed session Gateway directory (#1937)', () => {
  it('removes the whole directory and the launch record', () => {
    const data = dataDir();
    const dir = gatewayDir('closed', data);
    writeMcpGatewayLaunchRecord(data, 'closed', join(dir, 'g.sock'));

    removeSessionMcpGatewayDir('closed', data);

    expect(existsSync(dir)).toBe(false);
    expect(readMcpGatewayLaunchRecord(data, 'closed')).toBeNull();
  });

  it('honours a recorded root only for the session’s own directory name', () => {
    const data = dataDir();
    const otherRoot = mkdtempSync(join(socketRoot, 'r'));
    const recordedDir = join(otherRoot, basename(sessionMcpGatewaySocketDir('s1', data)));
    mkdirSync(recordedDir);
    const foreignDir = join(otherRoot, `bmcp-${uid}-0123456789abcdef`);
    mkdirSync(foreignDir);

    writeMcpGatewayLaunchRecord(data, 's2', join(foreignDir, 'g.sock'));
    removeSessionMcpGatewayDir('s2', data);
    expect(existsSync(foreignDir)).toBe(true);

    writeMcpGatewayLaunchRecord(data, 's1', join(recordedDir, 'g.sock'));
    removeSessionMcpGatewayDir('s1', data);
    expect(existsSync(recordedDir)).toBe(false);
  });

  it('does not follow a symlink planted at the directory path', () => {
    const data = dataDir();
    const target = mkdtempSync(join(socketRoot, 't'));
    writeFileSync(join(target, 'keep'), 'x');
    const link = sessionMcpGatewaySocketDir('linked', data);
    symlinkSync(target, link);
    dirs.push(link);

    removeSessionMcpGatewayDir('linked', data);

    expect(existsSync(join(target, 'keep'))).toBe(true);
  });
});

describe.skipIf(process.getuid === undefined)('orphan Gateway directory sweep (#1937)', () => {
  it('removes unused directories of any data dir and keeps active sessions’ ones', async () => {
    const mine = dataDir();
    const other = dataDir();
    const active = gatewayDir('suspended', mine);
    const closed = gatewayDir('closed', mine);
    const foreign = gatewayDir('test-run', other);

    const removed = await sweepOrphanSessionMcpGatewayDirs(mine, new Set(['suspended']), { liveReferences: noLive });

    expect(removed.sort()).toEqual([closed, foreign].sort());
    expect(existsSync(active)).toBe(true);
  });

  it('keeps a directory whose socket still accepts connections', async () => {
    const data = dataDir();
    const served = gatewayDir('served', data);
    await listen(join(served, 'g.sock'));
    const stale = gatewayDir('stale', data);
    const staleServer = createServer();
    await new Promise<void>(resolve => staleServer.listen(join(stale, 'g.sock'), resolve));
    await new Promise(resolve => staleServer.close(resolve));
    writeFileSync(join(stale, 'g.sock'), '');
    for (const dir of [served, stale]) utimesSync(dir, new Date(0), new Date(0));

    const removed = await sweepOrphanSessionMcpGatewayDirs(data, new Set(), { liveReferences: noLive });

    expect(removed).toEqual([stale]);
    expect(existsSync(served)).toBe(true);
  });

  it('keeps a directory a live process references (a sandboxed pane binds it by inode)', async () => {
    const data = dataDir();
    const bound = gatewayDir('bound', data);
    const probe = vi.fn(async (names: readonly string[]) => new Set(names.filter(name => name === basename(bound))));

    const removed = await sweepOrphanSessionMcpGatewayDirs(data, new Set(), { liveReferences: probe });

    expect(removed).toEqual([]);
    expect(existsSync(bound)).toBe(true);
  });

  it('keeps a directory a host re-served after the liveness probe ran', async () => {
    const data = dataDir();
    const dir = gatewayDir('restarted', data);
    const probe = async () => { writeFileSync(join(dir, 'auth'), 'rotated\n'); utimesSync(dir, new Date(), new Date()); return new Set<string>(); };

    const removed = await sweepOrphanSessionMcpGatewayDirs(data, new Set(), { liveReferences: probe });

    expect(removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a directory a host bound after the batch probe, even with an old mtime', async () => {
    const data = dataDir();
    const dir = gatewayDir('rebound', data);
    // The resumed worker re-serves the deterministic path while the sweep is
    // between its batch probe and the removal (mtime forced old on purpose).
    const probe = async () => {
      await listen(join(dir, 'g.sock'));
      utimesSync(dir, new Date(0), new Date(0));
      return new Set<string>();
    };

    const removed = await sweepOrphanSessionMcpGatewayDirs(data, new Set(), { liveReferences: probe });

    expect(removed).toEqual([]);
    expect(existsSync(join(dir, 'g.sock'))).toBe(true);
  });

  it('removes nothing while no process can be seen', async () => {
    const data = dataDir();
    const dir = gatewayDir('unknown', data);

    const removed = await sweepOrphanSessionMcpGatewayDirs(data, new Set(), { liveReferences: async () => null });

    expect(removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps fresh directories and never touches other names or other users', async () => {
    const data = dataDir();
    const fresh = gatewayDir('fresh', data, 0);
    const otherUser = join(socketRoot, `bmcp-${uid + 1}-0123456789abcdef`);
    const unrelated = join(socketRoot, 'bmcp-notes');
    for (const dir of [otherUser, unrelated]) {
      mkdirSync(dir);
      utimesSync(dir, new Date(0), new Date(0));
      dirs.push(dir);
    }

    const removed = await sweepOrphanSessionMcpGatewayDirs(data, new Set(), { liveReferences: noLive });

    expect(removed).toEqual([]);
    for (const dir of [fresh, otherUser, unrelated]) expect(existsSync(dir)).toBe(true);
  });
});
