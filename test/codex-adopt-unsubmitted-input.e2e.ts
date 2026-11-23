/** Opt-in native CLI acceptance for adopt attribution. Uses an empty HOME and a
 * loopback model fixture; never reads host credentials, talks to Lark, or
 * starts a shared daemon. Reproduces: a slash typo Codex refuses to submit, a
 * passthrough /clear, then a real message, in one adopted tmux pane.
 * BOTMUX_CODEX_TRANSCRIPT_TEST_BIN=/path/to/codex bun x vitest run --project e2e test/codex-adopt-unsubmitted-input.e2e.ts */
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { writeRawCommandLine } from '../src/core/raw-command-writer.js';
import { codexNativeComposerState } from '../src/services/codex-terminal-session.js';
import { CodexBridgeQueue, STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS } from '../src/services/codex-bridge-queue.js';
import { drainCodexRollout } from '../src/services/codex-transcript.js';
import { buildOpenAiResponsesTextEvents } from './helpers/mock-llm-server/openai-responses-sse.js';

let root: string;
let server: Server | undefined;
let tmuxSocket: string | undefined;
afterEach(async () => {
  if (tmuxSocket) { try { execFileSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch {} }
  tmuxSocket = undefined;
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});

it.skipIf(!process.env.BOTMUX_CODEX_TRANSCRIPT_TEST_BIN)('real Codex adopt: a slash typo it never submitted does not take the next message\'s reply', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-codex-adopt-typo-e2e-')));
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  const cwd = join(root, 'work');
  mkdirSync(codexHome, { recursive: true }); mkdirSync(cwd);
  // Codex opens every conversation with this file as a role=user record.
  execFileSync('/bin/sh', ['-c', 'printf "%s\\n" "# Repo rules" "继续之前先跑 test。" > AGENTS.md'], { cwd });
  vi.stubEnv('CODEX_HOME', codexHome);
  let requests = 0;
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
      requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of buildOpenAiResponsesTextEvents({ text: 'downloaded to data/my' })) {
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
  tmuxSocket = `adopt-typo-${process.pid}-${Date.now()}`;
  execFileSync('tmux', ['-L', tmuxSocket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-x', '100', '-y', '30', '-c', cwd,
    '/usr/bin/env', '-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), process.env.BOTMUX_CODEX_TRANSCRIPT_TEST_BIN!, ...args]);
  const backend = new TmuxPipeBackend('fixture', { socketName: tmuxSocket });
  backend.cliPid = Number(execFileSync('tmux', ['-L', tmuxSocket, 'display-message', '-p', '-t', 'fixture', '#{pane_pid}'], { encoding: 'utf8' }).trim());
  const capture = () => backend.captureInputState() ?? { viewport: '', cursor: { x: 0, y: 0 } };
  // `stablePolls`: Codex redraws right after startup, so a screen that is ready
  // for one poll can be gone on the next; require it to hold.
  const waitFor = async (condition: () => boolean, ms = 15_000, stablePolls = 1) => {
    const end = Date.now() + ms;
    let streak = 0;
    while (Date.now() < end) {
      streak = condition() ? streak + 1 : 0;
      if (streak >= stablePolls) return;
      await delay(100);
    }
    expect.fail(`requests=${requests} ${JSON.stringify(capture())}`);
  };
  const rollouts = () => {
    const directory = join(codexHome, 'sessions');
    try {
      return readdirSync(directory, { recursive: true }).map(String).filter(name => name.endsWith('.jsonl'))
        .map(name => join(directory, name));
    } catch { return []; }
  };
  const userTexts = () => rollouts().flatMap(file => readFileSync(file, 'utf8').split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line);
      return row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user'
        ? [row.payload.content.map((block: { text?: string }) => block.text ?? '').join('')] : [];
    } catch { return []; }
  }));
  const adapter = createCodexAdapter();
  // Codex >= 0.169 dropped the boxed header startupReadyPattern keys on; an
  // empty native composer under the banner is the readiness this needs.
  // One capture per poll: both checks must describe the same screen.
  await waitFor(() => {
    const screen = capture();
    return codexNativeComposerState(screen) === 'empty' && screen.viewport.includes('OpenAI Codex');
  }, 15_000, 10);
  await delay(500);

  const queue = new CodexBridgeQueue();
  queue.setLocalTurns(true, Date.now() - 1000);
  queue.setWholeInputPassing(true); // as the worker does for adopted Codex

  // 1. The typo, written the way an adopt Lark turn is: marked, then writeInput.
  queue.mark('typo', '/cleat');
  queue.beginSubmitVerification('typo');
  const typo = await adapter.writeInput(backend, '/cleat');
  await delay(1500);

  // 2. The passthrough /clear: a raw command line, as the worker sends it.
  expect(await writeRawCommandLine(backend, '/clear')).toBe(true);
  await waitFor(() => codexNativeComposerState(capture()) === 'empty');
  await delay(1000);

  // 3. The real message.
  const ask = 'https://example.feishu.cn/wiki/AAA 这里有一个文档，你看一下里面的压缩包能不能下载到本地';
  queue.mark('ask', ask);
  queue.beginSubmitVerification('ask');
  expect(await adapter.writeInput(backend, ask), JSON.stringify(capture())).toMatchObject({ submitted: true });
  const rolloutWithAsk = () => rollouts().find(file => readFileSync(file, 'utf8').includes('"task_complete"')
    && readFileSync(file, 'utf8').includes('wiki/AAA'));
  await waitFor(() => rolloutWithAsk() !== undefined, 30_000);
  await delay(500);

  // Precondition of the scenario: Codex never submitted the typo.
  expect(userTexts().some(text => text.includes('/cleat')), `typo write result: ${JSON.stringify(typo)}`).toBe(false);

  // The bridge reads the rollout as an adopt worker does.
  queue.ingest(drainCodexRollout(rolloutWithAsk()!, 0).events);
  const ready = queue.drainEmittable();
  expect(ready.map(turn => ({ turnId: turn.turnId, isLocal: turn.isLocal === true, finalText: turn.finalText })))
    .toEqual([{ turnId: 'ask', isLocal: false, finalText: 'downloaded to data/my' }]);
  expect(queue.hasBlockingTurn()).toBe(false);
  // Retired once its own submit check (opened at its write) has run out.
  expect(queue.pruneExpiredPreStartHeads(Date.now() + STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS + 1).map(turn => turn.turnId)).toEqual(['typo']);
}, 120_000);
