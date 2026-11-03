import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, type ReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { pipePaneShellCommand } from '../src/adapters/backend/tmux-pipe-relay.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional backend */ }
const realCat = execFileSync('which', ['cat'], { encoding: 'utf8' }).trim();
const originalPath = process.env.PATH;

type CatKind = 'uutils' | 'busybox' | 'system';
const CATS: ReadonlyArray<readonly [string, CatKind]> = [
  // uutils 0.8.0: `cat` (with or without -u) holds short pipe writes until EOF.
  ['a uutils cat that holds output until EOF', 'uutils'],
  // busybox: same buffering, but --version is rejected with the banner on
  // stderr, so detection has to read stderr to see it.
  ['a busybox cat that holds output until EOF', 'busybox'],
  ['the system cat', 'system'],
];

let root: string | undefined;
let socket: string | undefined;
let backend: TmuxPipeBackend | undefined;
const children: ChildProcess[] = [];
const streams: ReadStream[] = [];

afterEach(() => {
  backend?.destroySession();
  backend = undefined;
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const stream of streams.splice(0)) stream.destroy();
  // Always use this fixture's explicit socket, including on startup failure.
  if (socket) {
    try { execFileSync(realTmux!, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
  socket = undefined;
  process.env.PATH = originalPath;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A private dir whose `bin` comes first on the returned PATH. With `uutils`
 *  or `busybox` it holds a `cat` that identifies itself the way that
 *  implementation does and, like both of them on a socket stdin, emits nothing
 *  until stdin closes. Its path has only plain characters, so
 *  pipePaneShellCommand needs no tmux format escaping and runs under sh as is. */
function fixture(cat: CatKind): { root: string; bin: string; path: string } {
  root = mkdtempSync('/tmp/bmx-stream-');
  const bin = join(root, 'bin'); mkdirSync(bin);
  if (cat !== 'system') {
    const bufferedCat = join(root, 'buffered-cat.mjs');
    writeFileSync(bufferedCat, `const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => process.stdout.write(Buffer.concat(chunks)));
`);
    // A real busybox rejects --version outright; its banner goes to stderr and
    // the exit status is 1 (measured on BusyBox v1.35.0).
    const version = cat === 'uutils'
      ? `echo 'cat (uutils coreutils) 0.8.0'; exit 0`
      : `echo "cat: unrecognized option '--version'" >&2
  echo 'BusyBox v1.35.0 (Debian 1:1.35.0-4+b3) multi-call binary.' >&2
  exit 1`;
    writeFileSync(join(bin, 'cat'), `#!/bin/sh
if [ "$1" = --version ]; then ${version}; fi
if [ "$#" -gt 0 ]; then exec ${quote(realCat)} "$@"; fi
exec ${quote(tsRunnerPrefix().command)} ${quote(bufferedCat)}
`, { mode: 0o700 });
  }
  return { root, bin, path: `${bin}:${originalPath}` };
}

function collect(fifo: string): { text: () => string; stream: ReadStream } {
  const stream = createReadStream(fifo);
  streams.push(stream);
  let text = '';
  stream.on('data', chunk => { text += chunk.toString(); });
  return { text: () => text, stream };
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise(resolveExit => {
    if (child.exitCode !== null || child.signalCode !== null) resolveExit();
    else child.once('exit', () => resolveExit());
  });
}

describe.each(CATS)('pipe-pane copy command with %s', (_label, cat) => {
  // tmux hands the command a socket as stdin, as child_process 'pipe' does.
  function startCopy(setup: (root: string) => { env?: NodeJS.ProcessEnv; cwd?: string } = () => ({})) {
    const fx = fixture(cat);
    const fifo = join(fx.root, 'out.fifo');
    execFileSync('mkfifo', [fifo]);
    const { env, cwd } = setup(fx.root);
    const child = spawn('/bin/sh', ['-c', pipePaneShellCommand(fifo)], {
      env: { ...env, PATH: fx.path }, cwd, stdio: ['pipe', 'ignore', 'ignore'],
    });
    children.push(child);
    child.stdin!.on('error', () => { /* the copier may exit first */ });
    return { child, out: collect(fifo) };
  }

  it('forwards each short write at once and exits when tmux closes the pipe', async () => {
    const { child, out } = startCopy();
    let expected = '';
    for (const chunk of ['›\r\n', 'x', '你好\x1b[0m']) {
      child.stdin!.write(chunk);
      expected += chunk;
      await vi.waitFor(() => expect(out.text()).toBe(expected), { timeout: 3000, interval: 20 });
    }
    child.stdin!.end();
    await exited(child);
  });

  it('exits once the FIFO reader is gone', async () => {
    const { child, out } = startCopy();
    child.stdin!.write('ready');
    await vi.waitFor(() => expect(out.text()).toBe('ready'), { timeout: 3000, interval: 20 });
    out.stream.destroy();
    const timer = setInterval(() => { if (child.stdin!.writable) child.stdin!.write('more'); }, 20);
    try { await exited(child); } finally { clearInterval(timer); }
  });

  // The relay runs outside any sandbox; tmux's environment and the pane's
  // working directory must not be able to run code in it.
  it('runs no preload from the environment or the working directory', async () => {
    let probe = '';
    const { child, out } = startCopy(dir => {
      probe = join(dir, 'preload-ran');
      const preload = join(dir, 'preload.cjs');
      writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(probe)}, '')`);
      const workdir = join(dir, 'workdir'); mkdirSync(workdir);
      writeFileSync(join(workdir, 'bunfig.toml'), `preload = [${JSON.stringify(preload)}]\n`);
      return { cwd: workdir, env: { NODE_OPTIONS: `--require=${preload}`, BUN_OPTIONS: `--preload=${preload}` } };
    });
    child.stdin!.write('ready');
    await vi.waitFor(() => expect(out.text()).toBe('ready'), { timeout: 3000, interval: 20 });
    child.stdin!.end();
    await exited(child);
    expect(existsSync(probe)).toBe(false);
  });
});

describe.skipIf(!realTmux)('TmuxPipeBackend streaming through a real tmux server', () => {
  const CASES = [
    ['short ready and final markers', ['›\r\n', '\x1b]777;botmux:final:e30=\x07›\r\n']],
    ['Unicode and terminal controls', ['你好\x1b[32m✓\x1b[0m', '\x1b[2K第二轮完成🌍']],
    ['a burst crossing the FIFO read boundary and its short tail', ['中'.repeat(30_000), '›\r\n']],
  ] as const;

  it.each(CATS.flatMap(([catLabel, cat]) => CASES.map(([label, chunks]) => [label, catLabel, cat, chunks] as const)))(
    'forwards %s with %s while the CLI remains open', async (_label, _catLabel, cat, chunks) => {
      // A short, private socket path works on both Linux and macOS. No command
      // in this fixture can reach the user's default or managed tmux server.
      const fx = fixture(cat);
      socket = join(fx.root, 'socket');
      writeFileSync(join(fx.bin, 'tmux'), `#!/bin/sh\nexec ${quote(realTmux!)} -S ${quote(socket)} "$@"\n`, { mode: 0o700 });
      // The tmux server, and through it pipe-pane, inherits this PATH.
      process.env.PATH = fx.path;
      const runtime = tsRunnerPrefix();
      const ready = join(fx.root, 'ready');
      const terminal = join(fx.root, 'terminal.mjs');
      writeFileSync(terminal, `import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const chunks = ${JSON.stringify(chunks)};
process.stdin.setRawMode(true);
execFileSync('stty', ['-opost'], { stdio: 'inherit' });
let input = '';
process.stdin.on('data', data => {
  for (const ch of data.toString()) {
    if (ch === '\\r') { process.stdout.write(chunks[Number(input)]); input = ''; }
    else input += ch;
  }
});
process.stdin.resume();
writeFileSync(${JSON.stringify(ready)}, 'ready');
`);
      backend = new TmuxPipeBackend('streaming', { createSession: true, ownsSession: true });
      let received = '';
      backend.onData(data => { received += data; });
      backend.spawn(runtime.command, [...runtime.prefixArgs, terminal], {
        cwd: resolve('.'), env: { PATH: process.env.PATH, HOME: fx.root },
        cols: 120, rows: 40, strictEnv: true,
      });
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
      let expected = '';
      for (const [index, chunk] of chunks.entries()) {
        expected += chunk;
        expect(backend.write(`${index}\r`)).toBe(true);
        // Completion is observed from actual bytes, without closing the pane or
        // writing more output to force a buffer flush. Exact equality also catches
        // padding, duplication and split UTF-8 corruption across FIFO reads.
        await vi.waitFor(() => expect(received).toBe(expected), { timeout: 3000, interval: 20 });
      }
    });

  // The backend passes the command to tmux directly, or — behind the legacy
  // dead-pane guard — inside an if-shell command string that tmux parses
  // itself. pipe-pane then expands it as a format and strftime string.
  it.each(['pipe-pane argument', 'if-shell command string'] as const)(
    'delivers to a FIFO path with shell and tmux metacharacters via the %s', async form => {
      const fx = fixture('uutils');
      socket = join(fx.root, 'socket');
      const dir = join(fx.root, `a b#S%d$x"y'z`); mkdirSync(dir);
      const fifo = join(dir, 'out.fifo');
      execFileSync('mkfifo', [fifo]);
      const out = collect(fifo);
      const tmux = (...args: string[]) => execFileSync(realTmux!, ['-S', socket!, ...args], { env: { ...process.env, PATH: fx.path }, encoding: 'utf8' });
      tmux('new-session', '-d', '-s', 'meta', '-x', '80', '-y', '20', 'sleep 60');
      const command = pipePaneShellCommand(fifo);
      if (form === 'pipe-pane argument') tmux('pipe-pane', '-O', '-t', 'meta', command);
      else tmux('if-shell', '-F', '-t', 'meta', '#{pane_dead}', 'display-message -p dead', `pipe-pane -O -t meta ${quote(command)}`);
      // The pane's terminal echoes typed input, so it reaches the pipe as output.
      tmux('send-keys', '-t', 'meta', '-l', 'marker-42');
      await vi.waitFor(() => expect(out.text()).toContain('marker-42'), { timeout: 3000, interval: 20 });
    });
});
