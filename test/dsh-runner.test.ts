/**
 * dsh-runner integration tests: spawn the real runner against the fake dsh
 * SDK JSON-RPC server (test/fixtures/fake-dsh-server.mjs).
 *
 * Run: pnpm vitest run test/dsh-runner.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTsScript } from './helpers/ts-runner.js';

const RUNNER_PATH = resolve('src/dsh-runner.ts');
const FAKE_SERVER = resolve('test/fixtures/fake-dsh-server.mjs');
const CONTROL_PREFIX = '::botmux-dsh:';

interface Harness {
  child: ChildProcessWithoutNullStreams;
  home: string;
  logPath: string;
  stdout: string;
  stderr: string;
}

const liveChildren = new Set<ChildProcessWithoutNullStreams>();

function makeFrame(content: string): string {
  return `${CONTROL_PREFIX}${Buffer.from(JSON.stringify({ type: 'message', content }), 'utf8').toString('base64')}\n`;
}

function parseMarkers(stdout: string): Array<{ kind: string; payload: any }> {
  const markers: Array<{ kind: string; payload: any }> = [];
  const re = /\x1b\]777;botmux:([a-z][a-z0-9_-]*):([A-Za-z0-9+/=]+)\x07/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout))) {
    markers.push({ kind: m[1], payload: JSON.parse(Buffer.from(m[2], 'base64').toString('utf8')) });
  }
  return markers;
}

async function waitFor(
  get: () => boolean,
  { timeout = 15_000, interval = 50, label = 'condition' }: { timeout?: number; interval?: number; label?: string } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (get()) return;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function spawnRunner(
  scenario: string,
  extraArgs: string[] = [],
  envOverrides: NodeJS.ProcessEnv = {},
  homeOverride?: string,
): Harness {
  const home = homeOverride ?? mkdtempSync(join(tmpdir(), 'dsh-runner-test-'));
  const logPath = join(home, 'prompts.jsonl');
  const child = spawnTsScript(RUNNER_PATH, [
    '--session-id', 'test-session',
    '--dsh-bin', FAKE_SERVER,
    '--cwd', home,
    '--bot-name', 'TestBot',
    ...extraArgs,
  ], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: home,
      DSH_HOME: join(home, '.dsh'),
      FAKE_DSH_SCENARIO: scenario,
      FAKE_DSH_LOG: logPath,
      DSH_CORDIS_CONFIG: '',
      ...envOverrides,
    },
  }) as ChildProcessWithoutNullStreams;
  liveChildren.add(child);
  const h: Harness = { child, home, logPath, stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { h.stdout += d; });
  child.stderr.on('data', (d: string) => { h.stderr += d; });
  child.on('exit', () => liveChildren.delete(child));
  return h;
}

function readLog(h: Harness): any[] {
  if (!existsSync(h.logPath)) return [];
  return readFileSync(h.logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

/** Only the session/prompt entries (initialize and phase markers filtered out). */
function readPrompts(h: Harness): any[] {
  return readLog(h).filter((r: any) => r.prompt);
}

/** Write a native ~/.dsh/settings.yaml + optional .credentials.yaml in the test HOME. */
function writeNativeDshConfig(home: string, settingsYaml: string, credentialsYaml?: string): void {
  const dshDir = join(home, '.dsh');
  mkdirSync(dshDir, { recursive: true });
  writeFileSync(join(dshDir, 'settings.yaml'), settingsYaml, 'utf8');
  if (credentialsYaml !== undefined) {
    writeFileSync(join(dshDir, '.credentials.yaml'), credentialsYaml, 'utf8');
  }
}

const SUPER_RELAY_SETTINGS = `
llm-pi-ai:
  providers:
    super-relay:
      apiKeyEnv: SUPER_RELAY_API_KEY
      api: openai-completions
      baseURL: https://super-relay.example.com/v1
      models:
        - id: model_hub/es1_orange_o48
          name: es1_orange_o48
          contextWindow: 1000000
agent-default-model:
  provider: super-relay
  model: model_hub/es1_orange_o48
`;

describe('dsh-runner', () => {
  let h: Harness | undefined;

  beforeEach(() => { h = undefined; });
  afterEach(() => {
    if (h && !h.child.killed) {
      try { h.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });
  afterEach(() => {
    for (const child of liveChildren) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    liveChildren.clear();
  });

  it('boots, runs a turn, and delivers the final text with usage', async () => {
    h = spawnRunner('happy');
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    h.child.stdin.write(makeFrame('你好'));
    await waitFor(() => parseMarkers(h.stdout).some(m => m.kind === 'final'), { label: 'final marker' });

    const final = parseMarkers(h.stdout).find(m => m.kind === 'final')!;
    expect(final.payload.content).toContain('你好，我是 dsh。');
    expect(final.payload.usage).toEqual({
      inputTokens: 100,
      outputTokens: 42,
      cacheReadTokens: 10,
      cacheCreateTokens: 0,
    });
    // Tool calls render as progress lines.
    expect(h.stdout).toContain('🔧 bash');
    expect(h.stdout).toContain('✓ bash');
    // The profile directory is created under the native dsh home.
    expect(existsSync(join(h.home, '.dsh', 'profiles', 'botmux'))).toBe(true);
    // The legacy ~/.botmux/dsh path must not be created anymore.
    expect(existsSync(join(h.home, '.botmux', 'dsh'))).toBe(false);
  });

  it('passes the question bridge patch to the dsh profile launch', async () => {
    h = spawnRunner('happy', ['--bridge-patch', '/tmp/botmux-bridge.yml']);
    await waitFor(() => h!.stdout.includes('›'), { label: 'ready marker' });

    const argvEntry = readLog(h).find((entry: any) => Array.isArray(entry.argv));
    expect(argvEntry?.argv[0]).toBe('--profile');
    expect(argvEntry?.argv[1]).toBe('botmux');
    expect(argvEntry?.argv).toContain('--patch=/tmp/botmux-bridge.yml');
  });

  it('fails fast when the dsh binary is missing', async () => {
    h = spawnRunner('happy', ['--dsh-bin', '/nonexistent/dsh']);
    const exitPromise = new Promise<number | null>(resolve => h!.child.on('exit', resolve));
    const code = await exitPromise;

    expect(code).toBe(1);
    expect(h.stdout).not.toContain('dsh connected');
    expect(h.stdout).not.toContain('›');
  });

  it('boots with a profile name and reads provider/model from settings.yaml', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-runner-test-'));
    writeNativeDshConfig(home, SUPER_RELAY_SETTINGS);
    h = spawnRunner('happy', ['--dsh-profile', 'botmux'], {}, home);
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    // The profile directory is created and seeded with package.json + cordis.yml
    // so `dsh --profile botmux` can start on a clean HOME.
    const profileDir = join(home, '.dsh', 'profiles', 'botmux');
    expect(existsSync(profileDir)).toBe(true);
    const profilePkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    expect(profilePkg.dependencies['@deepseek-ai/dsh-tool-ask-user']).toBe('^0.1.1-rc.1');
    const profilePatch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
    expect(profilePatch).toContain("id: tool-ask-user");
    expect(profilePatch).toContain("name: '@deepseek-ai/dsh-tool-ask-user'");
    expect(profilePatch.indexOf('id: tool-ask-user')).toBeLessThan(profilePatch.indexOf('id: sdk-jsonrpc-server'));

    // initialize carries the provider + model from settings.yaml.
    const entries = readLog(h);
    const initEntry = entries.find((r: any) => r.initialize);
    expect(initEntry.initialize.provider).toBe('super-relay');
    expect(initEntry.initialize.model).toBe('model_hub/es1_orange_o48');
  });

  it('honors DSH_HOME for profiles, sessions and native settings', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-runner-home-'));
    const dshHome = join(home, 'custom-dsh-home');
    mkdirSync(dshHome, { recursive: true });
    writeFileSync(join(dshHome, 'settings.yaml'), SUPER_RELAY_SETTINGS, 'utf8');
    h = spawnRunner('happy', ['--dsh-profile', 'botmux'], { DSH_HOME: dshHome }, home);
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    expect(existsSync(join(dshHome, 'profiles', 'botmux'))).toBe(true);
    expect(existsSync(join(home, '.dsh', 'profiles', 'botmux'))).toBe(false);
    const initEntry = readLog(h).find((r: any) => r.initialize);
    expect(initEntry.initialize.provider).toBe('super-relay');
  });

  it('does not add the botmux-only ask tool to a custom profile', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-runner-test-'));
    writeNativeDshConfig(home, SUPER_RELAY_SETTINGS);
    h = spawnRunner('happy', ['--dsh-profile', 'custom-profile'], {}, home);
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    const profileDir = join(home, '.dsh', 'profiles', 'custom-profile');
    const profilePkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    expect(profilePkg.dependencies['@deepseek-ai/dsh-tool-ask-user']).toBeUndefined();
    const profilePatch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
    expect(profilePatch).not.toContain('id: tool-ask-user');
  });

  it('migrates a pre-ask-tool botmux profile so the model can ask questions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-runner-test-'));
    writeNativeDshConfig(home, SUPER_RELAY_SETTINGS);
    const profileDir = join(home, '.dsh', 'profiles', 'botmux');
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-botmux',
      private: true,
      dependencies: {
        '@deepseek-ai/dsh-sdk-jsonrpc-server': '^0.1.1-rc.1',
        '@deepseek-ai/dsh-sdk-protocol': '^0.1.1-rc.1',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, null, 2) + '\n', 'utf8');
    writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8');
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '# DSH profile: botmux (headless JSON-RPC server)',
      '# Auto-generated by botmux. dsh-base provides the full plugin tree;',
      '- insert:',
      '    - id: sdk-jsonrpc-server',
      "      name: '@deepseek-ai/dsh-sdk-jsonrpc-server'",
      '',
    ].join('\n'), 'utf8');

    h = spawnRunner('happy', [], {}, home);
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    const migratedPkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    expect(migratedPkg.dependencies['@deepseek-ai/dsh-tool-ask-user']).toBe('^0.1.1-rc.1');
    const migratedPatch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
    expect(migratedPatch).toContain("id: tool-ask-user");
    expect(migratedPatch).toContain("name: '@deepseek-ai/dsh-tool-ask-user'");
    expect(migratedPatch.indexOf('id: tool-ask-user')).toBeLessThan(migratedPatch.indexOf('id: sdk-jsonrpc-server'));
  });

  it('injects the identity preamble only on the first turn (multi-turn)', async () => {
    h = spawnRunner('happy');
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    h.child.stdin.write(makeFrame('第一句'));
    await waitFor(() => parseMarkers(h.stdout).filter(m => m.kind === 'final').length >= 1, { label: 'first final' });
    h.child.stdin.write(makeFrame('第二句'));
    await waitFor(() => parseMarkers(h.stdout).filter(m => m.kind === 'final').length >= 2, { label: 'second final' });

    const prompts = readPrompts(h);
    expect(prompts).toHaveLength(2);
    const firstText = prompts[0].prompt.contentBlocks[0].text;
    const secondText = prompts[1].prompt.contentBlocks[0].text;
    expect(firstText).toContain('<botmux_identity>');
    expect(firstText).toContain('TestBot');
    expect(firstText).toContain('第一句');
    expect(secondText).not.toContain('<botmux_identity>');
    expect(secondText).toBe('第二句');
  });

  it('delivers a JSON-RPC error as a final message', async () => {
    h = spawnRunner('error');
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    h.child.stdin.write(makeFrame('触发错误'));
    await waitFor(() => parseMarkers(h.stdout).some(m => m.kind === 'final'), { label: 'final marker' });

    const final = parseMarkers(h.stdout).find(m => m.kind === 'final')!;
    expect(final.payload.content).toContain('boom');
  });

  it('emits an empty final when the agent produces no text', async () => {
    h = spawnRunner('empty');
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    h.child.stdin.write(makeFrame('只调工具'));
    await waitFor(() => parseMarkers(h.stdout).some(m => m.kind === 'final'), { label: 'final marker' });

    const final = parseMarkers(h.stdout).find(m => m.kind === 'final')!;
    expect(final.payload.content).toBe('');
    expect(h.stdout).toContain('completed without text output');
  });

  it('takes only the last assistant message as the final text and accumulates usage', async () => {
    h = spawnRunner('multi-step');
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    h.child.stdin.write(makeFrame('多步任务'));
    await waitFor(() => parseMarkers(h.stdout).some(m => m.kind === 'final'), { label: 'final marker' });

    const final = parseMarkers(h.stdout).find(m => m.kind === 'final')!;
    // The intermediate step text must not leak into the reply.
    expect(final.payload.content).toBe('你好，我是 dsh。');
    expect(final.payload.content).not.toContain('中间步骤');
    // Per-model-call usage accumulates into a turn total.
    expect(final.payload.usage).toEqual({
      inputTokens: 150,
      outputTokens: 50,
      cacheReadTokens: 7,
      cacheCreateTokens: 4,
    });
  });

  it('surfaces a turn-level error in the final instead of an empty reply', async () => {
    h = spawnRunner('turn-error');
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    h.child.stdin.write(makeFrame('触发 turn 错误'));
    await waitFor(() => parseMarkers(h.stdout).some(m => m.kind === 'final'), { label: 'final marker' });

    const final = parseMarkers(h.stdout).find(m => m.kind === 'final')!;
    expect(final.payload.content).toContain('Authentication Fails');
  });

  it('drops stale notifications that arrive before the inbox receipt', async () => {
    h = spawnRunner('stale');
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    h.child.stdin.write(makeFrame('有旧通知'));
    await waitFor(() => parseMarkers(h.stdout).some(m => m.kind === 'final'), { label: 'final marker' });

    const final = parseMarkers(h.stdout).find(m => m.kind === 'final')!;
    // The stale assistant/message and idle must not settle or pollute this turn.
    expect(final.payload.content).toBe('你好，我是 dsh。');
    expect(final.payload.content).not.toContain('STALE');
    expect(final.payload.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0 });
  });

  it('claims the receipt when notifications arrive before the JSON-RPC response', async () => {
    h = spawnRunner('early-receipt');
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    h.child.stdin.write(makeFrame('通知先到'));
    await waitFor(() => parseMarkers(h.stdout).some(m => m.kind === 'final'), { label: 'final marker' });

    const final = parseMarkers(h.stdout).find(m => m.kind === 'final')!;
    expect(final.payload.content).toContain('你好，我是 dsh。');
    // The fixture logs phase markers: notifications must precede the response.
    const phases = readLog(h).filter((r: any) => r.phase).map((r: any) => r.phase);
    expect(phases).toEqual(['notifications', 'response']);
  });

  it('keeps the identity preamble for the retry after a rejected first prompt', async () => {
    h = spawnRunner('retry');
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    h.child.stdin.write(makeFrame('第一次'));
    await waitFor(() => parseMarkers(h.stdout).filter(m => m.kind === 'final').length >= 1, { label: 'error final' });
    const errorFinal = parseMarkers(h.stdout).find(m => m.kind === 'final')!;
    expect(errorFinal.payload.content).toContain('boom');

    h.child.stdin.write(makeFrame('第二次'));
    await waitFor(() => parseMarkers(h.stdout).filter(m => m.kind === 'final').length >= 2, { label: 'success final' });

    const prompts = readPrompts(h);
    expect(prompts).toHaveLength(2);
    // The first prompt was rejected, so the second one is still the first
    // EXECUTED turn and must carry the identity preamble.
    expect(prompts[1].prompt.contentBlocks[0].text).toContain('<botmux_identity>');
    expect(prompts[1].prompt.contentBlocks[0].text).toContain('第二次');
  });

  it('rejects a prompt ACK without a message id instead of waiting for the turn watchdog', async () => {
    h = spawnRunner('bad-prompt-ack', ['--turn-timeout-ms', '10000']);
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    h.child.stdin.write(makeFrame('第一次'));
    await waitFor(() => parseMarkers(h.stdout).filter(m => m.kind === 'final').length >= 1, {
      timeout: 3000,
      label: 'protocol error final',
    });
    const errorFinal = parseMarkers(h.stdout).find(m => m.kind === 'final')!;
    expect(errorFinal.payload.content).toContain('session/prompt returned no message id');

    h.child.stdin.write(makeFrame('第二次'));
    await waitFor(() => parseMarkers(h.stdout).filter(m => m.kind === 'final').length >= 2, { label: 'success final' });

    const prompts = readPrompts(h);
    expect(prompts).toHaveLength(2);
    expect(prompts[1].prompt.contentBlocks[0].text).toContain('<botmux_identity>');
    expect(prompts[1].prompt.contentBlocks[0].text).toContain('第二次');
  });

  it('rejects an initialize response without a server identity', async () => {
    h = spawnRunner('bad-initialize');
    const exitPromise = new Promise<number | null>(resolve => h!.child.on('exit', resolve));
    const code = await exitPromise;

    expect(code).toBe(1);
    expect(h.stderr).toContain('initialize returned no server identity');
    expect(h.stdout).not.toContain('dsh connected');
    expect(h.stdout).not.toContain('›');
  });

  it('reaps a wedged turn with the watchdog and exits for restart', async () => {
    h = spawnRunner('hang', ['--turn-timeout-ms', '500']);
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    const exitPromise = new Promise<number | null>(resolve => h!.child.on('exit', resolve));
    h.child.stdin.write(makeFrame('卡住了'));
    const code = await exitPromise;
    expect(code).toBe(1);

    const final = parseMarkers(h.stdout).find(m => m.kind === 'final')!;
    expect(final.payload.content).toContain('timed out');
  }, 30_000);

  // -------------------------------------------------------------------------
  // Native ~/.dsh config (settings.yaml + .credentials.yaml)
  // -------------------------------------------------------------------------

  it('reads pi-ai provider/model from ~/.dsh/settings.yaml for the initialize RPC', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-runner-test-'));
    writeNativeDshConfig(home, SUPER_RELAY_SETTINGS, 'SUPER_RELAY_API_KEY: test-key-123\n');
    h = spawnRunner('happy', [], {}, home);
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    // The profile directory is created under the native dsh home.
    expect(existsSync(join(home, '.dsh', 'profiles', 'botmux'))).toBe(true);
    // No legacy ~/.botmux/dsh.
    expect(existsSync(join(home, '.botmux', 'dsh'))).toBe(false);

    // initialize carries the provider + model from settings.yaml.
    const entries = readLog(h);
    const initEntry = entries.find((r: any) => r.initialize);
    expect(initEntry.initialize.provider).toBe('super-relay');
    expect(initEntry.initialize.model).toBe('model_hub/es1_orange_o48');

    h.child.stdin.write(makeFrame('你好'));
    await waitFor(() => parseMarkers(h.stdout).some(m => m.kind === 'final'), { label: 'final marker' });
  });

  it('passes versioned credential refs to the dsh child without exposing records', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-runner-test-'));
    writeNativeDshConfig(home, SUPER_RELAY_SETTINGS, `
version: 1
refs:
  SUPER_RELAY_API_KEY: cred-from-versioned-file
records:
  llm-pi-ai/super-relay:
    kind: grant
    payload:
      access: must-not-be-an-env-value
`);
    h = spawnRunner('happy', [], {
      SUPER_RELAY_API_KEY: undefined,
      FAKE_DSH_EXPECT_ENV_JSON: JSON.stringify({ SUPER_RELAY_API_KEY: 'cred-from-versioned-file' }),
      FAKE_DSH_EXPECT_ABSENT_ENV: 'records',
    }, home);
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    expect(existsSync(join(home, '.dsh', 'profiles', 'botmux'))).toBe(true);
  });

  it('retains support for pre-release flat credential files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-runner-test-'));
    writeNativeDshConfig(home, SUPER_RELAY_SETTINGS, 'SUPER_RELAY_API_KEY: cred-from-flat-file\n');
    h = spawnRunner('happy', [], {
      SUPER_RELAY_API_KEY: undefined,
      FAKE_DSH_EXPECT_ENV_JSON: JSON.stringify({ SUPER_RELAY_API_KEY: 'cred-from-flat-file' }),
    }, home);
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });
  });

  it('parses flat credential files with YAML comments through the bundled parser', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-runner-test-'));
    writeNativeDshConfig(home, SUPER_RELAY_SETTINGS, 'SUPER_RELAY_API_KEY: cred-from-flat-file  # production key\n');
    h = spawnRunner('happy', [], {
      SUPER_RELAY_API_KEY: undefined,
      FAKE_DSH_EXPECT_ENV_JSON: JSON.stringify({ SUPER_RELAY_API_KEY: 'cred-from-flat-file' }),
    }, home);
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });
  });

  it('keeps yaml as a static import so bun --compile bundles the real parser', () => {
    const source = readFileSync(RUNNER_PATH, 'utf8');
    expect(source).toContain("from 'yaml'");
    expect(source).not.toContain("req('yaml')");
    expect(source).not.toContain('parseMinimalYaml');
  });

  it('lets ambient credentials override the versioned credential file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-runner-test-'));
    writeNativeDshConfig(home, SUPER_RELAY_SETTINGS, `
version: 1
refs:
  SUPER_RELAY_API_KEY: cred-from-file
  EMPTY_CREDENTIAL: ''
`);
    h = spawnRunner('happy', [], {
      SUPER_RELAY_API_KEY: 'cred-from-environment',
      FAKE_DSH_EXPECT_ENV_JSON: JSON.stringify({ SUPER_RELAY_API_KEY: 'cred-from-environment' }),
      FAKE_DSH_EXPECT_ABSENT_ENV: 'EMPTY_CREDENTIAL',
    }, home);
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });
  });

  it('lets --model argv override the settings.yaml model', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-runner-test-'));
    writeNativeDshConfig(home, SUPER_RELAY_SETTINGS);
    h = spawnRunner('happy', ['--model', 'custom-model'], {}, home);
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    const entries = readLog(h);
    const initEntry = entries.find((r: any) => r.initialize);
    expect(initEntry.initialize.model).toBe('custom-model');
    expect(initEntry.initialize.provider).toBe('super-relay');
  });

  it('falls back to deepseek-official provider when settings.yaml is missing agent-default-model', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-runner-test-'));
    writeNativeDshConfig(home, `
llm-pi-ai:
  providers:
    super-relay:
      apiKeyEnv: SUPER_RELAY_API_KEY
`);
    h = spawnRunner('happy', [], {}, home);
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    const entries = readLog(h);
    const initEntry = entries.find((r: any) => r.initialize);
    expect(initEntry.initialize.provider).toBe('deepseek-official');
    expect(initEntry.initialize.model).toBe('deepseek-v4-flash');
  });

  it('passes the provider from settings.yaml to the initialize RPC even when it is not in llm-pi-ai.providers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-runner-test-'));
    writeNativeDshConfig(home, `
llm-pi-ai:
  providers:
    other-provider:
      apiKeyEnv: OTHER_KEY
agent-default-model:
  provider: super-relay
  model: some-model
`);
    h = spawnRunner('happy', [], {}, home);
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    const entries = readLog(h);
    const initEntry = entries.find((r: any) => r.initialize);
    // The runner no longer validates provider against llm-pi-ai.providers —
    // the dsh --profile CLI handles plugin composition independently.
    expect(initEntry.initialize.provider).toBe('super-relay');
    expect(initEntry.initialize.model).toBe('some-model');
  });

  it('passes deepseek-official provider/model from settings.yaml to the initialize RPC', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-runner-test-'));
    writeNativeDshConfig(home, `
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-pro
`);
    h = spawnRunner('happy', [], {}, home);
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    const entries = readLog(h);
    const initEntry = entries.find((r: any) => r.initialize);
    expect(initEntry.initialize.provider).toBe('deepseek-official');
    expect(initEntry.initialize.model).toBe('deepseek-v4-pro');
  });
});
