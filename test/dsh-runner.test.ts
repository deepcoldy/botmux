/**
 * dsh-runner integration tests: spawn the real runner against the fake dsh
 * SDK JSON-RPC server (test/fixtures/fake-dsh-server.mjs).
 *
 * Run: pnpm vitest run test/dsh-runner.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
): Harness {
  const home = mkdtempSync(join(tmpdir(), 'dsh-runner-test-'));
  const logPath = join(home, 'prompts.jsonl');
  const child = spawn(process.execPath, ['--import', 'tsx', RUNNER_PATH,
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
      FAKE_DSH_SCENARIO: scenario,
      FAKE_DSH_LOG: logPath,
      DSH_CORDIS_CONFIG: '',
      ...envOverrides,
    },
  });
  liveChildren.add(child);
  const h: Harness = { child, home, logPath, stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { h.stdout += d; });
  child.stderr.on('data', (d: string) => { h.stderr += d; });
  child.on('exit', () => liveChildren.delete(child));
  return h;
}

function readPrompts(h: Harness): any[] {
  if (!existsSync(h.logPath)) return [];
  return readFileSync(h.logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

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
    // The vendored config was materialized under HOME.
    expect(existsSync(join(h.home, '.botmux', 'dsh', 'cordis.yml'))).toBe(true);
  });

  it('fails fast when DSH_CORDIS_CONFIG points to a missing file', async () => {
    const missingConfig = join(tmpdir(), `botmux-dsh-missing-config-${process.pid}-${Date.now()}.yml`);
    h = spawnRunner('happy', [], { DSH_CORDIS_CONFIG: missingConfig });
    const exitPromise = new Promise<number | null>(resolve => h!.child.on('exit', resolve));
    const code = await exitPromise;

    expect(code).toBe(1);
    expect(h.stderr).toContain(`DSH_CORDIS_CONFIG does not exist: ${missingConfig}`);
    expect(h.stdout).not.toContain('dsh connected');
    expect(h.stdout).not.toContain('›');
    expect(existsSync(join(h.home, '.botmux', 'dsh', 'cordis.yml'))).toBe(false);
  });

  it('uses an existing DSH_CORDIS_CONFIG without materializing the vendored config', async () => {
    h = spawnRunner('happy', [], { DSH_CORDIS_CONFIG: FAKE_SERVER });
    await waitFor(() => h.stdout.includes('›'), { label: 'ready marker' });

    h.child.stdin.write(makeFrame('使用显式配置'));
    await waitFor(() => parseMarkers(h.stdout).some(m => m.kind === 'final'), { label: 'final marker' });

    expect(existsSync(join(h.home, '.botmux', 'dsh', 'cordis.yml'))).toBe(false);
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
    const phases = readPrompts(h).filter((r: any) => r.phase).map((r: any) => r.phase);
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
});
