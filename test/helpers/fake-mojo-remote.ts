/**
 * Stand-in for the `mojo` CLI (@byted/mojo 1.0.13) *plus* the remote session it
 * talks to, so busy/delivery behaviour can be reproduced without the real
 * binary, a JWT or any network.
 *
 * Everything below mirrors 1.0.13's headless code paths as read from the
 * shipped bundle (`-p --output-format stream-json`, `session get --json`):
 *
 *  - `-p -r <sid>` first reads the session. If its status is RUNNING-like AND
 *    its event history still has a live turn (activity without a trailing
 *    `turn-end`), it refuses BEFORE emitting anything on stdout:
 *        stderr `mojo: 会话 <sid> 正在执行中（RUNNING），稍后再试`, exit 1.
 *  - Otherwise `system/init` is emitted FIRST — before any turn exists — and the
 *    prompt is submitted. When the backend only queues it (`pending_prompt`
 *    with `queued`) and no turn starts within 10s, the CLI aborts and reports
 *        {"type":"result","status":"error","result":"",…,
 *         "error":{"code":"session_busy","message":"prompt 被后端排队而回合未启动…"}}
 *    with exit 1. The queued prompt is NOT withdrawn (the CLI's own message
 *    warns that retrying piles up the queue).
 *  - `session get <sid> --json` reports `state` derived from the CURRENT
 *    turn's status first, so a session that is RUNNING while its current turn
 *    is COMPLETED reads `state:"completed"`.
 *  - In host execution (AGENT_LOCAL_DAEMON≠0, no --cloud, credential not from
 *    X_JWT_TOKEN) every `-p` invocation starts a local mojo-daemon for the
 *    workspace and stops it on exit; `session *` subcommands never do.
 *
 * The queue wait is shortened (QUEUE_WAIT_MS) — its length is not what the
 * tests are about. State lives in one JSON file the test can inspect.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeMojoTurn {
  id: string;
  status: 'RUNNING' | 'COMPLETED';
}

export interface FakeMojoSession {
  /** Server-side session status (the lock). */
  status: 'IDLE' | 'RUNNING';
  currentTurn: FakeMojoTurn | null;
  /** How many more liveness checks (pre-check or `session get`) observe the
   *  current RUNNING turn as still live; at 0 it completes and the lock frees. */
  liveChecks: number;
  /** Prompts the backend queued but never started. */
  pendingPrompts: string[];
}

export interface FakeMojoState {
  sessions: Record<string, FakeMojoSession>;
  /** Every argv the fake was invoked with, in order. */
  invocations: string[][];
  /** X_JWT_TOKEN each invocation saw (null when absent), same order. */
  invocationJwts: Array<string | null>;
  /** Turns the "remote" actually started (the only proof of delivery). */
  startedTurns: Array<{ sessionId: string; turnId: string; prompt: string }>;
  /** Local mojo-daemon starts (host execution, one per `-p` client). */
  daemonStarts: number;
  /** Text the started turn answers with; `{prompt}` is substituted. */
  answer?: string;
}

/**
 * Test-owned overrides, read (never written) by the fake on every invocation,
 * so a test can flip the remote while a busy wait is in progress without
 * racing the fake's own state writes.
 *  - live:    a turn is executing (pre-check refuses, `session get` → running)
 *  - stuck:   lock held, current turn COMPLETED (prompts only get queued)
 *  - free:    idle, a new turn starts
 *  - refuses: self-contradicting remote — the pre-check keeps refusing while
 *             `session get` reports the current turn completed
 *  - flaps:   the pre-check keeps refusing while `session get` alternates
 *             running / completed
 */
export interface FakeMojoControl {
  sessions?: Record<string, 'live' | 'stuck' | 'free' | 'refuses' | 'flaps'>;
  /** `session cancel` fails (exit 1, nothing on stdout). */
  cancelFails?: boolean;
  /** `session cancel` takes this long before answering. */
  cancelDelayMs?: number;
  /** A started turn waits this long before streaming its answer. */
  answerDelayMs?: number;
  /** `session get` takes this long before answering. */
  getDelayMs?: number;
  /** `-p` prints a plain-text notice line on stdout first (update hint). */
  stdoutNotice?: boolean;
  /** The pre-check refusal is written only after this delay (slow runner). */
  precheckDelayMs?: number;
}

export interface FakeMojoRemote {
  bin: string;
  read(): FakeMojoState;
  write(state: FakeMojoState): void;
  control(next: FakeMojoControl): void;
  /** `-p` invocations only (each one is a full client launch). */
  printInvocations(): string[][];
  /** `session get` invocations only. */
  sessionGetInvocations(): string[][];
}

/** A session stuck the way the field report describes: RUNNING lock held,
 *  current turn already COMPLETED. */
export function stuckSession(turnId = '7e1d0c3a-2f6b-4c55-8e21-d0e5c0de7a11'): FakeMojoSession {
  return { status: 'RUNNING', currentTurn: { id: turnId, status: 'COMPLETED' }, liveChecks: 0, pendingPrompts: [] };
}

/** A session genuinely executing a turn for `checks` more liveness checks. */
export function liveSession(checks: number, turnId = 'live-turn-1'): FakeMojoSession {
  return { status: 'RUNNING', currentTurn: { id: turnId, status: 'RUNNING' }, liveChecks: checks, pendingPrompts: [] };
}

export function idleSession(turnId = 'done-turn-1'): FakeMojoSession {
  return { status: 'IDLE', currentTurn: { id: turnId, status: 'COMPLETED' }, liveChecks: 0, pendingPrompts: [] };
}

const SCRIPT = String.raw`
const fs = require('fs');
const STATE = process.argv[2];
const QUEUE_WAIT_MS = Number(process.argv[3]);
const CONTROL = process.argv[4];
const argv = process.argv.slice(5);
const RUNNING_SET = new Set(['RUNNING', 'WORKING', 'WAIT_CONFIRM', 'WAIT_USER']);
const load = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const save = (s) => { fs.writeFileSync(STATE + '.tmp', JSON.stringify(s, null, 2)); fs.renameSync(STATE + '.tmp', STATE); };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** One liveness check of a session's current turn; consumes one check. */
function observeLive(sess) {
  const live = !!sess.currentTurn && sess.currentTurn.status === 'RUNNING' && sess.liveChecks > 0;
  if (live) {
    sess.liveChecks -= 1;
    if (sess.liveChecks <= 0) { sess.currentTurn.status = 'COMPLETED'; sess.status = 'IDLE'; }
  }
  return live;
}

function envelope(fields) {
  return {
    schema_version: 1, operation: fields.operation, status: fields.error ? 'error' : 'completed',
    state: fields.state || 'unknown', session_id: fields.sessionId || null, turn_id: fields.turnId || null,
    workspace_id: null, result: null, result_complete: false, interaction: null, duration_ms: 7,
    warnings: [], error: fields.error || null,
  };
}

function applyControl(s, control) {
  for (const [sid, mode] of Object.entries(control.sessions || {})) {
    const sess = s.sessions[sid];
    if (!sess) continue;
    const id = (sess.currentTurn && sess.currentTurn.id) || 'ctl-turn';
    if (mode === 'live' || mode === 'refuses' || mode === 'flaps') {
      sess.status = 'RUNNING'; sess.currentTurn = { id, status: 'RUNNING' }; sess.liveChecks = 1e9;
    } else if (mode === 'stuck') {
      sess.status = 'RUNNING'; sess.currentTurn = { id, status: 'COMPLETED' }; sess.liveChecks = 0;
    } else if (mode === 'free') {
      sess.status = 'IDLE'; sess.currentTurn = { id, status: 'COMPLETED' }; sess.liveChecks = 0;
    }
  }
}

async function main() {
  const s = load();
  const control = fs.existsSync(CONTROL) ? JSON.parse(fs.readFileSync(CONTROL, 'utf8')) : {};
  applyControl(s, control);
  const refuses = (sid) => (control.sessions || {})[sid] === 'refuses';
  const flaps = (sid) => (control.sessions || {})[sid] === 'flaps';
  s.invocations.push(argv);
  s.invocationJwts.push(process.env.X_JWT_TOKEN || null);
  if (argv[0] === 'session') {
    const sub = argv[1];
    const sid = argv[2];
    const sess = s.sessions[sid];
    if (!sess) {
      save(s);
      out(envelope({ operation: 'session.' + sub, sessionId: sid, error: { code: 'not_found', message: '会话 ' + sid + ' 不存在或不可访问', retryable: false } }));
      process.exit(1);
    }
    if (sub === 'get') {
      const gets = s.invocations.filter(a => a[0] === 'session' && a[1] === 'get').length;
      const live = refuses(sid) ? false : flaps(sid) ? gets % 2 === 1 : observeLive(sess);
      save(s);
      if (control.getDelayMs) await sleep(control.getDelayMs);
      const turn = sess.currentTurn;
      const state = refuses(sid) ? 'completed' : flaps(sid) ? (live ? 'running' : 'completed') : live ? 'running' : (turn && turn.status === 'COMPLETED' ? 'completed' : (sess.status === 'RUNNING' ? 'running' : 'idle'));
      out(envelope({ operation: 'session.get', sessionId: sid, turnId: turn && turn.id, state }));
      process.exit(0);
    }
    save(s);
    if (sub === 'cancel' && control.cancelDelayMs) await sleep(control.cancelDelayMs);
    if (sub === 'cancel' && control.cancelFails) { process.stderr.write('mojo: network unreachable\n'); process.exit(1); }
    out(envelope({ operation: 'session.' + sub, sessionId: sid, turnId: sess.currentTurn && sess.currentTurn.id, state: 'already_terminal' }));
    process.exit(0);
  }
  if (argv[0] === 'auth') { save(s); out({ logged_in: true, mode: 'jwt', source: 'env' }); process.exit(0); }

  // ── -p (headless foreground) ──────────────────────────────────────────────
  const prompt = argv[argv.length - 1] || '';
  const rIdx = argv.indexOf('-r');
  const resume = rIdx >= 0 ? argv[rIdx + 1] : undefined;
  if (control.stdoutNotice) process.stdout.write('mojo: 发现新版本 9.9.9，运行 mojo update 升级\n');
  const hostExec = process.env.AGENT_LOCAL_DAEMON !== '0' && !argv.includes('--cloud') && !process.env.X_JWT_TOKEN;
  if (hostExec) s.daemonStarts += 1;
  let sid = resume;
  let sess;
  if (resume) {
    sess = s.sessions[resume];
    if (!sess) { save(s); process.stderr.write('mojo: 会话 ' + resume + ' 不存在或不可访问\n'); process.exit(1); }
    if (RUNNING_SET.has(sess.status) && observeLive(sess)) {
      save(s);
      if (control.precheckDelayMs) await sleep(control.precheckDelayMs);
      process.stderr.write('mojo: 会话 ' + resume + ' 正在执行中（' + 'RUNNING' + '），稍后再试\n');
      process.exit(1);
    }
  } else {
    sid = 'sid-fake-new-' + (Object.keys(s.sessions).length + 1);
    sess = { status: 'IDLE', currentTurn: null, liveChecks: 0, pendingPrompts: [] };
    s.sessions[sid] = sess;
  }
  save(s);
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'gpt-5.4-2026-03-05' });

  if (sess.status === 'RUNNING') {
    // Lock held although no turn is live: the backend only queues the prompt.
    const full = sess.pendingPrompts.length >= 5;
    if (!full) sess.pendingPrompts.push(prompt);
    save(s);
    await sleep(QUEUE_WAIT_MS);
    if (full) {
      out({ type: 'result', status: 'timeout', result: '', session_id: sid, duration_ms: QUEUE_WAIT_MS, num_tool_calls: 0, warnings: [],
        error: { code: 'stalled', message: '连续 300s 无任何回合事件，空闲护栏中止（调大 --idle-timeout 或 --no-idle-timeout 关闭）：已运行 300s，未收到任何事件' } });
      process.exit(1);
    }
    out({ type: 'result', status: 'error', result: '', session_id: sid, duration_ms: QUEUE_WAIT_MS, num_tool_calls: 0, warnings: [],
      error: { code: 'session_busy', message: 'prompt 被后端排队而回合未启动：会话仍被上一回合占用（其状态可能已卡死）。建议换新会话或稍后重试；注意反复重试会在该会话队列中堆积消息。' } });
    process.exit(1);
  }

  const turnId = 'turn-' + (s.startedTurns.length + 1);
  sess.status = 'RUNNING';
  sess.currentTurn = { id: turnId, status: 'RUNNING' };
  s.startedTurns.push({ sessionId: sid, turnId, prompt });
  save(s);
  if (control.answerDelayMs) await sleep(control.answerDelayMs);
  const answer = (s.answer ?? '已收到：{prompt}').replace('{prompt}', prompt.slice(-40));
  out({ type: 'text_delta', text: answer });
  out({ type: 'text', text: answer });
  const done = load();
  done.sessions[sid].status = 'IDLE';
  done.sessions[sid].currentTurn = { id: turnId, status: 'COMPLETED' };
  save(done);
  out({ type: 'result', status: 'completed', result: answer, session_id: sid, duration_ms: 12, num_tool_calls: 0, warnings: [], error: null });
  process.exit(0);
}
main().catch((e) => { process.stderr.write('fake mojo crashed: ' + (e && e.stack || e) + '\n'); process.exit(70); });
`;

/**
 * Write the fake into `dir` (as `fileName`, default `mojo`) seeded with
 * `sessions`. `queueWaitMs` replaces 1.0.13's fixed 10s "no turn started" wait.
 */
export function writeFakeMojoRemote(
  dir: string,
  sessions: Record<string, FakeMojoSession>,
  opts: { fileName?: string; queueWaitMs?: number; answer?: string } = {},
): FakeMojoRemote {
  const statePath = join(dir, 'fake-mojo-state.json');
  const scriptPath = join(dir, 'fake-mojo-remote.cjs');
  const controlPath = join(dir, 'fake-mojo-control.json');
  const initial: FakeMojoState = {
    sessions, invocations: [], invocationJwts: [], startedTurns: [], daemonStarts: 0,
    ...(opts.answer !== undefined ? { answer: opts.answer } : {}),
  };
  writeFileSync(statePath, JSON.stringify(initial, null, 2));
  writeFileSync(scriptPath, SCRIPT);
  const bin = join(dir, opts.fileName ?? 'mojo');
  // `.cjs` + explicit `node`: a package.json with "type":"module" above the
  // temp dir must not reinterpret the script.
  writeFileSync(bin, `#!/usr/bin/env bash\nexec node ${JSON.stringify(scriptPath)} ${JSON.stringify(statePath)} ${opts.queueWaitMs ?? 300} ${JSON.stringify(controlPath)} "$@"\n`);
  chmodSync(bin, 0o755);
  const read = (): FakeMojoState => JSON.parse(readFileSync(statePath, 'utf-8')) as FakeMojoState;
  return {
    bin,
    read,
    write: (state) => writeFileSync(statePath, JSON.stringify(state, null, 2)),
    control: (next) => {
      writeFileSync(`${controlPath}.tmp`, JSON.stringify(next));
      renameSync(`${controlPath}.tmp`, controlPath);
    },
    printInvocations: () => read().invocations.filter(a => a.includes('-p')),
    sessionGetInvocations: () => read().invocations.filter(a => a[0] === 'session' && a[1] === 'get'),
  };
}
