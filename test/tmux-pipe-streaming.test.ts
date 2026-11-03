import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional backend */ }
const originalPath = process.env.PATH;
let root: string | undefined;
let socket: string | undefined;
let backend: TmuxPipeBackend | undefined;

afterEach(() => {
  backend?.destroySession();
  backend = undefined;
  // Always use this fixture's explicit socket, including on startup failure.
  if (socket) {
    try { execFileSync(realTmux!, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
  socket = undefined;
  process.env.PATH = originalPath;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

it.skipIf(!realTmux).each([
  ['short ready and final markers', ['›\r\n', '\x1b]777;botmux:final:e30=\x07›\r\n']],
  ['Unicode and terminal controls', ['你好\x1b[32m✓\x1b[0m', '\x1b[2K第二轮完成🌍']],
  ['a burst crossing the FIFO read boundary and its short tail', ['中'.repeat(30_000), '›\r\n']],
] as const)('forwards %s while the CLI remains open', async (_label, chunks) => {
  // A short, private socket path works on both Linux and macOS. No command
  // in this fixture can reach the user's default or managed tmux server.
  root = mkdtempSync('/tmp/bmx-stream-');
  socket = join(root, 'socket');
  const bin = join(root, 'bin'); mkdirSync(bin);
  const runtime = tsRunnerPrefix();
  const realCat = execFileSync('which', ['cat'], { encoding: 'utf8' }).trim();
  const bufferedCat = join(root, 'buffered-cat.mjs');
  // Reproduce block-buffered cat on GNU/BSD hosts too; file operands retain
  // normal behavior for the backend's shell wrapper.
  writeFileSync(bufferedCat, `const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => process.stdout.write(Buffer.concat(chunks)));
`);
  writeFileSync(join(bin, 'cat'), `#!/bin/sh
if [ "$#" -gt 0 ]; then exec ${quote(realCat)} "$@"; fi
exec ${quote(runtime.command)} ${quote(bufferedCat)}
`, { mode: 0o700 });
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec ${quote(realTmux!)} -S ${quote(socket)} "$@"\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${originalPath}`;
  const ready = join(root, 'ready');
  const terminal = join(root, 'terminal.mjs');
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
    cwd: resolve('.'), env: { PATH: process.env.PATH, HOME: root },
    cols: 120, rows: 40, strictEnv: true,
  });
  await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
  let expected = '';
  for (const [index, chunk] of chunks.entries()) {
    expected += chunk;
    expect(backend.write(`${index}\r`)).toBe(true);
    // Completion is observed from actual bytes, without closing the pane or
    // writing more output to force a buffer flush. Exact equality also catches
    // padding, duplication and split UTF-8 corruption across dd/FIFO reads.
    await vi.waitFor(() => expect(received).toBe(expected), { timeout: 3000, interval: 20 });
  }
});
