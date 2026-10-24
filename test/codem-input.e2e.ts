/**
 * Opt-in real CodeM smoke; never starts a daemon or edits a bot configuration.
 * Requires an installed, logged-in CodeM. All session writes use a unique
 * LINCO_HOME + LINCO_SESSIONS_ROOT; CODEM_HOME retains the existing auth root.
 * Run: BOTMUX_CODEM_E2E=1 vitest run --project e2e test/codem-input.e2e.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodemAdapter } from '../src/adapters/cli/codem.js';
import { resolveCommandReal } from '../src/adapters/cli/registry.js';
import { PtyBackend } from '../src/adapters/backend/pty-backend.js';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { prepareDirectSandbox } from '../src/adapters/backend/sandbox.js';
import { buildFsPolicy } from '../src/adapters/cli/fs-policy.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import type { SessionBackend } from '../src/adapters/backend/types.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const roots: string[] = [];
const cleanup: Array<() => void> = [];

afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) stop();
  await pause(1000);
  for (const root of roots.splice(0)) {
    if (process.env.BOTMUX_CODEM_KEEP_E2E === '1') console.log(`CodeM isolated smoke artifacts: ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-codem-native-')));
  roots.push(root);
  const cwd = join(root, 'project');
  const lincoHome = join(root, 'core');
  mkdirSync(cwd);
  mkdirSync(lincoHome);
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => value !== undefined && !key.startsWith('BOTMUX_'))) as Record<string, string>;
  Object.assign(env, {
    CODEM_HOME: process.env.CODEM_HOME || join(homedir(), '.codem'),
    LINCO_HOME: lincoHome,
    LINCO_SESSIONS_ROOT: join(lincoHome, 'sessions'),
    LINCO_TRACE_FILE: join(root, 'core.log'),
    BOTMUX_HOME: join(root, 'botmux'),
    BOTMUX_NO_CLAIM: '1',
  });
  return { root, cwd, env };
}

function records(root: string, id: string): Array<Record<string, unknown>> {
  const directory = join(root, 'core', 'sessions');
  if (!existsSync(directory)) return [];
  for (const project of readdirSync(directory)) {
    const file = join(directory, project, `${id}.jsonl`);
    if (existsSync(file)) return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
  return [];
}

function hasReply(root: string, id: string): boolean {
  // The user's CodeM language setting may translate literal acknowledgements.
  return records(root, id).some(r => r.type === 'assistant_text' && String(r.text || '').trim().length > 0);
}

async function waitFor(probe: () => boolean, what: string, screen: () => string, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (probe()) return;
    await pause(200);
  }
  throw new Error(`CodeM smoke timed out: ${what}\n${screen()}`);
}

async function launch(f: ReturnType<typeof fixture>, id: string, opts: { tmux?: boolean; resumeId?: string; sandbox?: boolean } = {}) {
  const adapter = createCodemAdapter(process.env.CODEM_E2E_BIN);
  const args = adapter.buildArgs({ sessionId: id, resume: !!opts.resumeId, resumeSessionId: opts.resumeId });
  args.push('--no-memory', '--no-memory-update', '--system-prompt',
    'You are a terminal integration diagnostic. Never call tools or write files. Follow the user request concisely.');
  const renderer = new TerminalRenderer(140, 42);
  let backend: SessionBackend;
  if (opts.tmux) {
    backend = new TmuxPipeBackend(`codem-${randomUUID().slice(0, 8)}`, {
      createSession: true, ownsSession: true, socketName: 'codem-native-e2e',
    });
  } else backend = new PtyBackend();
  let bin = adapter.resolvedBin;
  let spawnArgs = args;
  let env = { ...f.env, BOTMUX_SESSION_ID: id };
  if (opts.sandbox) {
    const home = realpathSync(homedir());
    const botmuxHome = join(f.root, 'botmux');
    const data = join(botmuxHome, 'data');
    const botHome = join(botmuxHome, 'bots', 'cli_codem_smoke');
    for (const path of [data, botHome]) mkdirSync(path, { recursive: true });
    const policy = buildFsPolicy({
      platform: 'linux', homeDir: home, botmuxHome, sessionDataDir: data,
      workingDir: f.cwd, currentAppId: 'cli_codem_smoke', sessionId: id, botHome,
      redirectedCliData: false, authPaths: [realpathSync(env.CODEM_HOME)],
      execPaths: [dirname(realpathSync(bin)), dirname(resolveCommandReal('node')), dirname(process.execPath)],
      extraWritePaths: [f.root], net: true, writeRegexes: [],
    });
    policy.rules = policy.rules.filter(rule => rule.access === 'deny' || existsSync(rule.path));
    const plan = prepareDirectSandbox({
      sessionId: id, dataDir: data, policy, chdir: f.cwd, home,
      cliBin: bin, cliArgs: args, tempDir: join(f.root, 'tmp'),
    });
    if (!plan) throw new Error('CodeM sandbox smoke requires functional bubblewrap');
    cleanup.push(plan.cleanup);
    bin = plan.bin;
    spawnArgs = plan.args;
    env = { ...env, ...plan.env, CODEM_HOME: realpathSync(env.CODEM_HOME) };
  }
  cleanup.push(() => renderer.dispose());
  cleanup.push(() => backend.kill());
  const idle = new IdleDetector(adapter, () => renderer.rawSnapshot());
  let ready = false;
  idle.onIdle(() => { ready = true; });
  cleanup.push(() => idle.dispose());
  backend.spawn(bin, spawnArgs, { cwd: f.cwd, cols: 140, rows: 42, env });
  renderer.xterm.onData(data => backend.write(data));
  backend.onData(data => { renderer.write(data); idle.feed(data); });
  let exited = false;
  backend.onExit(() => { exited = true; });
  const screen = () => renderer.rawSnapshot();
  await waitFor(() => records(f.root, opts.resumeId || id).some(r => r.type === 'header'), 'session startup', screen);
  await waitFor(() => ready, 'native prompt ready', screen);
  expect(exited, screen()).toBe(false);
  return { adapter, backend, screen, alive: () => !exited };
}

describe.runIf(process.env.BOTMUX_CODEM_E2E === '1')('CodeM real isolated terminals', () => {
  it('submits multiline input, restores exact history and isolates another topic', async () => {
    const f = fixture();
    const a = `codem-a-${randomUUID()}`;
    const marker = `CODEM_${randomUUID().replaceAll('-', '')}`;
    const first = await launch(f, a);
    const prompt = `Remember the exact marker ${marker}.\nReply with just SAVED.`;
    await first.adapter.writeInput(first.backend, prompt);
    await waitFor(() => hasReply(f.root, a), 'first model reply', first.screen);
    const userMessages = records(f.root, a).filter(r => r.type === 'user_message' && r.origin !== 'synthetic');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe(prompt);
    first.backend.kill();
    await pause(1200);

    const resumed = await launch(f, a, { resumeId: a });
    await resumed.adapter.writeInput(resumed.backend, 'Reply with only the exact marker I asked you to remember.');
    await waitFor(() => records(f.root, a).some(r => r.type === 'assistant_text' && String(r.text).includes(marker)), 'restored memory', resumed.screen);
    expect(records(f.root, a).filter(r => r.type === 'header')).toHaveLength(1);
    resumed.backend.kill();
    await pause(1200);

    const b = `codem-b-${randomUUID()}`;
    const sibling = await launch(f, b);
    await sibling.adapter.writeInput(sibling.backend, 'Reply with only FRESH_TOPIC.');
    await waitFor(() => hasReply(f.root, b), 'sibling reply', sibling.screen);
    expect(JSON.stringify(records(f.root, b))).not.toContain(marker);
  }, 240_000);

  it('submits through the real tmux backend on a fenced private server', async () => {
    const f = fixture();
    const id = `codem-tmux-${randomUUID()}`;
    const session = await launch(f, id, { tmux: true });
    await session.adapter.writeInput(session.backend, 'Reply with only TMUX_NATIVE_OK.\nUse no tools.');
    await waitFor(() => hasReply(f.root, id), 'tmux reply', session.screen);
    expect(records(f.root, id).filter(r => r.type === 'user_message' && r.origin !== 'synthetic'))
      .toMatchObject([{ content: 'Reply with only TMUX_NATIVE_OK.\nUse no tools.' }]);
  }, 120_000);

  it.runIf(process.platform === 'linux')('keeps sandbox runtime and session writes alive for 90 seconds', async () => {
    const f = fixture();
    const id = `codem-sandbox-${randomUUID()}`;
    const started = Date.now();
    const session = await launch(f, id, { sandbox: true });
    await session.adapter.writeInput(session.backend, 'Reply with only SANDBOX_NATIVE_OK.');
    await waitFor(() => hasReply(f.root, id), 'sandbox reply', session.screen);
    await pause(Math.max(0, 90_000 - (Date.now() - started)));
    expect(session.alive(), session.screen()).toBe(true);
    expect(records(f.root, id).some(r => r.type === 'user_message')).toBe(true);
  }, 180_000);
});
