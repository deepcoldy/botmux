/** Opt-in native OpenCode acceptance: a first message over the launch-argument
 * budget is typed while OpenCode is still starting, and must reach the model as
 * soon as the input box is drawn, also under a theme that draws no bottom edge.
 * Empty HOME and a loopback model; never reads host credentials or config.
 * BOTMUX_OPENCODE_E2E_BIN=$(command -v opencode) bun x vitest run --project e2e test/opencode-long-first-prompt.e2e.ts */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import { TMUX_INITIAL_PROMPT_ARG_BUDGET } from '../src/adapters/cli/types.js';
import { buildOpenAiTextEvents, streamOpenAiEvents } from './helpers/mock-llm-server/openai-sse.js';

let root: string | undefined;
let server: Server | undefined;
let tmuxSocket: string | undefined;
afterEach(async () => {
  if (tmuxSocket) { try { execFileSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch {} }
  tmuxSocket = undefined;
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe.skipIf(!process.env.BOTMUX_OPENCODE_E2E_BIN)('real OpenCode', () => it.each([
  ['default theme', undefined],
  ['transparent theme lucent-orng', 'lucent-orng'],
])('a first message over the launch-argument budget, typed during startup, reaches the model once the input box is drawn (%s)', async (_label, theme) => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-opencode-first-prompt-')));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  mkdirSync(home);
  mkdirSync(cwd);
  if (theme) {
    // OpenCode reads the theme from its TUI config file, not OPENCODE_CONFIG_CONTENT.
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.config', 'opencode', 'tui.json'), JSON.stringify({ $schema: 'https://opencode.ai/tui.json', theme }));
  }
  // The adapter checks the submit in the same DB the child writes.
  vi.stubEnv('XDG_DATA_HOME', join(home, '.local', 'share'));
  const requests: Array<{ at: number; body: string }> = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
      requests.push({ at: Date.now(), body });
      void streamOpenAiEvents(res, buildOpenAiTextEvents({ model: 'mock-model', text: 'fixture done' }));
    });
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: 'mock/mock-model',
    autoupdate: false,
    share: 'disabled',
    provider: {
      mock: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Mock LLM',
        options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'mock-test-key' },
        models: { 'mock-model': { name: 'Mock Model' } },
      },
    },
  };
  const env = {
    HOME: home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };
  tmuxSocket = `opencode-first-prompt-${process.pid}-${Date.now()}`;
  execFileSync('tmux', ['-L', tmuxSocket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-x', '160', '-y', '50', '-c', cwd,
    '/usr/bin/env', '-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), process.env.BOTMUX_OPENCODE_E2E_BIN!, '--auto']);
  const backend = new TmuxPipeBackend('fixture', { socketName: tmuxSocket });

  const marker = `ACK-${Date.now()}`;
  const lines = ['<botmux_routing>'];
  while (Buffer.byteLength(lines.join('\n')) <= TMUX_INITIAL_PROMPT_ARG_BUDGET) {
    lines.push(`rule ${lines.length}: reply in this topic with botmux send, never in the terminal.`);
  }
  lines.push('</botmux_routing>', `Reply with ${marker}.`);
  const prompt = lines.join('\n');

  // The model line inside the input box marks when the box is drawn.
  let boxDrawnAt: number | undefined;
  const watchDeadline = Date.now() + 90_000;
  const watching = (async () => {
    while (boxDrawnAt === undefined && Date.now() < watchDeadline) {
      if ((await backend.captureViewportAsync().catch(() => '')).includes('Mock Model Mock LLM')) boxDrawnAt = Date.now();
      else await delay(100);
    }
  })();

  // Typed right after spawn, before OpenCode has drawn anything.
  const result = await createOpenCodeAdapter(process.env.BOTMUX_OPENCODE_E2E_BIN).writeInput(backend, prompt);

  const deadline = Date.now() + 60_000;
  while (!requests.some(r => r.body.includes(marker)) && Date.now() < deadline) await delay(250);
  await watching;
  const request = requests.find(r => r.body.includes(marker));
  expect(request, `requests=${requests.length}\n${await backend.captureViewportAsync()}`).toBeDefined();
  expect(result).toMatchObject({ submitted: true });
  expect(boxDrawnAt).toBeDefined();
  // Far below the 45s input-box wait: the adapter recognised the box.
  expect(request!.at - boxDrawnAt!).toBeLessThan(15_000);
}, 120_000));
