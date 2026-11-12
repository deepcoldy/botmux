/** Behavior tests for ACP input integrity, ownership, cancellation and native compatibility. */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runAntigravityAcp, type AntigravityAcpOptions } from '../src/services/antigravity-acp.js';
import { createAntigravityAcpAdapter } from '../src/adapters/cli/antigravity-acp.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { antigravityTransport, verifyAntigravityTransport } from '../src/services/antigravity-transport.js';
import { runnerFinalOutcome } from '../src/services/runner-final-outcome.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Install a test-only peer behind the exact executable contract used by the transport. */
function fixture(mode = '') {
  const root = mkdtempSync(join(tmpdir(), 'botmux-agy-acp-')); roots.push(root);
  const executable = join(root, 'agy');
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  writeFileSync(executable, `#!/bin/sh\nexec ${[tsRunnerPrefix().command, resolve('test/fixtures/fake-antigravity-acp.mjs')].map(quote).join(' ')} "$@"\n`, { mode: 0o700 });
  const log = join(root, 'calls.jsonl');
  writeFileSync(log, '');
  const sessions: string[] = [];
  const options: AntigravityAcpOptions = {
    executable, cwd: root, env: { ...process.env, AGY_TEST_LOG: log, AGY_TEST_MODE: mode,
      BOTMUX_OWNER_OPEN_ID: 'ou_owner', __OWNER_OPEN_ID: 'ou_stale' },
    content: 'test prompt', onSession: id => sessions.push(id),
  };
  return { root, log, sessions, options,
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) as Array<Record<string, unknown>> };
}

/** Wait on the peer's durable receipt, never on a fixed startup sleep. */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('ACP peer did not record the expected request');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('Antigravity ACP transport', () => {
  it('delivers long UTF-8 multi-line prompts intact and returns only the final answer', async () => {
    const f = fixture();
    const content = '<user_message>\n' + '中文 😀 line\n'.repeat(2_000) + '</user_message>';
    expect(await runAntigravityAcp({ ...f.options, content }, new AbortController().signal)).toBe('中文 complete answer');
    const calls = f.calls();
    expect(calls.filter(call => call.method === 'session/prompt')).toHaveLength(1);
    expect(calls.find(call => call.method === 'session/prompt')?.params).toEqual({
      sessionId: 'native-agy-test-session', prompt: [{ type: 'text', text: content }],
    });
    expect(f.sessions).toEqual(['native-agy-test-session']);
    expect(calls.every(call => call.owner === 'ou_owner' && call.legacyOwner === 'ou_owner')).toBe(true);
  });

  it('restores only the exact native session and applies supported model configuration', async () => {
    const f = fixture();
    await runAntigravityAcp({ ...f.options, nativeSessionId: 'exact-native', model: 'gemini-test', effort: 'high' }, new AbortController().signal);
    const calls = f.calls();
    expect(calls.some(call => call.method === 'session/new')).toBe(false);
    expect(calls.find(call => call.method === 'session/load')?.params).toEqual({ sessionId: 'exact-native', cwd: f.root, mcpServers: [] });
    expect(calls.filter(call => call.method === 'session/set_config_option').map(call => call.params)).toEqual([
      { sessionId: 'exact-native', configId: 'model', value: 'gemini-test' },
      { sessionId: 'exact-native', configId: 'effort', value: 'high' },
    ]);
  });

  it('preserves CLI model aliases through the native ACP model catalog', async () => {
    const f = fixture();
    await runAntigravityAcp({ ...f.options, model: 'gemini-test-high', effort: 'high' }, new AbortController().signal);
    expect(f.calls().find(call => call.method === 'session/set_model')?.params).toEqual({
      sessionId: 'native-agy-test-session', modelId: 'gemini-test-high',
    });
    expect(f.calls().filter(call => call.method === 'session/set_config_option').map(call => call.params)).toEqual([
      { sessionId: 'native-agy-test-session', configId: 'effort', value: 'high' },
    ]);
  });

  it.each(['wrong-load', 'no-restore'])('does not fall back to a new conversation after %s', async mode => {
    const f = fixture(mode);
    await expect(runAntigravityAcp({ ...f.options, nativeSessionId: 'exact-native' }, new AbortController().signal)).rejects.toThrow();
    expect(f.calls().some(call => call.method === 'session/new' || call.method === 'session/prompt')).toBe(false);
  });

  it.each(['exit', 'invalid-json', 'foreign-update', 'permission', 'limit'])('fails instead of reporting a completed turn on %s', async mode => {
    const f = fixture(mode);
    await expect(runAntigravityAcp(f.options, new AbortController().signal)).rejects.toThrow();
    expect(f.calls().filter(call => call.method === 'session/prompt')).toHaveLength(1);
  });

  it('cancels a running prompt and reaps its owned native process without touching the test process', async () => {
    const f = fixture('hang');
    const controller = new AbortController();
    const task = runAntigravityAcp(f.options, controller.signal);
    // Bun's rejection matcher waits immediately; observe the task without
    // asserting until the test has delivered its cancellation signal.
    const rejected = task.catch((error: unknown) => error);
    await until(() => f.calls().some(call => call.method === 'session/prompt'));
    const pid = f.calls()[0].pid as number;
    controller.abort();
    const error = await rejected;
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('message', 'Antigravity ACP cancelled');
    await until(() => {
      try { return /^[ZX]/.test(execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
        encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()); } catch { return true; }
    });
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it('does not send a prompt if the configured model is unavailable', async () => {
    const f = fixture();
    await expect(runAntigravityAcp({ ...f.options, model: 'missing-model' }, new AbortController().signal)).rejects.toThrow('configuration unavailable');
    expect(f.calls().some(call => call.method === 'session/prompt')).toBe(false);
  });
});

describe('Antigravity ACP opt-in', () => {
  it('keeps native defaults and selects ACP only for the requested adapter', () => {
    expect(antigravityTransport(undefined)).toBe('terminal');
    expect(antigravityTransport({ AGY_BOTMUX_TRANSPORT: 'acp' })).toBe('acp');
    expect(() => antigravityTransport({ AGY_BOTMUX_TRANSPORT: 'invalid' })).toThrow();
    expect(createCliAdapterSync('antigravity', '/bin/true').runnerFramedInput).not.toBe(true);
    expect(createCliAdapterSync('antigravity', '/bin/true', { antigravityTransport: 'acp' }).runnerFramedInput).toBe(true);
    expect(createCliAdapterSync('codex', '/bin/true', { antigravityTransport: 'acp' }).runnerFramedInput).not.toBe(true);
  });

  it('rejects unsupported permissions and forks, and resumes only when the exact native id exists', async () => {
    const adapter = createAntigravityAcpAdapter('/bin/true');
    const base = { sessionId: 'test', resume: false };
    expect(() => adapter.buildArgs({ ...base, disableCliBypass: true })).toThrow('interactive permissions');
    expect(() => adapter.buildArgs({ ...base, forkSession: true })).toThrow('fork');
    // A resume without a native id (warm reattach before the first session/new)
    // must not throw: the runner starts fresh instead of killing the reattach.
    const freshArgs = adapter.buildArgs({ ...base, resume: true });
    expect(freshArgs).not.toContain('--native-session-id');
    const resumeArgs = adapter.buildArgs({ ...base, resume: true, resumeSessionId: 'native-123' });
    expect(resumeArgs.slice(resumeArgs.indexOf('--native-session-id'))).toEqual(['--native-session-id', 'native-123']);
    const writes: string[] = [];
    expect(await adapter.writeInput({ write: text => { writes.push(text); } }, 'message')).toMatchObject({ submitted: false });
    expect(writes).toEqual([]);
  });

  it('never changes the transport of an already surviving pane', () => {
    const { root } = fixture();
    const base = { dataDir: root, sessionId: 'session', reattach: true };
    expect(() => verifyAntigravityTransport({ ...base, transport: 'terminal' })).not.toThrow();
    expect(() => verifyAntigravityTransport({ ...base, transport: 'acp' })).toThrow('surviving session');
    verifyAntigravityTransport({ ...base, transport: 'acp', reattach: false });
    expect(() => verifyAntigravityTransport({ ...base, transport: 'acp' })).not.toThrow();
    expect(() => verifyAntigravityTransport({ ...base, transport: 'terminal' })).toThrow('surviving session');
    mkdirSync(join(root, 'antigravity-transport'), { recursive: true });
    writeFileSync(join(root, 'antigravity-transport', 'session.txt'), 'bad-mode');
    expect(() => verifyAntigravityTransport({ ...base, transport: 'acp' })).toThrow();
  });

  it('maps ACP errors to failure while preserving other runner outcomes', () => {
    expect(runnerFinalOutcome('antigravity', 'execution_failed').status).toBe('failed');
    expect(runnerFinalOutcome('antigravity', 'cancelled').status).toBe('cancelled');
    expect(runnerFinalOutcome('antigravity', undefined).status).toBe('completed');
    expect(runnerFinalOutcome('mira', 'execution_failed').status).toBe('completed');
  });
});
