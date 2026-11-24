import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTurnReplyCard } from '../src/im/lark/turn-reply-card.js';
import { TurnReplyCardStore } from '../src/services/turn-reply-card.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { SOURCE_WORKER_LOAD_TIMEOUT_MS, spawnLoadedSourceWorker } from './helpers/source-worker-boot.js';

type Row = Record<string, unknown>;
type ScheduledRow = { delayMs: number; row?: Row; stdout?: string };

let child: ChildProcess | undefined;
let root: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise<void>(done => child!.once('exit', () => done()));
    child.kill('SIGKILL');
    await Promise.race([stopped, new Promise<void>(done => setTimeout(done, 2_000))]);
  }
  child = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function waitUntil(check: () => boolean, logs: string[], timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    if (child?.exitCode !== null || child?.signalCode !== null) {
      throw new Error(`Worker exited unexpectedly\n${logs.join('')}`);
    }
    await new Promise(done => setTimeout(done, 40));
  }
  throw new Error(`Timed out waiting for condition\n${logs.join('')}`);
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const zeroUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

async function startScriptedWorker(opts: {
  script: ScheduledRow[];
  workerEnv?: Record<string, string>;
}) {
  root = mkdtempSync(join(tmpdir(), 'botmux-claude-open-turn-'));
  const workDir = join(root, 'work');
  const dataDir = join(root, 'data');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const cliSessionId = `deadbeef-1234-4678-9abc-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const projectDir = join(root, '.claude', 'projects', realpathSync(workDir).replace(/[^A-Za-z0-9-]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${cliSessionId}.jsonl`);
  // Seed one historical closed turn so durationMarkerSeen is proven true (real Claude 2.1.x).
  writeFileSync(transcript, [
    { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: cliSessionId },
    { type: 'user', uuid: 'u0', parentUuid: null, timestamp: minutesAgo(30), message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a0', parentUuid: 'u0', timestamp: minutesAgo(30), message: { id: 'm0', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', usage: { ...zeroUsage, output_tokens: 5 }, content: [{ type: 'text', text: 'hello' }] } },
    { type: 'system', subtype: 'turn_duration', uuid: 'd0', parentUuid: 'a0', timestamp: minutesAgo(30), durationMs: 1_000 },
  ].map(row => `${JSON.stringify(row)}\n`).join(''));

  const fakeClaude = join(root, 'fake-claude');
  writeFileSync(fakeClaude, `#!/usr/bin/env node
import('node:fs').then(fs => {
const T = ${JSON.stringify(transcript)};
const SCRIPT = ${JSON.stringify(opts.script)};
const put = row => fs.appendFileSync(T, JSON.stringify({ timestamp: new Date().toISOString(), ...row }) + '\\n');
// Render composer without "esc to interrupt" (matches custom statusLine suppression).
process.stdout.write('❯ \\r\\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\\r\\n');
let typed = '';
process.stdin.on('data', chunk => {
  typed += chunk.toString();
  if (!/[\\r\\n]$/.test(typed)) return;
  if (typed.includes('\\x1b[200~') && !typed.includes('\\x1b[201~')) return;
  const prompt = typed.replace(/\\x1b\\[20[01]~/g, '').trim();
  typed = '';
  put({ type: 'user', uuid: 'u1', parentUuid: 'd0', message: { role: 'user', content: prompt } });
  // Redraw idle-looking composer immediately (no busy marker) so screen quiescence fires at +2s.
  process.stdout.write('\\r\\n❯ \\r\\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\\r\\n');
  for (const step of SCRIPT) {
    setTimeout(() => {
      if (step.row) put(step.row);
      if (step.stdout) process.stdout.write(step.stdout);
    }, step.delayMs);
  }
});
});
`);
  chmodSync(fakeClaude, 0o755);

  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const sid = `sid-open-turn-${randomUUID()}`;
  const booted = spawnLoadedSourceWorker({
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: sid,
      LARK_APP_ID: 'app_test',
      LARK_APP_SECRET: 'test-only',
      ...opts.workerEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child = booted.child;
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  await booted.loaded;

  child.send({
    type: 'init',
    sessionId: sid,
    chatId: 'oc_test',
    rootMessageId: 'om_root',
    workingDir: workDir,
    cliId: 'claude-code',
    cliPathOverride: fakeClaude,
    cliSessionId,
    backendType: 'pty',
    prompt: '',
    resume: true,
    larkAppId: 'app_test',
    larkAppSecret: 'test-only',
    locale: 'zh',
  } satisfies DaemonToWorker);

  await waitUntil(() => messages.some(m => m.type === 'prompt_ready'), logs);
  return { sid, dataDir, transcript, messages, logs };
}

describe('Claude Code open-turn hold, authority retention, and Scenario 3 recovery (#3702)', () => {
  it('Scenario 1: holds open IM turn & active turn authority across false screen-idle while waiting for API TTFT', async () => {
    const w = await startScriptedWorker({
      script: [
        { delayMs: 100, row: { type: 'api-request', id: 'req_ttft', querySource: 'repl_main_thread' } },
        // Silence for 6.5s (well past 2s quiescence + 2s ptyIdleSettle), then real final arrives with NO stdout write.
        {
          delayMs: 6_500,
          row: {
            type: 'assistant', uuid: 'a_ttft', parentUuid: 'u1',
            message: { id: 'm1', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', usage: { ...zeroUsage, output_tokens: 30 }, content: [{ type: 'text', text: 'TTFT final answer.' }] },
          },
        },
        { delayMs: 6_700, row: { type: 'system', subtype: 'turn_duration', uuid: 'd1', parentUuid: 'a_ttft', durationMs: 6_700 } },
      ],
    });

    const from = w.messages.length;
    child!.send({ type: 'message', content: 'analyze slow api', turnId: 'om_ttft' } satisfies DaemonToWorker);

    // Wait past the old 4s false-idle truncation point; turn must STILL be open with authority intact!
    await new Promise(done => setTimeout(done, 5_000));
    const mid = w.messages.slice(from);
    expect(mid.filter(m => m.type === 'turn_terminal' && m.turnId === 'om_ttft')).toEqual([]);
    expect(mid.filter(m => m.type === 'managed_turn_origin_revoked')).toEqual([]);
    expect(mid.filter(m => m.type === 'prompt_ready')).toEqual([]);

    // Once real final + turn_duration land, worker emits final_output, completed turn_terminal, and prompt_ready.
    await waitUntil(
      () => w.messages.slice(from).some(m => m.type === 'turn_terminal' && m.turnId === 'om_ttft')
        && w.messages.slice(from).some(m => m.type === 'prompt_ready'),
      w.logs,
    );
    const after = w.messages.slice(from);
    expect(after.filter(m => m.type === 'final_output')).toEqual([
      expect.objectContaining({ turnId: 'om_ttft', content: 'TTFT final answer.' }),
    ]);
    const terminals = after.filter((m): m is Extract<WorkerToDaemon, { type: 'turn_terminal' }> =>
      m.type === 'turn_terminal' && m.turnId === 'om_ttft');
    expect(terminals).toHaveLength(1);
    expect(terminals[0].status).toBe('completed');
    expect(terminals[0].outputDisposition).toBeUndefined();
    expect(w.logs.join('')).not.toContain('local-typed');
  }, SOURCE_WORKER_LOAD_TIMEOUT_MS + 45_000);

  it('Scenario 2: holds open IM turn across tool-use gap and mid-turn attachment reminder, delivering only final reply', async () => {
    const w = await startScriptedWorker({
      script: [
        {
          delayMs: 200,
          row: {
            type: 'assistant', uuid: 'a_nar', parentUuid: 'u1',
            message: { id: 'm1', role: 'assistant', model: 'claude-test', stop_reason: null, usage: { ...zeroUsage, output_tokens: 10 }, content: [{ type: 'text', text: 'Let me run a check.' }] },
          },
        },
        {
          delayMs: 300,
          row: {
            type: 'assistant', uuid: 'a_tool', parentUuid: 'a_nar',
            message: { id: 'm1', role: 'assistant', model: 'claude-test', stop_reason: 'tool_use', usage: { ...zeroUsage, output_tokens: 15 }, content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] },
          },
        },
        // 5.5s silent tool gap (past 2s quiescence + 2s settle)
        {
          delayMs: 5_800,
          row: {
            type: 'user', uuid: 'u_tr', parentUuid: 'a_tool',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file.ts' }] },
          },
        },
        {
          delayMs: 5_900,
          row: {
            type: 'attachment', uuid: 'att_1', parentUuid: 'u_tr',
            attachment: { type: 'inactivity_reminder', text: "The user hasn't heard from you in a while" },
          },
        },
        // Another 5s silent API wait after attachment reminder
        {
          delayMs: 10_900,
          row: {
            type: 'assistant', uuid: 'a_final', parentUuid: 'att_1',
            message: { id: 'm2', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', usage: { ...zeroUsage, output_tokens: 25 }, content: [{ type: 'text', text: 'Tool loop finished cleanly.' }] },
          },
        },
        { delayMs: 11_100, row: { type: 'system', subtype: 'turn_duration', uuid: 'd1', parentUuid: 'a_final', durationMs: 11_100 } },
      ],
    });

    const from = w.messages.length;
    child!.send({ type: 'message', content: 'inspect repo files', turnId: 'om_tool_gap' } satisfies DaemonToWorker);

    await new Promise(done => setTimeout(done, 8_000));
    const mid = w.messages.slice(from);
    expect(mid.filter(m => m.type === 'turn_terminal' && m.turnId === 'om_tool_gap')).toEqual([]);
    expect(mid.filter(m => m.type === 'managed_turn_origin_revoked')).toEqual([]);

    await waitUntil(
      () => w.messages.slice(from).some(m => m.type === 'turn_terminal' && m.turnId === 'om_tool_gap')
        && w.messages.slice(from).some(m => m.type === 'prompt_ready'),
      w.logs,
    );
    const after = w.messages.slice(from);
    expect(after.filter(m => m.type === 'final_output')).toEqual([
      expect.objectContaining({ turnId: 'om_tool_gap', content: 'Tool loop finished cleanly.' }),
    ]);
    expect(after.filter(m => m.type === 'turn_terminal' && m.turnId === 'om_tool_gap')).toHaveLength(1);
    expect(w.logs.join('')).not.toContain('local-typed');
  }, SOURCE_WORKER_LOAD_TIMEOUT_MS + 60_000);

  it('Scenario 3A: late final after bounded unobserved close re-attaches to om_xxx and PATCHes Unified reply card in-place', async () => {
    const w = await startScriptedWorker({
      workerEnv: { BOTMUX_TEST_CLAUDE_OPEN_TURN_INFLIGHT_MS: '1000' },
      script: [
        { delayMs: 100, row: { type: 'api-request', id: 'req_late', querySource: 'repl_main_thread' } },
        // Bounded watchdog expires around ~5-6s; late tool + final reply arrives at 8.5s.
        {
          delayMs: 8_500,
          row: {
            type: 'assistant', uuid: 'a_late_tool', parentUuid: 'u1',
            message: { id: 'm1', role: 'assistant', model: 'claude-test', stop_reason: 'tool_use', usage: { ...zeroUsage, output_tokens: 10 }, content: [{ type: 'tool_use', id: 'tu_late', name: 'Read', input: {} }] },
          },
        },
        {
          delayMs: 8_600,
          row: {
            type: 'user', uuid: 'tr_late', parentUuid: 'a_late_tool',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_late', content: 'ok' }] },
          },
        },
        {
          delayMs: 8_700,
          row: {
            type: 'assistant', uuid: 'a_late_final', parentUuid: 'tr_late',
            message: { id: 'm2', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', usage: { ...zeroUsage, output_tokens: 20 }, content: [{ type: 'text', text: 'Late recovered answer!' }] },
          },
        },
        { delayMs: 8_800, row: { type: 'system', subtype: 'turn_duration', uuid: 'd_late', parentUuid: 'a_late_final', durationMs: 8_800 } },
      ],
    });

    const from = w.messages.length;
    child!.send({ type: 'message', content: 'very slow task', turnId: 'om_late_3a' } satisfies DaemonToWorker);

    // First, bounded unobserved fallback closes om_late_3a.
    await waitUntil(
      () => w.messages.slice(from).some(m => m.type === 'turn_terminal' && m.turnId === 'om_late_3a'),
      w.logs,
    );
    const firstTerm = w.messages.slice(from).find(
      (m): m is Extract<WorkerToDaemon, { type: 'turn_terminal' }> => m.type === 'turn_terminal' && m.turnId === 'om_late_3a',
    )!;
    expect(firstTerm.outputDisposition).toBe('boundary_unobserved');

    // Then late final_output arrives under original om_late_3a — NOT suppressed as local-headless!
    await waitUntil(
      () => w.messages.slice(from).some(m => m.type === 'final_output' && m.turnId === 'om_late_3a'),
      w.logs,
    );
    await new Promise(done => setTimeout(done, 1_000));
    const after = w.messages.slice(from);
    expect(after.filter(m => m.type === 'final_output')).toEqual([
      expect.objectContaining({ turnId: 'om_late_3a', content: 'Late recovered answer!' }),
    ]);
    // Still only ONE turn_terminal emitted for om_late_3a.
    expect(after.filter(m => m.type === 'turn_terminal' && m.turnId === 'om_late_3a')).toHaveLength(1);
    expect(w.logs.join('')).not.toContain('local-typed');

    // Verify real TurnReplyCardStore PATCHes the existing card in-place (replaces empty-reply placeholder).
    const cardStore = new TurnReplyCardStore(w.dataDir);
    const posted: string[] = [];
    const patched: Array<{ id: string; body: string }> = [];
    const identity = { larkAppId: 'app_test', sessionId: w.sid, turnId: 'om_late_3a' };
    await cardStore.prepare(identity, { mode: 'unified', chatId: 'oc_test', rootId: 'om_root', nativeCot: false });
    const transport = {
      render: (record: Parameters<typeof buildTurnReplyCard>[0]) =>
        buildTurnReplyCard(record, { locale: 'zh', showProcess: true, cliDisplayName: 'Claude Code' }),
      send: async (body: string) => { posted.push(body); return 'om_card_1'; },
      patch: async (id: string, body: string) => { patched.push({ id, body }); },
      beforeEffect: () => {},
      isWithdrawn: () => false,
    };
    await cardStore.update(identity, { kind: 'terminal', phase: 'completed' }, transport);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('本轮没有提供最终答复');
    await cardStore.update(identity, {
      kind: 'final',
      text: 'Late recovered answer!',
      card: JSON.stringify({ schema: '2.0', config: { wide_screen_mode: true }, body: { elements: [{ tag: 'markdown', content: 'Late recovered answer!' }] } }),
      source: 'bridge',
    }, transport);
    expect(posted).toHaveLength(1);
    expect(patched).toHaveLength(1);
    expect(patched[0].id).toBe('om_card_1');
    expect(patched[0].body).toContain('Late recovered answer!');
    expect(patched[0].body).not.toContain('本轮没有提供最终答复');
  }, SOURCE_WORKER_LOAD_TIMEOUT_MS + 45_000);

  it('Scenario 3B: when partial text already emitted at unobserved close, late final uses late-recovery-* anchored to om_xxx', async () => {
    const w = await startScriptedWorker({
      workerEnv: { BOTMUX_TEST_CLAUDE_OPEN_TURN_QUIET_MS: '1000' },
      script: [
        {
          delayMs: 200,
          row: {
            type: 'assistant', uuid: 'a_part', parentUuid: 'u1',
            message: { id: 'm1', role: 'assistant', model: 'claude-test', stop_reason: null, usage: { ...zeroUsage, output_tokens: 10 }, content: [{ type: 'text', text: 'Interim partial.' }] },
          },
        },
        // Unmarked partial watchdog pops around ~5-6s and emits Interim partial.
        // Late tool + final answer lands at 8.5s.
        {
          delayMs: 8_500,
          row: {
            type: 'assistant', uuid: 'a_t', parentUuid: 'a_part',
            message: { id: 'm1', role: 'assistant', model: 'claude-test', stop_reason: 'tool_use', usage: { ...zeroUsage, output_tokens: 12 }, content: [{ type: 'tool_use', id: 'tu_3b', name: 'Read', input: {} }] },
          },
        },
        {
          delayMs: 8_600,
          row: {
            type: 'user', uuid: 'tr_3b', parentUuid: 'a_t',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_3b', content: 'ok' }] },
          },
        },
        {
          delayMs: 8_700,
          row: {
            type: 'assistant', uuid: 'a_3b_final', parentUuid: 'tr_3b',
            message: { id: 'm2', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', usage: { ...zeroUsage, output_tokens: 20 }, content: [{ type: 'text', text: 'True final 3B.' }] },
          },
        },
        { delayMs: 8_800, row: { type: 'system', subtype: 'turn_duration', uuid: 'd_3b', parentUuid: 'a_3b_final', durationMs: 8_800 } },
      ],
    });

    const from = w.messages.length;
    child!.send({ type: 'message', content: 'partial then real final', turnId: 'om_late_3b' } satisfies DaemonToWorker);

    await waitUntil(
      () => w.messages.slice(from).filter(m => m.type === 'final_output').length >= 2,
      w.logs,
    );
    await new Promise(done => setTimeout(done, 1_000));
    const after = w.messages.slice(from);
    const finals = after.filter((m): m is Extract<WorkerToDaemon, { type: 'final_output' }> => m.type === 'final_output');
    expect(finals).toEqual([
      expect.objectContaining({ turnId: 'om_late_3b', content: 'Interim partial.' }),
      expect.objectContaining({ turnId: 'late-recovery-a_3b_final', replyTurnId: 'om_late_3b', content: 'True final 3B.' }),
    ]);
    expect(after.filter(m => m.type === 'turn_terminal')).toHaveLength(1);
  }, SOURCE_WORKER_LOAD_TIMEOUT_MS + 45_000);

  it('Control: true local terminal turn after unobserved close remains suppressed as local-typed', async () => {
    const w = await startScriptedWorker({
      workerEnv: { BOTMUX_TEST_CLAUDE_OPEN_TURN_QUIET_MS: '1000' },
      script: [
        // Bare user turn pops unobserved around ~5-6s, then human types a true local prompt at 8.5s.
        { delayMs: 8_500, row: { type: 'user', uuid: 'u_local', parentUuid: 'u1', message: { role: 'user', content: 'local shell check' } } },
        {
          delayMs: 8_600,
          row: {
            type: 'assistant', uuid: 'a_local', parentUuid: 'u_local',
            message: { id: 'm_loc', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', usage: { ...zeroUsage, output_tokens: 15 }, content: [{ type: 'text', text: 'Secret local output.' }] },
          },
        },
        { delayMs: 8_700, row: { type: 'system', subtype: 'turn_duration', uuid: 'd_local', parentUuid: 'a_local', durationMs: 200 } },
      ],
    });

    const from = w.messages.length;
    child!.send({ type: 'message', content: 'im unobserved control', turnId: 'om_ctrl' } satisfies DaemonToWorker);

    await waitUntil(
      () => w.logs.join('').includes('Bridge fallback suppressed for turn local-u_'),
      w.logs,
    );
    await new Promise(done => setTimeout(done, 1_000));
    expect(w.messages.slice(from).filter(m => m.type === 'final_output')).toEqual([]);
  }, SOURCE_WORKER_LOAD_TIMEOUT_MS + 45_000);

  it('Control: user interrupt marker immediately settles a held tool-use turn as cancelled without waiting for tool cap', async () => {
    const w = await startScriptedWorker({
      script: [
        {
          delayMs: 200,
          row: {
            type: 'assistant', uuid: 'a_t_int', parentUuid: 'u1',
            message: { id: 'm1', role: 'assistant', model: 'claude-test', stop_reason: 'tool_use', usage: { ...zeroUsage, output_tokens: 10 }, content: [{ type: 'tool_use', id: 'tu_int', name: 'Bash', input: {} }] },
          },
        },
        // Held across 5s quiet screen, then user hits Esc -> interrupt marker written.
        {
          delayMs: 5_500,
          row: {
            type: 'user', uuid: 'u_int', parentUuid: 'a_t_int',
            message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
          },
        },
      ],
    });

    const from = w.messages.length;
    child!.send({ type: 'message', content: 'long command to cancel', turnId: 'om_cancel' } satisfies DaemonToWorker);

    await waitUntil(
      () => w.messages.slice(from).some(m => m.type === 'turn_terminal' && m.turnId === 'om_cancel')
        && w.messages.slice(from).some(m => m.type === 'prompt_ready'),
      w.logs,
    );
    const terminals = w.messages.slice(from).filter(
      (m): m is Extract<WorkerToDaemon, { type: 'turn_terminal' }> => m.type === 'turn_terminal' && m.turnId === 'om_cancel',
    );
    expect(terminals).toEqual([expect.objectContaining({
      turnId: 'om_cancel',
      status: 'cancelled',
      errorCode: 'user_interrupted',
    })]);
  }, SOURCE_WORKER_LOAD_TIMEOUT_MS + 45_000);
});
