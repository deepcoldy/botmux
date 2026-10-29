import { describe, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { parseUnreapedPaneExit, readUnreapedPaneExit } from '../src/adapters/backend/unreaped-pane-exit.js';

/**
 * The kernel's record of a pane process the tmux server has not reaped
 * (#2453). Field 52 of /proc/<pid>/stat is the waitpid() status; it is trusted
 * only while the process is a zombie whose parent is the tmux server — the one
 * state in which that pid still unambiguously names the pane's process.
 */
const SERVER = 4321;
/** A /proc/<pid>/stat line: fields 3.. after `(comm)`, with field 52 = status. */
function statLine({ comm = 'sh', state = 'Z', ppid = SERVER, status = 0, fields = 52 } = {}): string {
  const rest = Array.from({ length: fields - 2 }, () => '0');
  rest[0] = state;
  rest[1] = String(ppid);
  if (fields >= 52) rest[52 - 3] = String(status);
  return `777 (${comm}) ${rest.join(' ')}\n`;
}

describe('parseUnreapedPaneExit', () => {
  it('decodes the exit code of a zombie child of the tmux server', () => {
    expect(parseUnreapedPaneExit(statLine({ status: 3 << 8 }), SERVER)).toEqual({ kind: 'exited', code: 3 });
    expect(parseUnreapedPaneExit(statLine({ status: 127 << 8 }), SERVER)).toEqual({ kind: 'exited', code: 127 });
  });

  it('decodes a signal death, with or without a core dump', () => {
    expect(parseUnreapedPaneExit(statLine({ status: 9 }), SERVER)).toEqual({ kind: 'signaled', signal: 9 });
    expect(parseUnreapedPaneExit(statLine({ status: 0x80 | 11 }), SERVER)).toEqual({ kind: 'signaled', signal: 11 });
  });

  it('counts fields from the last parenthesis, so a hostile comm cannot shift them', () => {
    expect(parseUnreapedPaneExit(statLine({ comm: 'a) S 1 (b', status: 77 << 8 }), SERVER)).toEqual({ kind: 'exited', code: 77 });
  });

  it('trusts nothing but an unreaped zombie of this server', () => {
    // still running / sleeping: no exit yet
    expect(parseUnreapedPaneExit(statLine({ state: 'S', status: 3 << 8 }), SERVER)).toBeNull();
    // a zombie of someone else: not the pane's process
    expect(parseUnreapedPaneExit(statLine({ ppid: 1, status: 3 << 8 }), SERVER)).toBeNull();
    // a kernel without field 52
    expect(parseUnreapedPaneExit(statLine({ fields: 44 }), SERVER)).toBeNull();
    expect(parseUnreapedPaneExit('garbage', SERVER)).toBeNull();
  });

  it('leaves a clean exit and a stop to tmux', () => {
    // 0 is also what an unprivileged reader is shown.
    expect(parseUnreapedPaneExit(statLine({ status: 0 }), SERVER)).toBeNull();
    expect(parseUnreapedPaneExit(statLine({ status: (19 << 8) | 0x7f }), SERVER)).toBeNull();
  });
});

describe('readUnreapedPaneExit', () => {
  it('reads /proc/<pane pid>/stat', () => {
    const paths: string[] = [];
    const r = readUnreapedPaneExit(777, SERVER, path => { paths.push(path); return statLine({ status: 3 << 8 }); });
    expect(r).toEqual({ kind: 'exited', code: 3 });
    expect(paths).toEqual(['/proc/777/stat']);
  });

  it('answers unknown when the line carried no pids or /proc cannot be read', () => {
    // What a line without the pid fields parses to, against the real filesystem.
    expect(readUnreapedPaneExit(Number.NaN, Number.NaN)).toBeNull();
    expect(readUnreapedPaneExit(777, Number.NaN, () => statLine({ status: 3 << 8 }))).toBeNull();
    expect(readUnreapedPaneExit(777, SERVER, () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); })).toBeNull();
  });

  let python3: string | undefined;
  try { python3 = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }

  // The field index and status encoding against the running kernel: a parent
  // that never reaps its child is exactly the tmux server of #2453.
  it.skipIf(!python3 || process.platform !== 'linux')('reads a real unreaped child from the running kernel', async () => {
    const parent = spawn(python3!, ['-c', [
      'import os, sys, time',
      'pid = os.fork()',
      'if pid == 0: os._exit(3)',
      'time.sleep(0.2)',
      'print(pid, flush=True)',
      'sys.stdin.read()',
    ].join('\n')], { stdio: ['pipe', 'pipe', 'inherit'] });
    try {
      const [chunk] = await once(parent.stdout!, 'data') as [Buffer];
      const child = Number(String(chunk).trim());
      expect(readUnreapedPaneExit(child, parent.pid!)).toEqual({ kind: 'exited', code: 3 });
      // the same zombie seen from a pid that is not its parent
      expect(readUnreapedPaneExit(child, process.pid)).toBeNull();
    } finally {
      parent.stdin!.end();
      await once(parent, 'close');
    }
  });
});
