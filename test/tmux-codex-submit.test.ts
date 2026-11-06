import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();
let root: string | undefined;
let socket: string | undefined;
const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket!, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
afterEach(() => {
  if (socket) { try { tmux('kill-server'); } catch {} }
  if (root) rmSync(root, { recursive: true, force: true });
  socket = root = undefined;
});

it.skipIf(!hasTmux).each(['h', 'l'])('delivers an exact submit frame with native paste mode %s', async mode => {
  root = mkdtempSync(join(tmpdir(), 'codex-frame-'));
  socket = `codex-frame-${process.pid}-${Date.now()}`; // Test-wide TMUX_TMPDIR fence isolates the server.
  const output = join(root, 'bytes');
  const ready = join(root, 'ready');
  const script = join(root, 'capture.mjs');
  writeFileSync(script, `import { appendFileSync, writeFileSync } from 'node:fs';
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?2004' + process.argv[4]);
writeFileSync(process.argv[3], 'ready');
process.stdin.on('data', data => appendFileSync(process.argv[2], data));
`);
  const { command, prefixArgs } = tsRunnerPrefix();
  const pane = tmux('-f', '/dev/null', 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'fixture', command, ...prefixArgs, script, output, ready, mode).trim();
  const waitFor = async (condition: () => boolean) => {
    const end = Date.now() + 5000;
    while (!condition() && Date.now() < end) await delay(20);
    expect(condition()).toBe(true);
  };
  await waitFor(() => existsSync(ready));
  const backend = new TmuxPipeBackend(pane, { socketName: socket });
  const content = 'line one  \nsecond\tline\r\n中文😀 ' + 'long'.repeat(2000);
  const expected = Buffer.from(`\x1b[200~${content}\x1b[201~\r`);
  expect(backend.submitBracketedPaste(content)).toBe(true);
  await waitFor(() => existsSync(output) && readFileSync(output).length >= expected.length);
  await delay(100);
  expect(readFileSync(output)).toEqual(expected);
  expect(tmux('list-buffers')).toBe('');
  expect(backend.pasteText('legacy text')).toBe(true);
  const legacy = Buffer.from(mode === 'h' ? '\x1b[200~legacy text\x1b[201~' : 'legacy text');
  await waitFor(() => readFileSync(output).length >= expected.length + legacy.length);
  expect(readFileSync(output)).toEqual(Buffer.concat([expected, legacy]));
  // Empty input must close its paste frame; the next input must remain intact.
  const emptyStart = readFileSync(output).length;
  const emptyFrame = Buffer.from('\x1b[200~\x1b[201~\r');
  const emptySent = backend.submitBracketedPaste('');
  await waitFor(() => readFileSync(output).length > emptyStart);
  await delay(100);
  expect({ sent: emptySent, bytes: readFileSync(output).subarray(emptyStart) })
    .toEqual({ sent: true, bytes: emptyFrame });
  expect(tmux('list-buffers')).toBe('');
  const nextFrame = Buffer.from('\x1b[200~after empty\x1b[201~\r');
  expect(backend.submitBracketedPaste('after empty')).toBe(true);
  await waitFor(() => readFileSync(output).length >= emptyStart + emptyFrame.length + nextFrame.length);
  await delay(100);
  expect(readFileSync(output).subarray(emptyStart)).toEqual(Buffer.concat([emptyFrame, nextFrame]));
  tmux('kill-session', '-t', 'fixture');
  expect(backend.submitBracketedPaste('after disconnect')).toBe(false);
  expect(backend.submitBracketedPaste('')).toBe(false);
});
