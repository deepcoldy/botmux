import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMinimaxAcp, type MinimaxAcpOptions } from '../src/services/minimax-acp.js';
import { spawnTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import { readJsonLines } from './helpers/read-json-lines.js';
import { readRequestBodyJson } from './helpers/read-request-body.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { openDatabaseSyncNow } from '../src/services/sqlite-compat.js';
import { isLinuxZombie } from '../src/utils/process-identity.js';
import { createServer, type ServerResponse } from 'node:http';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-acp-test-')); roots.push(root);
  const executable = join(root, 'mcode');
  const log = join(root, 'calls.jsonl');
  const prefix = tsRunnerPrefix();
  writeFileSync(executable, `#!/bin/sh\nexec ${[prefix.command, resolve('test/fixtures/fake-minimax-acp.mjs')].map(quote).join(' ')} "$@"\n`, { mode: 0o700 });
  const options: MinimaxAcpOptions = { executable, cwd: root, env: { ...process.env, MINIMAX_DATA_DIR: join(root, 'data'),
    MCODE_TEST_LOG: log, BOTMUX_OWNER_OPEN_ID: 'ou_owner', __OWNER_OPEN_ID: 'ou_stale' },
    content: 'hello', permission: 'full', timeoutMs: 5000, onUserInput: async () => ({ action: 'accept', content: {} }) };
  return { root, log, options, calls: () => readJsonLines(log) };
}
function durableFixture() {
  const f = fixture(); mkdirSync(join(f.root, 'data/v2/sqlite'), { recursive: true });
  const db = openDatabaseSyncNow(join(f.root, 'data/v2/sqlite/runtime-state.sqlite'))!;
  db.exec(`CREATE TABLE questionnaire_requests (request_id TEXT,session_id TEXT,status TEXT,injected_at INTEGER,created_at INTEGER);
    CREATE TABLE local_runtime_message_rows (id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,source TEXT,turn_id TEXT,source_context_json TEXT,data_json TEXT);
    CREATE TABLE local_runtime_turn_ingress (session_id TEXT,turn_id TEXT,status TEXT,completed_at_ms INTEGER);`);
  f.options.env.MCODE_ACP_SCENARIO = 'native-questionnaire';
  return { ...f, db };
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
  it('accepts eight simultaneous permission requests and returns each exact response', async () => {
    const f = fixture(); let release: (value: unknown) => void = () => {};
    const answer = new Promise(resolve => { release = resolve; });
    const input = vi.fn().mockImplementation(() => {
      if (input.mock.calls.length === 8) {
        expect(f.calls().filter(c => c.message?.id?.startsWith?.('burst-'))).toHaveLength(0);
        release({ outcome: { outcome: 'selected', optionId: 'deny' } });
      }
      return answer;
    });
    const result = await runMinimaxAcp({ ...f.options, content: 'permission-burst-8', onUserInput: input }, bounded());
    expect(result.content).toBe('answered:8'); expect(input).toHaveBeenCalledTimes(8);
    expect(f.calls().filter(c => c.message?.id?.startsWith?.('burst-')).map(c => c.message))
      .toEqual(Array.from({ length: 8 }, (_, i) => ({ jsonrpc: '2.0', id: `burst-${i + 1}`,
        result: { outcome: { outcome: 'selected', optionId: 'deny' } } })));
    await stopped(f.calls()[0].pid);
  });

  it('rejects the ninth simultaneous request specifically at the incoming request limit', async () => {
    const f = fixture(); const input = vi.fn().mockImplementation(() => new Promise(() => {}));
    await expect(runMinimaxAcp({ ...f.options, content: 'permission-burst-9', onUserInput: input }, bounded()))
      .rejects.toThrow('mcode_acp_too_many_questions');
    expect(f.calls().some(c => c.message?.id === 'burst-9' && c.message.result)).toBe(false);
    await stopped(f.calls()[0].pid);
  });

  it('reuses an answered request slot while the other seven requests are still pending', async () => {
    const f = fixture(); const waiting = vi.fn(); let release: (value: unknown) => void = () => {};
    let releaseFirst: (value: unknown) => void = () => {};
    const response = { outcome: { outcome: 'selected', optionId: 'deny' } };
    const answer = new Promise(resolve => { release = resolve; });
    const firstAnswer = new Promise(resolve => { releaseFirst = resolve; });
    const input = vi.fn().mockImplementation((_method, params) => {
      if (params.toolCall.title === 'Write 1') return firstAnswer;
      // Wait for all eight requests to arrive before answering the first.
      // NDJSON writes can span multiple stdout chunks under parallel load.
      if (input.mock.calls.length === 8) releaseFirst(response);
      if (params.toolCall.title === 'Write 9') {
        expect(input).toHaveBeenCalledTimes(9);
        expect(waiting.mock.calls.map(c => c[0])).toEqual([true]);
        expect(f.calls().filter(c => c.message?.id?.startsWith?.('burst-')).map(c => c.message.id)).toEqual(['burst-1']);
        release(response);
      }
      return answer;
    });
    const result = await runMinimaxAcp({ ...f.options, content: 'permission-window', onUserInput: input,
      onInteractionPending: waiting }, bounded());
    expect(result.content).toBe('answered:9'); expect(input).toHaveBeenCalledTimes(9);
    expect(waiting.mock.calls.map(c => c[0])).toEqual([true, false]);
    expect(f.calls().filter(c => c.message?.id?.startsWith?.('burst-'))).toHaveLength(9);
    await stopped(f.calls()[0].pid);
  });

  it.each([32, 33])('bounds accumulated native questionnaire ids at 32 for %s sequential questions', async count => {
    const f = durableFixture(); const input = vi.fn().mockImplementation(async (_method, params) => {
      const index = Number(params.message.split(' ').at(-1));
      f.db.prepare("UPDATE questionnaire_requests SET status='answered', injected_at=? WHERE request_id=?")
        .run(index, `q-${index}`);
      f.db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,source,turn_id,source_context_json) VALUES (?,?,?,?,?)')
        .run('session_fixture', 'user', 'questionnaire', `turn-${index}`, JSON.stringify({ origin: { requestId: `q-${index}` } }));
      f.db.prepare('INSERT INTO local_runtime_turn_ingress VALUES (?,?,?,?)').run('session_fixture', `turn-${index}`, 'completed', index);
      f.db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,turn_id,data_json) VALUES (?,?,?,?)')
        .run('session_fixture', 'assistant', `turn-${index}`, JSON.stringify({ msg_content: `durable:${index}` }));
      return { action: 'accept', content: { answer: `answer-${index}` } };
    });
    try {
      const run = runMinimaxAcp({ ...f.options, content: `native-questions-${count}`, onUserInput: input,
        onUpdate(update) {
          if (!update.toolCallId?.startsWith('questionnaire-')) return;
          const index = Number(update.toolCallId.split('-').at(-1));
          f.db.prepare('INSERT INTO questionnaire_requests VALUES (?,?,?,?,?)').run(`q-${index}`, 'session_fixture', 'pending', null, index);
        } }, bounded());
      if (count === 32) expect((await run).content).toBe('durable:32');
      else await expect(run).rejects.toThrow('mcode_acp_too_many_native_questions');
      expect(input).toHaveBeenCalledTimes(32);
      expect(f.calls().filter(c => c.message?.id?.startsWith?.('sequential-'))).toHaveLength(32);
      if (count === 33) expect(f.db.prepare("SELECT status FROM questionnaire_requests WHERE request_id='q-33'").get()).toEqual({ status: 'pending' });
      await stopped(f.calls()[0].pid);
    } finally { f.db.close(); }
  });
  it.each(['missing', 'schema', 'locked'] as const)('completes native turns without questions when the questionnaire database is %s', async scenario => {
    const f = fixture(); f.options.env.MCODE_ACP_SCENARIO = 'native-questionnaire';
    let db: ReturnType<typeof openDatabaseSyncNow> = null;
    if (scenario !== 'missing') {
      mkdirSync(join(f.root, 'data/v2/sqlite'), { recursive: true });
      db = openDatabaseSyncNow(join(f.root, 'data/v2/sqlite/runtime-state.sqlite'))!;
      if (scenario === 'locked') {
        db.exec('CREATE TABLE questionnaire_requests (session_id TEXT); BEGIN EXCLUSIVE');
      }
    }
    try {
      for (const nativeSessionId of [undefined, 'session_fixture']) {
        const result = await runMinimaxAcp({ ...f.options, nativeSessionId }, bounded());
        expect(result).toEqual({ sessionId: 'session_fixture', content: 'answer:hello' });
      }
      expect(f.calls().filter(c => c.message?.method === 'session/prompt')).toHaveLength(2);
      expect(f.calls().some(c => c.message?.method === 'session/resume')).toBe(true);
    } finally { if (scenario === 'locked') db?.exec('ROLLBACK'); db?.close(); }
  });

  it.each(['missing', 'schema', 'locked'] as const)('rejects a real native question at the elicitation boundary when its database is %s', async scenario => {
    const f = fixture(); f.options.env.MCODE_ACP_SCENARIO = 'native-questionnaire';
    const input = vi.fn();
    let db: ReturnType<typeof openDatabaseSyncNow> = null;
    if (scenario !== 'missing') {
      mkdirSync(join(f.root, 'data/v2/sqlite'), { recursive: true });
      db = openDatabaseSyncNow(join(f.root, 'data/v2/sqlite/runtime-state.sqlite'))!;
      if (scenario === 'locked') db.exec('CREATE TABLE questionnaire_requests (session_id TEXT); BEGIN EXCLUSIVE');
    }
    try {
      await expect(runMinimaxAcp({ ...f.options, content: 'ask', onUserInput: input }, bounded())).rejects.toThrow('启动边界不可读');
      expect(f.calls().some(c => c.message?.method === 'session/prompt')).toBe(true);
      expect(input).not.toHaveBeenCalled();
    } finally { if (scenario === 'locked') db?.exec('ROLLBACK'); db?.close(); }
  });

  it('does not substitute cursor zero when the database becomes readable only after the prompt starts', async () => {
    const f = fixture(); f.options.env.MCODE_ACP_SCENARIO = 'native-questionnaire';
    const input = vi.fn(); let db: ReturnType<typeof openDatabaseSyncNow> = null;
    try {
      await expect(runMinimaxAcp({ ...f.options, content: 'ask', onUserInput: input,
        onUpdate(update) {
          if (update.toolCallId !== 'questionnaire') return;
          mkdirSync(join(f.root, 'data/v2/sqlite'), { recursive: true });
          db = openDatabaseSyncNow(join(f.root, 'data/v2/sqlite/runtime-state.sqlite'))!;
          db.exec(`CREATE TABLE questionnaire_requests (request_id TEXT, session_id TEXT, status TEXT);
            INSERT INTO questionnaire_requests VALUES ('stale','session_fixture','pending'), ('fresh','session_fixture','pending');`);
        } }, bounded())).rejects.toThrow('启动边界不可读');
      expect(input).not.toHaveBeenCalled();
    } finally { db?.close(); }
  });

  it.each(['schema', 'locked'] as const)('keeps questionnaire reads fail-closed if the database becomes %s after the prompt starts', async scenario => {
    const f = durableFixture(); const input = vi.fn();
    try {
      await expect(runMinimaxAcp({ ...f.options, content: 'ask', onUserInput: input,
        onUpdate(update) {
          if (update.toolCallId === 'questionnaire') f.db.exec(scenario === 'schema' ? 'DROP TABLE questionnaire_requests' : 'BEGIN EXCLUSIVE');
        } }, bounded())).rejects.toThrow(scenario === 'schema' ? 'no such table' : 'locked');
      expect(f.calls().some(c => c.message?.method === 'session/prompt')).toBe(true);
      expect(input).not.toHaveBeenCalled();
    } finally { if (scenario === 'locked') f.db.exec('ROLLBACK'); f.db.close(); }
  });

  it('initializes capabilities, creates exact native identity, configures and returns only the final message', async () => {
    const f = fixture(); const session = vi.fn(); const updates = vi.fn();
    const result = await runMinimaxAcp({ ...f.options, model: 'custom_provider:test/model', effort: 'high', onSession: session, onUpdate: updates }, bounded());
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
    const result = await runMinimaxAcp({ ...f.options, nativeSessionId: 'native-existing' }, bounded());
    expect(result).toEqual({ sessionId: 'native-existing', content: 'answer:hello' });
    const attach = f.calls().find(c => c.message?.method === `session/${scenario}`);
    expect(attach.message.params.sessionId).toBe('native-existing');
    expect(f.calls().some(c => c.message?.method === 'session/new')).toBe(false);
  });
  it('preserves an explicit provider/model#variant instead of choosing the default variant', async () => {
    const f = fixture();
    await runMinimaxAcp({ ...f.options, model: 'custom_provider:test/model#fast mode' }, bounded());
    expect(f.calls().find(c => c.message?.params?.configId === 'model').message.params.value)
      .toBe('m:custom_provider%3Atest:model:v:fast%20mode');
  });
  it.each(['unknown', ''])('rejects an unavailable or empty explicit model variant: %s', async variant => {
    const f = fixture();
    await expect(runMinimaxAcp({ ...f.options, model: `custom_provider:test/model#${variant}` }, bounded())).rejects.toThrow();
    expect(f.calls().some(c => c.message?.method === 'session/prompt')).toBe(false);
  });
  it('waits for the exact human response before allowing prompt completion', async () => {
    const f = fixture(); const waiting = vi.fn(); let release: (value: unknown) => void = () => {};
    const answer = new Promise(resolve => { release = resolve; });
    const input = vi.fn().mockReturnValue(answer);
    const run = runMinimaxAcp({ ...f.options, content: 'ask', onUserInput: input, onInteractionPending: waiting }, bounded());
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
    const f = durableFixture(); const { db } = f;
    const onUpdate = (update: Record<string, any>) => {
      if (update.toolCallId === 'questionnaire') db.exec("INSERT INTO questionnaire_requests VALUES ('ask-native','session_fixture','pending',NULL,1)");
    };
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
      const result = await runMinimaxAcp({ ...f.options, content: 'ask', onUpdate, onUserInput: input }, bounded());
      expect(finished).toBe(true); expect(result.content).toBe('After choice: Smoke');
      await stopped(f.calls()[0].pid);
    } finally { db.close(); }
  });
  it('completes a new questionnaire after cancelling and resuming a session with a stale pending row', async () => {
    const f = durableFixture(); const { db } = f;
    const controller = new AbortController(); const input = vi.fn().mockImplementation(() => new Promise(() => {}));
    try {
      const cancelled = runMinimaxAcp({ ...f.options, content: 'ask', onUserInput: input,
        onUpdate(update) {
          if (update.toolCallId === 'questionnaire') db.exec("INSERT INTO questionnaire_requests VALUES ('stale','session_fixture','pending',NULL,1)");
        } }, controller.signal);
      await waitFor(() => input.mock.calls.length === 1); controller.abort();
      await expect(cancelled).rejects.toThrow('aborted');
      await stopped(f.calls()[0].pid);
      const result = await runMinimaxAcp({ ...f.options, content: 'ask', nativeSessionId: 'session_fixture',
        onUpdate(update) {
          if (update.toolCallId === 'questionnaire') db.exec("INSERT INTO questionnaire_requests VALUES ('fresh','session_fixture','pending',NULL,1)");
        },
        onUserInput: async () => {
          db.exec("UPDATE questionnaire_requests SET status='answered', injected_at=2 WHERE request_id='fresh'");
          db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,source,turn_id,source_context_json) VALUES (?,?,?,?,?)')
            .run('session_fixture', 'user', 'questionnaire', 'fresh-turn', JSON.stringify({ origin: { requestId: 'fresh' } }));
          db.exec("INSERT INTO local_runtime_turn_ingress VALUES ('session_fixture','fresh-turn','completed',3)");
          db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,turn_id,data_json) VALUES (?,?,?,?)')
            .run('session_fixture', 'assistant', 'fresh-turn', JSON.stringify({ msg_content: 'New questionnaire completed' }));
          return { action: 'accept', content: { approach: 'safe-id' } };
        } }, bounded());
      expect(result).toEqual({ sessionId: 'session_fixture', content: 'New questionnaire completed' });
      expect(db.prepare("SELECT status FROM questionnaire_requests WHERE request_id='stale'").get()).toEqual({ status: 'pending' });
      expect(f.calls().filter(c => c.message?.method === 'session/resume')).toHaveLength(1);
    } finally { controller.abort(); db.close(); }
  });
  it('fails closed if a native elicitation has no questionnaire belonging to this prompt cycle', async () => {
    const f = durableFixture(); const input = vi.fn();
    try {
      f.db.exec("INSERT INTO questionnaire_requests VALUES ('stale','session_fixture','pending',NULL,1)");
      await expect(runMinimaxAcp({ ...f.options, content: 'ask', onUserInput: input }, bounded())).rejects.toThrow('缺少本轮');
      expect(input).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it('forwards native permission requests with an explicit response', async () => {
    const f = fixture(); const input = vi.fn().mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'deny' } });
    expect((await runMinimaxAcp({ ...f.options, content: 'permission', permission: 'smart', onUserInput: input }, bounded())).content).toContain('deny');
    expect(input.mock.calls[0][0]).toBe('session/request_permission');
    expect(f.calls().some(c => c.message?.params?.value === 'bypassPermissions')).toBe(false);
  });
  it('aborts the human waiter and reaps the process on cancellation', async () => {
    const f = fixture(); const controller = new AbortController(); let inputSignal: AbortSignal | undefined;
    const input = vi.fn().mockImplementation((_method, _params, signal) => {
      inputSignal = signal; return new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    });
    const run = runMinimaxAcp({ ...f.options, content: 'ask', onUserInput: input }, controller.signal);
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
    await expect(runMinimaxAcp({ ...f.options, content: 'ask', onUserInput: async () => { throw new Error('ask timed out'); } }, bounded())).rejects.toThrow('ask timed out');
    expect(f.calls().some(c => c.message?.id === 'native-question' && !c.message.method)).toBe(false);
  });
  it.each(['oversize', 'oversize-stderr'])('rejects %s specifically at the output byte limit', async content => {
    const f = fixture();
    await expect(runMinimaxAcp({ ...f.options, content }, bounded())).rejects.toThrow('mcode_acp_output_limit');
    await stopped(f.calls()[0].pid);
  });
  it.each(['foreign-ask', 'foreign-update', 'crash', 'invalid-json', 'unknown-response', 'cancelled', 'limit'])('rejects %s without a successful final', async content => {
    const f = fixture(); const input = vi.fn();
    await expect(runMinimaxAcp({ ...f.options, content, onUserInput: input }, bounded())).rejects.toThrow();
    expect(input).not.toHaveBeenCalled();
    await stopped(f.calls()[0].pid);
  });
  it('rejects a completed prompt with an unanswered question and invalidates its waiter', async () => {
    const f = fixture(); let aborted = false;
    const onUserInput = async (_m: string, _p: unknown, signal: AbortSignal) => new Promise(resolve => {
      signal.addEventListener('abort', () => { aborted = true; resolve({}); }, { once: true });
    });
    await expect(runMinimaxAcp({ ...f.options, content: 'early-complete', onUserInput }, bounded())).rejects.toThrow('question_incomplete');
    expect(aborted).toBe(true);
  });
  it.each(['version', 'resume-mismatch'])('rejects %s instead of silently starting another conversation', async scenario => {
    const f = fixture(); f.options.env.MCODE_ACP_SCENARIO = scenario;
    await expect(runMinimaxAcp({ ...f.options, nativeSessionId: 'existing' }, bounded())).rejects.toThrow();
    expect(f.calls().some(c => c.message?.method === 'session/prompt')).toBe(false);
  });
  it('rejects unsupported model/effort before sending a prompt', async () => {
    const f = fixture();
    await expect(runMinimaxAcp({ ...f.options, effort: 'unknown' }, bounded())).rejects.toThrow('thinkingEffort');
    expect(f.calls().some(c => c.message?.method === 'session/prompt')).toBe(false);
  });
});

it.each([false, true])('default ACP runner preserves queue attribution, native id, escaped display and interrupt recovery (resume: %s)', async resume => {
  const f = fixture();
  const child = spawnTsScript(resolve('src/minimax-runner.ts'), ['--mcode-bin', f.options.executable, '--cwd', f.root, '--data-dir', join(f.root, 'data'), ...(resume ? ['--native-session-id', 'session_fixture'] : [])], { env: f.options.env }) as ChildProcessWithoutNullStreams;
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
    expect(markers().filter(m => m.kind === 'final').at(-1)?.payload.errorCode).toBe('cancelled');
    send('healthy', 'four');
    await waitFor(() => markers().filter(m => m.kind === 'final').length === 4);
    expect(markers().filter(m => m.kind === 'final').at(-1)?.payload).toMatchObject({ turnId: 'four', content: 'answer:healthy' });
    expect(f.calls().filter(c => c.message?.method === 'session/resume')).toHaveLength(resume ? 4 : 3);
    expect(markers().filter(m => m.kind === 'thread')).toEqual([{ kind: 'thread', payload: { threadId: 'session_fixture' } }]);
  } finally { child.kill('SIGTERM'); await closed; }
});

it('reports native ACP failure with its cause and resumes the next turn', async () => {
  const f = fixture();
  const child = spawnTsScript(resolve('src/minimax-runner.ts'), ['--mcode-bin', f.options.executable,
    '--cwd', f.root, '--data-dir', join(f.root, 'data')], { env: f.options.env }) as ChildProcessWithoutNullStreams;
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  const closed = new Promise<void>(r => child.once('close', () => r()));
  const finals = () => [...stdout.matchAll(/\x1b\]777;botmux:final:([A-Za-z0-9+/=]+)\x07/g)]
    .map(m => JSON.parse(Buffer.from(m[1], 'base64').toString()));
  const send = (content: string, replyTurnId: string) => child.stdin.write(`::botmux-minimax:${Buffer.from(JSON.stringify({ type: 'message', content, replyTurnId })).toString('base64')}\n`);
  try {
    send('crash', 'failed');
    await waitFor(() => finals().length === 1);
    expect(finals()[0]).toMatchObject({ turnId: 'failed', errorCode: 'execution_failed',
      content: expect.stringContaining('mcode_acp_process_exited') });
    send('healthy', 'next');
    await waitFor(() => finals().length === 2);
    expect(finals()[1]).toMatchObject({ turnId: 'next', content: 'answer:healthy' });
    expect(finals()[1].errorCode).toBeUndefined();
    expect(f.calls().filter(c => c.message?.method === 'session/resume').map(c => c.message.params.sessionId))
      .toEqual(['session_fixture']);
  } finally { child.kill('SIGTERM'); await closed; }
});

it.each([false, true])('exhausts the cumulative budget despite progress and runs the queued turn (resume: %s)', async resume => {
  const f = fixture();
  const child = spawnTsScript(resolve('src/minimax-runner.ts'), ['--mcode-bin', f.options.executable,
    '--cwd', f.root, '--data-dir', join(f.root, 'data'), '--turn-timeout-ms', '2000',
    ...(resume ? ['--native-session-id', 'session_fixture'] : [])], { env: f.options.env }) as ChildProcessWithoutNullStreams;
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  const closed = new Promise<void>(r => child.once('close', () => r()));
  const finals = () => [...stdout.matchAll(/\x1b\]777;botmux:final:([A-Za-z0-9+/=]+)\x07/g)]
    .map(m => JSON.parse(Buffer.from(m[1], 'base64').toString()));
  const send = (content: string, replyTurnId: string) => child.stdin.write(`::botmux-minimax:${Buffer.from(JSON.stringify({ type: 'message', content, replyTurnId })).toString('base64')}\n`);
  try {
    await waitFor(() => stdout.includes('ready'));
    send('progress-hang', 'budget');
    // Queue only after native execution is observed; no stdout chunk assumptions.
    await waitFor(() => stdout.includes('progress-2'));
    send('healthy', 'queued');
    await waitFor(() => finals().length === 2);
    expect(finals()[0]).toMatchObject({ turnId: 'budget', errorCode: 'turn_budget_exhausted' });
    expect(finals()[1]).toMatchObject({ turnId: 'queued', content: 'answer:healthy' });
    expect(f.calls().filter(c => c.message?.method === 'session/resume')).toHaveLength(resume ? 2 : 1);
    await stopped(f.calls()[0].pid);
    await waitFor(() => stdout.endsWith('›\n'));
  } finally { child.kill('SIGTERM'); await closed; }
});

it.each(['permission', 'permission-hang'])('pauses the runner budget for a human and resumes accounting after %s', async content => {
  const f = fixture();
  mkdirSync(join(f.root, '.botmux'), { mode: 0o700 });
  writeFileSync(join(f.root, '.botmux/.dashboard-secret'), 'isolated-test-secret', { mode: 0o600 });
  let pendingAsk: { res: ServerResponse; body: any } | undefined;
  const server = createServer(async (req, res) => {
    const body = await readRequestBodyJson<Record<string, any>>(req);
    if (!body) { res.writeHead(400).end(); return; }
    pendingAsk = { res, body };
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const child = spawnTsScript(resolve('src/minimax-runner.ts'), ['--mcode-bin', f.options.executable,
    '--cwd', f.root, '--turn-timeout-ms', '2000'], { env: { ...f.options.env, HOME: f.root,
      BOTMUX_SESSION_ID: 'budget-session', BOTMUX_LARK_APP_ID: 'budget-app', BOTMUX_CHAT_ID: 'budget-chat',
      BOTMUX_DAEMON_IPC_PORT: String(port) } }) as ChildProcessWithoutNullStreams;
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  const closed = new Promise<void>(r => child.once('close', () => r()));
  const finals = () => [...stdout.matchAll(/\x1b\]777;botmux:final:([A-Za-z0-9+/=]+)\x07/g)]
    .map(m => JSON.parse(Buffer.from(m[1], 'base64').toString()));
  try {
    child.stdin.write(`::botmux-minimax:${Buffer.from(JSON.stringify({ type: 'message', content, replyTurnId: 'human' })).toString('base64')}\n`);
    await waitFor(() => !!pendingAsk || finals().length > 0);
    expect(finals()).toEqual([]);
    expect(pendingAsk!.body).toMatchObject({ originTurnId: 'human', sessionId: 'budget-session' });
    // Loopback probes must neither crash the fixture nor replace the real Ask.
    const ask = pendingAsk;
    for (const body of [undefined, 'not json']) {
      const probe = await fetch(`http://127.0.0.1:${port}/`, {
        method: body === undefined ? 'GET' : 'POST', body, signal: AbortSignal.timeout(5000),
      });
      expect(probe.status).toBe(400);
      await probe.text();
      expect(pendingAsk).toBe(ask);
    }
    // Deliberately cross the configured budget AFTER observing the blocked Ask.
    // This is the timer boundary under test, not a sleep to guess readiness.
    await new Promise(r => setTimeout(r, 2500));
    expect(finals()).toEqual([]);
    expect(pendingAsk!.res.destroyed).toBe(false);
    const key = pendingAsk!.body.questions[0].options[1].key;
    pendingAsk!.res.setHeader('content-type', 'application/json');
    pendingAsk!.res.end(JSON.stringify({ kind: 'answered', answers: [[key]] }));
    await waitFor(() => finals().length === 1);
    expect(finals()[0].turnId).toBe('human');
    if (content === 'permission-hang') {
      expect(finals()[0].errorCode).toBe('turn_budget_exhausted');
      expect(stdout).toContain('progress-2');
    } else {
      expect(finals()[0].errorCode).toBeUndefined();
      expect(finals()[0].content).toContain('deny');
    }
  } finally {
    child.kill('SIGTERM'); await closed;
    await new Promise<void>(r => server.close(() => r()));
  }
});
