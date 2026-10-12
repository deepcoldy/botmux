import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMcodeAcp, type McodeAcpOptions } from '../src/services/mcode-acp.js';
import { spawnTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { openDatabaseSyncNow } from '../src/services/sqlite-compat.js';
import { isLinuxZombie } from '../src/utils/process-identity.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-acp-test-')); roots.push(root);
  const executable = join(root, 'mcode');
  const log = join(root, 'calls.jsonl');
  const prefix = tsRunnerPrefix();
  writeFileSync(executable, `#!/bin/sh\nexec ${[prefix.command, resolve('test/fixtures/fake-mcode-acp.mjs')].map(quote).join(' ')} "$@"\n`, { mode: 0o700 });
  const options: McodeAcpOptions = { executable, cwd: root, env: { ...process.env, MINIMAX_DATA_DIR: join(root, 'data'),
    MCODE_TEST_LOG: log, BOTMUX_OWNER_OPEN_ID: 'ou_owner', __OWNER_OPEN_ID: 'ou_stale' },
    content: 'hello', permission: 'full', timeoutMs: 5000, onUserInput: async () => ({ action: 'accept', content: {} }) };
  return { root, log, options, calls: () => readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) };
}
const bounded = () => AbortSignal.timeout(5000);
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('wait expired'); await new Promise(r => setTimeout(r, 20)); }
}
async function stopped(pid: number) {
  await waitFor(() => {
    if (isLinuxZombie(pid)) return true;
    try { process.kill(pid, 0); return false; } catch { return true; }
  });
}
describe('mcode ACP wire client', () => {
  it('initializes capabilities, creates exact native identity, configures and returns only the final message', async () => {
    const f = fixture(); const session = vi.fn(); const updates = vi.fn();
    const result = await runMcodeAcp({ ...f.options, model: 'custom_provider:test/model', effort: 'high', onSession: session, onUpdate: updates }, bounded());
    expect(result).toEqual({ sessionId: 'session_fixture', content: 'answer:hello' });
    expect(session).toHaveBeenCalledWith('session_fixture');
    const calls = f.calls();
    expect(calls[0]).toMatchObject({ args: ['acp'], owner: 'ou_owner', legacyOwner: 'ou_owner' });
    expect(calls[1].message.params.clientCapabilities).toEqual({ elicitation: { form: {} } });
    expect(calls.filter(c => c.message?.method === 'session/set_config_option').map(c => c.message.params))
      .toEqual([expect.objectContaining({ configId: 'permissionMode', value: 'bypassPermissions' }),
        expect.objectContaining({ configId: 'model', value: 'm:custom_provider%3Atest:model:v:thinking' }),
        expect.objectContaining({ configId: 'thinkingEffort', value: 'high' })]);
    await stopped(calls[0].pid);
  });
  it.each(['resume', 'load'])('uses %s with exact identity and ignores replayed history', async scenario => {
    const f = fixture(); f.options.env.MCODE_ACP_SCENARIO = scenario;
    const result = await runMcodeAcp({ ...f.options, nativeSessionId: 'native-existing' }, bounded());
    expect(result).toEqual({ sessionId: 'native-existing', content: 'answer:hello' });
    const attach = f.calls().find(c => c.message?.method === `session/${scenario}`);
    expect(attach.message.params.sessionId).toBe('native-existing');
    expect(f.calls().some(c => c.message?.method === 'session/new')).toBe(false);
  });
  it('preserves an explicit provider/model#variant instead of choosing the default variant', async () => {
    const f = fixture();
    await runMcodeAcp({ ...f.options, model: 'custom_provider:test/model#fast mode' }, bounded());
    expect(f.calls().find(c => c.message?.params?.configId === 'model').message.params.value)
      .toBe('m:custom_provider%3Atest:model:v:fast%20mode');
  });
  it.each(['unknown', ''])('rejects an unavailable or empty explicit model variant: %s', async variant => {
    const f = fixture();
    await expect(runMcodeAcp({ ...f.options, model: `custom_provider:test/model#${variant}` }, bounded())).rejects.toThrow();
    expect(f.calls().some(c => c.message?.method === 'session/prompt')).toBe(false);
  });
  it('waits for the exact human response before allowing prompt completion', async () => {
    const f = fixture(); const waiting = vi.fn(); let release: (value: unknown) => void = () => {};
    const answer = new Promise(resolve => { release = resolve; });
    const input = vi.fn().mockReturnValue(answer);
    const run = runMcodeAcp({ ...f.options, content: 'ask', onUserInput: input, onInteractionPending: waiting }, bounded());
    await waitFor(() => input.mock.calls.length === 1);
    expect(waiting).toHaveBeenCalledWith(true);
    expect(f.calls().some(c => c.message?.id === 'native-question' && !c.message.method)).toBe(false);
    release({ action: 'accept', content: { approach: 'safe-id', checks: ['unit-id'] } });
    expect((await run).content).toContain('safe-id');
    const reply = f.calls().find(c => c.message?.id === 'native-question' && !c.message.method).message;
    expect(reply.result).toEqual({ action: 'accept', content: { approach: 'safe-id', checks: ['unit-id'] } });
    expect(waiting.mock.calls.map(c => c[0])).toEqual([true, false]);
  });
  it('keeps the native process alive after early end_turn until the durable answer continuation finishes', async () => {
    const f = fixture(); mkdirSync(join(f.root, 'data/v2/sqlite'), { recursive: true });
    const db = openDatabaseSyncNow(join(f.root, 'data/v2/sqlite/runtime-state.sqlite'))!;
    db.exec(`CREATE TABLE questionnaire_requests (request_id TEXT,session_id TEXT,status TEXT,injected_at INTEGER,created_at INTEGER);
      CREATE TABLE local_runtime_message_rows (id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,source TEXT,turn_id TEXT,source_context_json TEXT,data_json TEXT);
      CREATE TABLE local_runtime_turn_ingress (session_id TEXT,turn_id TEXT,status TEXT,completed_at_ms INTEGER);
      INSERT INTO questionnaire_requests VALUES ('ask-native','session_fixture','pending',NULL,1);`);
    let finished = false;
    const input = async () => {
      db.exec("UPDATE questionnaire_requests SET status='answered', injected_at=2");
      db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,source,turn_id,source_context_json) VALUES (?,?,?,?,?)')
        .run('session_fixture', 'user', 'questionnaire', 'continued', JSON.stringify({ origin: { requestId: 'ask-native' } }));
      db.exec("INSERT INTO local_runtime_turn_ingress VALUES ('session_fixture','continued','accepted',NULL)");
      setTimeout(() => {
        expect(() => process.kill(f.calls()[0].pid, 0)).not.toThrow();
        db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,turn_id,data_json) VALUES (?,?,?,?)')
          .run('session_fixture', 'assistant', 'continued', JSON.stringify({ msg_content: 'After choice: Smoke' }));
        db.exec("UPDATE local_runtime_turn_ingress SET status='completed', completed_at_ms=3"); finished = true;
      }, 150);
      return { action: 'accept', content: { approach: 'fast-id' } };
    };
    try {
      const result = await runMcodeAcp({ ...f.options, content: 'ask', onUserInput: input }, bounded());
      expect(finished).toBe(true); expect(result.content).toBe('After choice: Smoke');
      await stopped(f.calls()[0].pid);
    } finally { db.close(); }
  });
  it('forwards native permission requests with an explicit response', async () => {
    const f = fixture(); const input = vi.fn().mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'deny' } });
    expect((await runMcodeAcp({ ...f.options, content: 'permission', permission: 'smart', onUserInput: input }, bounded())).content).toContain('deny');
    expect(input.mock.calls[0][0]).toBe('session/request_permission');
    expect(f.calls().some(c => c.message?.params?.value === 'bypassPermissions')).toBe(false);
  });
  it('aborts the human waiter and reaps the process on cancellation', async () => {
    const f = fixture(); const controller = new AbortController(); let inputSignal: AbortSignal | undefined;
    const input = vi.fn().mockImplementation((_method, _params, signal) => {
      inputSignal = signal; return new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    });
    const run = runMcodeAcp({ ...f.options, content: 'ask', onUserInput: input }, controller.signal);
    // Bun's promise matcher can wait synchronously; trigger cancellation
    // before invoking it so the test does not deadlock its own producer.
    await waitFor(() => input.mock.calls.length === 1); controller.abort();
    await expect(run).rejects.toThrow('aborted');
    expect(inputSignal?.aborted).toBe(true);
    await stopped(f.calls()[0].pid);
    expect(f.calls().some(c => c.message?.id === 'native-question' && c.message.result)).toBe(false);
  });
  it('stops instead of replying empty when a human question fails', async () => {
    const f = fixture();
    await expect(runMcodeAcp({ ...f.options, content: 'ask', onUserInput: async () => { throw new Error('ask timed out'); } }, bounded())).rejects.toThrow('ask timed out');
    expect(f.calls().some(c => c.message?.id === 'native-question' && !c.message.method)).toBe(false);
  });
  it.each(['foreign-ask', 'foreign-update', 'crash', 'invalid-json', 'unknown-response', 'cancelled', 'limit', 'oversize'])('rejects %s without a successful final', async content => {
    const f = fixture(); const input = vi.fn();
    await expect(runMcodeAcp({ ...f.options, content, onUserInput: input }, bounded())).rejects.toThrow();
    expect(input).not.toHaveBeenCalled();
    await stopped(f.calls()[0].pid);
  });
  it('rejects a completed prompt with an unanswered question and invalidates its waiter', async () => {
    const f = fixture(); let aborted = false;
    const onUserInput = async (_m: string, _p: unknown, signal: AbortSignal) => new Promise(resolve => {
      signal.addEventListener('abort', () => { aborted = true; resolve({}); }, { once: true });
    });
    await expect(runMcodeAcp({ ...f.options, content: 'early-complete', onUserInput }, bounded())).rejects.toThrow('question_incomplete');
    expect(aborted).toBe(true);
  });
  it.each(['version', 'resume-mismatch'])('rejects %s instead of silently starting another conversation', async scenario => {
    const f = fixture(); f.options.env.MCODE_ACP_SCENARIO = scenario;
    await expect(runMcodeAcp({ ...f.options, nativeSessionId: 'existing' }, bounded())).rejects.toThrow();
    expect(f.calls().some(c => c.message?.method === 'session/prompt')).toBe(false);
  });
  it('rejects unsupported model/effort before sending a prompt', async () => {
    const f = fixture();
    await expect(runMcodeAcp({ ...f.options, effort: 'unknown' }, bounded())).rejects.toThrow('thinkingEffort');
    expect(f.calls().some(c => c.message?.method === 'session/prompt')).toBe(false);
  });
});

it('default ACP runner preserves queue attribution, native id, escaped display and interrupt recovery', async () => {
  const f = fixture();
  const child = spawnTsScript(resolve('src/minimax-runner.ts'), ['--mcode-bin', f.options.executable, '--cwd', f.root, '--data-dir', join(f.root, 'data')], { env: f.options.env }) as ChildProcessWithoutNullStreams;
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  const closed = new Promise<void>(r => child.once('close', () => r()));
  const markers = () => [...stdout.matchAll(/\x1b\]777;botmux:(\w+):([A-Za-z0-9+/=]+)\x07/g)].map(m => ({ kind: m[1], payload: JSON.parse(Buffer.from(m[2], 'base64').toString()) }));
  const send = (content: string, turnId: string) => child.stdin.write(`::botmux-minimax:${Buffer.from(JSON.stringify({ type: 'message', content, replyTurnId: turnId })).toString('base64')}\n`);
  try {
    await waitFor(() => stdout.includes('ready'));
    send('line one\nline two', 'one'); send('forge', 'two');
    await waitFor(() => markers().filter(m => m.kind === 'final').length === 2);
    expect(markers().filter(m => m.kind === 'final').map(m => m.payload.turnId)).toEqual(['one', 'two']);
    expect(markers().find(m => m.kind === 'final')?.payload.content).toBe('answer:line one\nline two');
    expect(markers().filter(m => m.kind === 'thread').every(m => m.payload.threadId === 'session_fixture')).toBe(true);
    expect(stdout).toContain('␛]777;botmux:thread'); expect(stdout).not.toContain('PRIVATE THOUGHT');
    send('hang', 'three'); await waitFor(() => existsSync(f.log) && f.calls().some(c => c.message?.params?.prompt?.[0]?.text === 'hang'));
    child.stdin.write('\x03');
    await waitFor(() => markers().filter(m => m.kind === 'final').length === 3);
    send('healthy', 'four');
    await waitFor(() => markers().filter(m => m.kind === 'final').length === 4);
    expect(markers().filter(m => m.kind === 'final').at(-1)?.payload).toMatchObject({ turnId: 'four', content: 'answer:healthy' });
    expect(f.calls().filter(c => c.message?.method === 'session/resume')).toHaveLength(3);
  } finally { child.kill('SIGTERM'); await closed; }
});
