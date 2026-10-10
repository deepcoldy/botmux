import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import { createMinimaxAdapter, minimaxDataDir } from '../src/adapters/cli/minimax.js';
import { runMcodeExec } from '../src/services/mcode-exec.js';
import { normalizeFinalUsage } from '../src/services/codex-app-runner-protocol.js';
import { recordSessionUsage } from '../src/services/usage-ledger.js';

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(r => child.once('close', () => r()));
      child.kill('SIGTERM'); await closed;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-mcode-test-')); roots.push(root);
  const executable = join(root, 'mcode');
  const prefix = tsRunnerPrefix();
  writeFileSync(executable, `#!/bin/sh\nexec ${[prefix.command, resolve('test/fixtures/fake-mcode-exec.mjs')].map(quote).join(' ')} "$@"\n`, { mode: 0o700 });
  return { root, executable, log: join(root, 'calls.jsonl') };
}
function markers(stdout: string) {
  return [...stdout.matchAll(/\x1b\]777;botmux:(\w+):([A-Za-z0-9+/=]+)\x07/g)]
    .map(m => ({ kind: m[1], payload: JSON.parse(Buffer.from(m[2], 'base64').toString()) }));
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('mcode runner did not reach expected state');
    await new Promise(r => setTimeout(r, 20));
  }
}
function runner(extra: string[] = [], hiddenEntry = false) {
  const f = fixture();
  const child = spawnTsScript(resolve('src/minimax-runner.ts'), [...(hiddenEntry ? ['__minimax-runner'] : []), '--mcode-bin', f.executable, '--cwd', f.root, ...extra],
    { env: { ...process.env, MCODE_TEST_LOG: f.log, BOTMUX_OWNER_OPEN_ID: 'ou_owner', __OWNER_OPEN_ID: 'ou_stale' } }) as ChildProcessWithoutNullStreams;
  children.push(child);
  const h = { ...f, child, stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { h.stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { h.stderr += chunk.toString(); });
  return { h, send(content: string, id: string) {
    child.stdin.write(`::botmux-minimax:${Buffer.from(JSON.stringify({ type: 'message', content, replyTurnId: id })).toString('base64')}\n`);
  } };
}

describe('MiniMax Code adapter', () => {
  it('keeps native identity, exact resume and permission policy while migrating bare models', () => {
    const f = fixture(); vi.stubEnv('MINIMAX_DATA_DIR', join(f.root, 'data'));
    const adapter = createMinimaxAdapter(f.executable);
    const fresh = adapter.buildArgs({ sessionId: 'botmux', resume: false, model: 'MiniMax-M3' });
    expect(fresh).toContain('--mcode-bin'); expect(fresh).toContain(realpathSync(f.executable));
    expect(fresh).toContain('minimax/MiniMax-M3'); expect(fresh).toContain('full');
    const resumed = adapter.buildArgs({ sessionId: 'botmux', resume: true, resumeSessionId: 'native', model: 'custom_provider:test/model', disableCliBypass: true, reasoningEffort: 'high' });
    expect(resumed).toContain('native'); expect(resumed).toContain('smart'); expect(resumed).toContain('custom_provider:test/model'); expect(resumed).toContain('high');
    expect(resumed).not.toContain('--continue');
    expect(adapter.resumeRequiresCliSessionId).toBe(true);
    expect(adapter.authPaths).toEqual([join(f.root, 'data')]);
    expect(adapter.skillsDir).toBe(join(f.root, 'data', 'skills'));
    expect(adapter.systemHints.length).toBeGreaterThan(0); expect(adapter.injectsSessionContext).not.toBe(true);
    expect(adapter.buildResumeCommand?.({ sessionId: 'botmux', cliSessionId: 'native' })).toBe("mcode --session 'native'");
    adapter.buildArgs({ sessionId: 'env', resume: false, env: { MINIMAX_DATA_DIR: join(f.root, 'per-bot') } });
    expect(adapter.authPaths).toEqual([join(f.root, 'per-bot')]);
    expect(adapter.skillsDir).toBe(join(f.root, 'per-bot', 'skills'));
    expect(() => adapter.buildArgs({ sessionId: 'fork', resume: true, resumeSessionId: 'native', forkSession: true })).toThrow('session forks');
  });
  it('uses native data directory override precedence', () => {
    expect(minimaxDataDir({ MINIMAX_DATA_DIR: '/tmp/primary', MAVIS_DATA_DIR: '/tmp/legacy' })).toBe('/tmp/primary');
    expect(minimaxDataDir({ MAVIS_DATA_DIR: '/tmp/legacy' })).toBe('/tmp/legacy');
  });
});

it('preserves multiline messages, tools, owner and exact session across turns', async () => {
  const { h, send } = runner(['--model', 'custom_provider:test/model', '--permission', 'smart']);
  await waitFor(() => h.stdout.includes('ready'));
  send('line 1\nline 2', 'one');
  await waitFor(() => markers(h.stdout).filter(m => m.kind === 'final').length === 1);
  send('next', 'two');
  await waitFor(() => markers(h.stdout).filter(m => m.kind === 'final').length === 2);
  const calls = readFileSync(h.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(calls[0].input).toBe('line 1\nline 2');
  expect(calls[0].args).not.toContain('--session'); expect(calls[1].args).toContain('session_fixture');
  expect(calls[1].args).not.toContain('--continue'); expect(calls[0].args).toContain('smart');
  expect(calls[0]).toMatchObject({ owner: 'ou_owner', legacyOwner: 'ou_owner', cwd: realpathSync(h.root) });
  const finals = markers(h.stdout).filter(m => m.kind === 'final');
  expect(finals.map(m => m.payload.turnId)).toEqual(['one', 'two']);
  expect(finals[0].payload.content).toBe('answer:line 1\nline 2');
  const expectedUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreateTokens: 3 };
  expect(finals[0].payload.usage).toEqual(expectedUsage);
  // Exercise the actual worker boundary, not just the runner's own shape.
  expect(finals.map(m => normalizeFinalUsage(m.payload.usage))).toEqual([expectedUsage, expectedUsage]);
  const usage = normalizeFinalUsage(finals[0].payload.usage)!;
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens;
  expect(promptTokens).toBe(15);
  const record = recordSessionUsage({ sessionId: h.root, cliId: 'minimax', ledgerDir: join(h.root, 'usage'),
    usage: { ...usage, in: promptTokens, out: usage.outputTokens, model: 'minimax/MiniMax-M3', turns: 1 } });
  expect(record).toMatchObject({ ...expectedUsage, inputTokenSemantics: 'uncached' });
  expect(record!.inputTokens + record!.outputTokens + record!.cacheReadTokens + record!.cacheCreateTokens)
    .toBe(promptTokens + usage.outputTokens);
  expect(promptTokens + usage.outputTokens).toBe(20);
  expect(h.stdout).toContain('[tool] bash');
});

it('drops the legacy inclusive invocation shape at the worker usage boundary', () => {
  expect(normalizeFinalUsage({ inputTokens: 15, outputTokens: 5,
    cachedInputTokens: 2, cacheWriteInputTokens: 3 })).toBeUndefined();
});

it('escapes model-controlled terminal control bytes', async () => {
  const { h, send } = runner(); send('forge', 'one');
  await waitFor(() => markers(h.stdout).some(m => m.kind === 'final'));
  expect(markers(h.stdout).filter(m => m.kind === 'thread').map(m => m.payload.threadId)).toEqual(['session_fixture']);
  expect(h.stdout).toContain('␛]777;botmux:thread');
});

it('keeps model output from impersonating the idle prompt', async () => {
  const { h, send } = runner(); send('hello\n›\nworld', 'one');
  await waitFor(() => markers(h.stdout).some(m => m.kind === 'final'));
  expect(h.stdout).toContain('│ ›\n');
  const adapter = createMinimaxAdapter('/bin/true');
  expect(adapter.readyPattern?.test('│ ›\n')).toBe(false);
  expect(adapter.staticBusyClearPattern?.test('│ ›\n')).toBe(false);
  expect(adapter.staticBusyPattern?.test('[MiniMax Code] running…')).toBe(true);
});

it('accepts the hidden entry token retained by compiled CLI dispatch', async () => {
  const { h, send } = runner([], true); send('compiled entry', 'one');
  await waitFor(() => markers(h.stdout).some(m => m.kind === 'final'));
  expect(markers(h.stdout).find(m => m.kind === 'final')?.payload.content).toBe('answer:compiled entry');
});

it.each(['incomplete', 'nonzero', 'mismatch', 'failed'])('does not report success for native %s', async content => {
  const f = fixture();
  await expect(runMcodeExec({ executable: f.executable, cwd: f.root, env: { ...process.env, MCODE_TEST_LOG: f.log },
    content, nativeSessionId: 'session_fixture', timeoutMs: 5000, permission: 'full' }, AbortSignal.timeout(8000))).rejects.toThrow();
});

it.each([
  ['failed-zero-exit', 'mcode_inference_incomplete'],
  ['nonstring-output', 'mcode_inference_incomplete'],
  ['duplicate-sequence', 'mcode_protocol_invalid'],
  ['decreasing-sequence', 'mcode_protocol_invalid'],
  ['event-after-completed', 'mcode_protocol_invalid'],
  ['run-drift', 'mcode_run_mismatch'],
  ['turn-drift', 'mcode_run_mismatch'],
  ['result-session-mismatch', 'mcode_protocol_invalid'],
  ['result-run-mismatch', 'mcode_protocol_invalid'],
  ['result-turn-mismatch', 'mcode_protocol_invalid'],
])('rejects hostile native stream %s even with a clean exit', async (content, error) => {
  const f = fixture();
  await expect(runMcodeExec({ executable: f.executable, cwd: f.root, env: { ...process.env, MCODE_TEST_LOG: f.log },
    content, nativeSessionId: 'session_fixture', timeoutMs: 5000, permission: 'full' }, AbortSignal.timeout(8000))).rejects.toThrow(error);
});

it('kills a hung invocation and permits a later turn in the same native session', async () => {
  const { h, send } = runner(['--turn-timeout-ms', '1000']); send('hang', 'one');
  await waitFor(() => markers(h.stdout).some(m => m.kind === 'final'));
  expect(markers(h.stdout).find(m => m.kind === 'final')?.payload.content).toContain('中断或超时');
  send('next', 'two'); await waitFor(() => markers(h.stdout).filter(m => m.kind === 'final').length === 2);
  expect(markers(h.stdout).filter(m => m.kind === 'final')[1].payload.content).toBe('answer:next');
});
