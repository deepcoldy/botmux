import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { readJsonLines } from './helpers/read-json-lines.js';
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
  const child = spawnTsScript(resolve('src/minimax-runner.ts'), [...(hiddenEntry ? ['__minimax-runner'] : []), '--mcode-bin', f.executable, '--cwd', f.root, '--transport', 'exec', ...extra],
    { env: { ...process.env, MCODE_TEST_LOG: f.log, BOTMUX_OWNER_OPEN_ID: 'ou_owner', __OWNER_OPEN_ID: 'ou_stale' } }) as ChildProcessWithoutNullStreams;
  children.push(child);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(r => child.once('close', (code, signal) => r({ code, signal })));
  const h = { ...f, child, closed, stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { h.stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { h.stderr += chunk.toString(); });
  return { h, send(content: string, id: string) {
    child.stdin.write(`::botmux-minimax:${Buffer.from(JSON.stringify({ type: 'message', content, replyTurnId: id })).toString('base64')}\n`);
  } };
}

describe('MiniMax Code adapter', () => {
  function installation(official: boolean) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mcode-install-'))); roots.push(root);
    const packageRoot = join(root, 'lib', 'node_modules', '@minimax-ai', 'code');
    const executable = official ? join(root, 'bin', 'mcode') : join(packageRoot, 'dist', 'cli.js');
    mkdirSync(dirname(executable), { recursive: true });
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@minimax-ai/code' }));
    if (official) writeFileSync(join(root, 'install.json'), '{}');
    const node = join(root, 'runtime', 'bin', 'node');
    mkdirSync(dirname(node), { recursive: true });
    symlinkSync(process.execPath, node);
    return { root, packageRoot, executable, node, dataDir: join(root, 'state', 'data') };
  }

  it('binds the npm package behind its global bin symlink without exposing sibling packages', () => {
    const f = installation(false);
    const bin = join(f.root, 'bin', 'mcode'); mkdirSync(dirname(bin)); symlinkSync(f.executable, bin);
    const adapter = createMinimaxAdapter(bin);
    const args = adapter.buildArgs({ sessionId: 'npm', resume: false,
      env: { MINIMAX_DATA_DIR: f.dataDir, PATH: dirname(f.node) } });
    expect(adapter.sandboxReadonlyPaths?.()).toEqual([f.packageRoot]);
    expect(adapter.sandboxExtraExecPaths?.()).toEqual([f.executable, realpathSync(f.node)]);
    expect(args[args.indexOf('--node-bin') + 1]).toBe(realpathSync(f.node));
    expect(adapter.authPaths).toEqual([f.dataDir]);
    expect(existsSync(join(f.root, '.mcode-active'))).toBe(false);
  });

  it('prepares first-run persistent bind sources before the worker filters authPaths', () => {
    const f = installation(true);
    const adapter = createMinimaxAdapter(f.executable);
    expect(existsSync(f.dataDir)).toBe(false);
    expect(existsSync(join(f.root, '.mcode-active'))).toBe(false);
    const args = adapter.buildArgs({ sessionId: 'official', resume: false, env: { MINIMAX_DATA_DIR: f.dataDir } });
    expect(adapter.authPaths).toEqual([f.dataDir, join(f.root, '.mcode-active')]);
    expect(adapter.authPaths?.every(path => existsSync(path))).toBe(true);
    expect(adapter.sandboxReadonlyPaths?.()).toEqual([f.root]);
    expect(adapter.sandboxExtraExecPaths?.()).toEqual([f.executable]);
    expect(args).not.toContain('--node-bin');
    writeFileSync(join(f.dataDir, 'persisted'), 'keep');
    adapter.buildArgs({ sessionId: 'official', resume: true, resumeSessionId: 'native', env: { MINIMAX_DATA_DIR: f.dataDir } });
    expect(readFileSync(join(f.dataDir, 'persisted'), 'utf8')).toBe('keep');
  });

  it('exposes an official installer runtime outside its installation root read-only', () => {
    const f = installation(true);
    writeFileSync(join(f.root, 'install.json'), JSON.stringify({ nodeExecutable: f.node }));
    const adapter = createMinimaxAdapter(f.executable);
    adapter.buildArgs({ sessionId: 'official-external-node', resume: false, env: { MINIMAX_DATA_DIR: f.dataDir } });
    expect(adapter.sandboxExtraExecPaths?.()).toEqual([f.executable, realpathSync(f.node)]);
    expect(adapter.sandboxReadonlyPaths?.()).toEqual([f.root]);
    expect(adapter.authPaths).toEqual([f.dataDir, join(f.root, '.mcode-active')]);
  });

  it.each(['{"name":"other-cli"}', '{invalid json'])('does not grant an unrelated or unreadable package root: %s', manifest => {
    const f = installation(false);
    writeFileSync(join(f.packageRoot, 'package.json'), manifest);
    expect(createMinimaxAdapter(f.executable).sandboxReadonlyPaths?.()).toEqual([]);
  });

  it('reports a missing npm Node runtime before attempting to start the runner', () => {
    const f = installation(false);
    expect(() => createMinimaxAdapter(f.executable).buildArgs({ sessionId: 'npm', resume: false,
      env: { MINIMAX_DATA_DIR: f.dataDir, PATH: '' } })).toThrow('requires node on PATH');
  });

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
  it.each([false, true])('forwards a configured long-review budget on spawn (resume: %s)', resume => {
    const f = fixture(); vi.stubEnv('MINIMAX_DATA_DIR', join(f.root, 'data'));
    const adapter = createMinimaxAdapter(f.executable);
    const options = { sessionId: 'budget', resume, ...(resume ? { resumeSessionId: 'native' } : {}) };
    expect(adapter.buildArgs(options)).not.toContain('--turn-timeout-ms');
    const args = adapter.buildArgs({ ...options, turnTimeoutMs: 3_600_000 });
    expect(args[args.indexOf('--turn-timeout-ms') + 1]).toBe('3600000');
  });
});

it.each([
  ['bad base64/json', '::botmux-minimax:%%%'],
  ['invalid message shape', `::botmux-minimax:${Buffer.from(JSON.stringify({ type: 'message', content: 42 })).toString('base64')}`],
  ['foreign input', 'ordinary text without a runner frame'],
])('ignores %s without starting native work and accepts the next valid turn', async (_, line) => {
  const { h, send } = runner();
  await waitFor(() => h.stdout.includes('ready'));
  h.child.stdin.write(`${line}\n`);
  await waitFor(() => h.stdout.includes('invalid input frame') || h.stdout.includes('ignoring non-frame input'));
  expect(existsSync(h.log)).toBe(false);
  expect(markers(h.stdout)).toEqual([]);
  send('healthy', 'next');
  await waitFor(() => markers(h.stdout).some(m => m.kind === 'final'));
  expect(markers(h.stdout).filter(m => m.kind === 'final').map(m => m.payload))
    .toEqual([expect.objectContaining({ content: 'answer:healthy', turnId: 'next' })]);
  expect(readFileSync(h.log, 'utf8').trim().split('\n')).toHaveLength(1);
});

it('accepts a buffer at the frame limit and closes on overflow without native execution', async () => {
  const { h } = runner();
  await waitFor(() => h.stdout.includes('ready'));
  h.child.stdin.write('x'.repeat(4 * 1024 * 1024) + '\n');
  await waitFor(() => h.stdout.includes('ignoring non-frame input'));
  expect(h.child.exitCode).toBeNull();
  expect(h.stderr).not.toContain('exceeds limit');
  h.child.stdin.write('x'.repeat(4 * 1024 * 1024 + 1));
  await waitFor(() => h.child.exitCode !== null);
  expect(await h.closed).toEqual({ code: 0, signal: null });
  expect(h.stderr).toContain('MiniMax input frame exceeds limit');
  expect(existsSync(h.log)).toBe(false);
  expect(markers(h.stdout)).toEqual([]);
});

it('SIGTERM aborts the active native process and never executes queued turns or reports a final', async () => {
  const { h, send } = runner();
  send('hang', 'active'); send('must-not-run', 'queued');
  // The native process creates the log before it finishes writing its line.
  await waitFor(() => readJsonLines(h.log).length > 0);
  const [call] = readJsonLines(h.log);
  expect(call.input).toBe('hang');
  h.child.kill('SIGTERM');
  await waitFor(() => h.child.exitCode !== null);
  expect(await h.closed).toEqual({ code: 0, signal: null });
  expect(readFileSync(h.log, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(() => process.kill(call.pid, 0)).toThrow();
  expect(markers(h.stdout).filter(m => m.kind === 'final')).toEqual([]);
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

it('uses the declared npm Node runtime ahead of inherited PATH entries', async () => {
  const f = fixture();
  const node = join(f.root, 'runtime', 'bin', 'node'); mkdirSync(dirname(node), { recursive: true });
  const prefix = tsRunnerPrefix();
  writeFileSync(node, `#!/bin/sh\nexport MCODE_TEST_NODE_USED=canonical\nexec ${quote(prefix.command)} "$@"\n`, { mode: 0o700 });
  const { h, send } = runner(['--node-bin', node]);
  // Exercise an npm-style shebang, rather than the fixture's absolute runtime.
  writeFileSync(h.executable, '#!/usr/bin/env node\n' + readFileSync(resolve('test/fixtures/fake-mcode-exec.mjs'), 'utf8'), { mode: 0o700 });
  send('npm runtime', 'one');
  await waitFor(() => markers(h.stdout).some(m => m.kind === 'final'));
  expect(markers(h.stdout).find(m => m.kind === 'final')?.payload.content).toBe('answer:npm runtime');
  expect(JSON.parse(readFileSync(h.log, 'utf8').trim()).nodeUsed).toBe('canonical');
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

it('reports native exec failure with its cause and resumes the next turn', async () => {
  const { h, send } = runner();
  const finals = () => markers(h.stdout).filter(m => m.kind === 'final').map(m => m.payload);
  send('failed', 'failed');
  await waitFor(() => finals().length === 1);
  expect(finals()[0]).toMatchObject({ turnId: 'failed', errorCode: 'execution_failed',
    content: expect.stringContaining('INTERACTION_NOT_AVAILABLE') });
  send('healthy', 'next');
  await waitFor(() => finals().length === 2);
  expect(finals()[1]).toMatchObject({ turnId: 'next', content: 'answer:healthy' });
  expect(finals()[1].errorCode).toBeUndefined();
  const calls = readFileSync(h.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(calls[1].args[calls[1].args.indexOf('--session') + 1]).toBe('session_fixture');
});

it('kills a hung invocation and permits a later turn in the same native session', async () => {
  const { h, send } = runner(['--turn-timeout-ms', '1000']); send('hang', 'one');
  await waitFor(() => markers(h.stdout).some(m => m.kind === 'final'));
  expect(markers(h.stdout).find(m => m.kind === 'final')?.payload.errorCode).toBe('turn_budget_exhausted');
  send('next', 'two'); await waitFor(() => markers(h.stdout).filter(m => m.kind === 'final').length === 2);
  expect(markers(h.stdout).filter(m => m.kind === 'final')[1].payload.content).toBe('answer:next');
});

it('rejects a timer overflow before starting native work', async () => {
  const { h } = runner(['--turn-timeout-ms', '2147483648']);
  await waitFor(() => h.child.exitCode !== null);
  expect(await h.closed).toEqual({ code: 2, signal: null });
  expect(h.stderr.length).toBeGreaterThan(0);
  expect(existsSync(h.log)).toBe(false);
});

it.each([false, true])('does not inject a native exec timeout unless configured (resume: %s)', async resume => {
  const { h, send } = runner(resume ? ['--native-session-id', 'session_fixture'] : []);
  send('healthy', 'unbounded');
  await waitFor(() => markers(h.stdout).some(m => m.kind === 'final'));
  expect(markers(h.stdout).find(m => m.kind === 'final')?.payload).toMatchObject({ content: 'answer:healthy', turnId: 'unbounded' });
  const calls = readFileSync(h.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(calls[0].args).not.toContain('--timeout');
});

it('forwards an explicit budget to native exec', async () => {
  const { h, send } = runner(['--turn-timeout-ms', '3600000']);
  send('healthy', 'bounded');
  await waitFor(() => markers(h.stdout).some(m => m.kind === 'final'));
  const call = JSON.parse(readFileSync(h.log, 'utf8').trim());
  expect(call.args[call.args.indexOf('--timeout') + 1]).toBe('3600000ms');
});
