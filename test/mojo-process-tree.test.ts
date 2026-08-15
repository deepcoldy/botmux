/**
 * Subtree enumeration against a synthetic /proc, so each of the three signals can
 * be isolated (a real /proc cannot be made to hold a chosen shape).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MOJO_TREE_NONCE_ENV, scanMojoTree } from '../src/adapters/backend/mojo-process-tree.js';

let procRoot: string;
const NONCE = 'botmux-mojo-deadbeef';

function proc(pid: number, opts: { ppid: number; pgid: number; comm?: string; env?: string }): void {
  const dir = join(procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  // Field 2 is parenthesised and may itself contain spaces and ')', which is why
  // the parser cuts at the LAST ')' instead of splitting on whitespace.
  writeFileSync(join(dir, 'stat'), `${pid} (${opts.comm ?? 'mojo'}) S ${opts.ppid} ${opts.pgid} 0 0 -1 0`);
  writeFileSync(join(dir, 'environ'), opts.env ?? '');
}

beforeEach(() => { procRoot = mkdtempSync(join(tmpdir(), 'fake-proc-')); });
afterEach(() => { rmSync(procRoot, { recursive: true, force: true }); });

describe('scanMojoTree', () => {
  it('finds a descendant that escaped the process group via setsid', () => {
    proc(100, { ppid: 1, pgid: 100 });                                          // turn root
    // New group AND new session, reparented to init: neither pgid nor ppid can
    // reach it. Only the inherited env nonce can.
    proc(200, { ppid: 1, pgid: 200, env: `PATH=/bin\0${MOJO_TREE_NONCE_ENV}=${NONCE}\0` });
    proc(300, { ppid: 1, pgid: 300, env: 'PATH=/bin\0' });                      // unrelated

    const scan = scanMojoTree(100, NONCE, { procRoot });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.members.map(m => m.pid).sort()).toEqual([100, 200]);
    expect(scan.members.find(m => m.pid === 200)?.via).toBe('env');
  });

  it('finds an env-scrubbed descendant through the parent chain', () => {
    proc(100, { ppid: 1, pgid: 100 });
    proc(200, { ppid: 100, pgid: 200, env: '' });   // left the group, wiped its env
    proc(300, { ppid: 200, pgid: 300, env: '' });   // grandchild, same
    const scan = scanMojoTree(100, NONCE, { procRoot });
    if (!scan.ok) throw new Error('scan failed');
    expect(scan.members.map(m => m.pid).sort()).toEqual([100, 200, 300]);
  });

  it('never claims the excluded pids', () => {
    // The daemon must never be signalled, even if some other signal matched.
    proc(100, { ppid: 1, pgid: 100 });
    proc(999, { ppid: 100, pgid: 100, env: `${MOJO_TREE_NONCE_ENV}=${NONCE}\0` });
    const scan = scanMojoTree(100, NONCE, { procRoot, excludePids: [999] });
    if (!scan.ok) throw new Error('scan failed');
    expect(scan.members.map(m => m.pid)).not.toContain(999);
  });

  it('parses a comm containing spaces and a close paren', () => {
    proc(100, { ppid: 1, pgid: 100, comm: 'we ird) name' });
    const scan = scanMojoTree(100, NONCE, { procRoot });
    if (!scan.ok) throw new Error('scan failed');
    expect(scan.members.map(m => m.pid)).toEqual([100]);
  });

  it('fails instead of reporting an empty tree when /proc cannot be read', () => {
    // "cannot enumerate" must never read as "nothing is running": that would let a
    // close claim success on an unscannable host.
    const scan = scanMojoTree(100, NONCE, { procRoot: join(procRoot, 'missing') });
    expect(scan.ok).toBe(false);
  });

  it('reports an empty tree only when the subtree is genuinely gone', () => {
    proc(300, { ppid: 1, pgid: 300, env: 'PATH=/bin\0' });
    const scan = scanMojoTree(100, NONCE, { procRoot });
    if (!scan.ok) throw new Error('scan failed');
    expect(scan.members).toEqual([]);
  });
});
