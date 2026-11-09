/** Opt-in native CLI acceptance. Uses an empty HOME and loopback model fixture;
 * never reads host credentials, talks to Lark, or starts a shared daemon.
 * BOTMUX_CODEX_TRANSCRIPT_TEST_BIN=/path/to/codex bun x vitest run --project e2e test/codex-transcript-input.e2e.ts */
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn, type IPty } from 'node-pty';
import xterm from '@xterm/headless';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { codexNativeComposerState } from '../src/services/codex-terminal-session.js';
import { buildOpenAiResponsesTextEvents } from './helpers/mock-llm-server/openai-responses-sse.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

let root: string;
let child: IPty | undefined;
let terminal: xterm.Terminal | undefined;
let server: Server | undefined;
let tmuxSocket: string | undefined;
afterEach(async () => {
  child?.kill(); child = undefined;
  if (tmuxSocket) { try { execFileSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch {} }
  tmuxSocket = undefined;
  terminal?.dispose(); terminal = undefined;
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});

it.skipIf(!process.env.BOTMUX_CODEX_TRANSCRIPT_TEST_BIN).each(['pty', 'tmux'] as const)('real Codex %s: viewer and backtrack recover, inputs execute exactly once', async transport => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-codex-transcript-e2e-')));
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  const cwd = join(root, 'work');
  mkdirSync(codexHome, { recursive: true }); mkdirSync(cwd);
  vi.stubEnv('CODEX_HOME', codexHome);
  let requests = 0;
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
      requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of buildOpenAiResponsesTextEvents({ text: 'fixture completed' })) {
        const data = JSON.parse(event.data);
        if (data.item?.type === 'message') data.item.phase = 'final_answer';
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
      res.end();
    });
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const args = [
    '--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox',
    '-c', 'check_for_update_on_startup=false', '-c', 'model_provider="fixture"',
    '-c', `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${port}/v1",wire_api="responses"}`,
    '-c', `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`,
  ];
  const env = { HOME: home, CODEX_HOME: codexHome, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'en_US.UTF-8' };
  let target: PtyHandle;
  let capture: () => { viewport: string; cursor: { x: number; y: number } };
  if (transport === 'tmux') {
    tmuxSocket = `transcript-${process.pid}-${Date.now()}`;
    execFileSync('tmux', ['-L', tmuxSocket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-x', '100', '-y', '30', '-c', cwd,
      '/usr/bin/env', '-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), process.env.BOTMUX_CODEX_TRANSCRIPT_TEST_BIN!, ...args]);
    const backend = new TmuxPipeBackend('fixture', { socketName: tmuxSocket });
    backend.cliPid = Number(execFileSync('tmux', ['-L', tmuxSocket, 'display-message', '-p', '-t', 'fixture', '#{pane_pid}'], { encoding: 'utf8' }).trim());
    target = backend;
    capture = () => backend.captureInputState() ?? { viewport: '', cursor: { x: 0, y: 0 } };
  } else {
    terminal = new xterm.Terminal({ cols: 100, rows: 30, allowProposedApi: true });
    child = spawn(process.env.BOTMUX_CODEX_TRANSCRIPT_TEST_BIN!, args, { cols: 100, rows: 30, cwd, env });
    child.onData(data => terminal!.write(data));
    terminal.onData(data => child!.write(data));
    capture = () => {
      const buffer = terminal!.buffer.active;
      return { viewport: Array.from({ length: terminal!.rows }, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true) ?? '').join('\n'), cursor: { x: buffer.cursorX, y: buffer.cursorY } };
    };
    target = { cliPid: child.pid, write: data => child!.write(data), captureInputState: capture };
  }
  const waitFor = async (condition: () => boolean) => {
    const end = Date.now() + 10_000;
    while (!condition() && Date.now() < end) await delay(50);
    expect(condition(), `requests=${requests} cursor=${JSON.stringify(capture().cursor)}\n${capture().viewport}`).toBe(true);
  };
  const adapter = createCodexAdapter();
  await waitFor(() => codexNativeComposerState(capture()) === 'empty' && adapter.startupReadyPattern!.test(capture().viewport));
  await delay(500);
  const nativeEvents = () => {
    const directory = join(codexHome, 'sessions');
    return readdirSync(directory, { recursive: true }).filter(name => String(name).endsWith('.jsonl'))
      .flatMap(name => readFileSync(join(directory, String(name)), 'utf8').split('\n').flatMap(line => {
        try { const row = JSON.parse(line); return row.type === 'event_msg' ? [row.payload.type] : []; } catch { return []; }
      }));
  };
  const messages = ['fixture seed', 'Inspect the change  \nRun its tests.', 'large fixture '.repeat(150).trimEnd()];
  for (let i = 0; i < messages.length; i++) {
    if (i > 0) {
      target.write('\x14');
      await waitFor(() => capture().viewport.startsWith('/ T R A N S C R I P T'));
      if (i === 2) { target.write('\x1b'); await waitFor(() => capture().viewport.includes('to edit message')); }
    }
    const result = await adapter.writeInput(target, messages[i]!);
    expect(result, `input ${i}: ${JSON.stringify(result)}\n${JSON.stringify(capture())}`).toMatchObject({ submitted: true });
    await waitFor(() => nativeEvents().filter(type => type === 'task_complete').length === i + 1 && codexNativeComposerState(capture()) === 'empty');
  }
  await delay(1000); // No late Enter or duplicated model execution.
  const history = readFileSync(join(codexHome, 'history.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).text);
  expect(history).toEqual(messages);
  expect(nativeEvents().filter(type => type === 'task_started')).toHaveLength(messages.length);
  expect(nativeEvents().filter(type => type === 'task_complete')).toHaveLength(messages.length);
  expect(requests).toBeGreaterThanOrEqual(messages.length);
}, 60_000);
