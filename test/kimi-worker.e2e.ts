/**
 * Opt-in real-worker smoke for Kimi's reply-card activity: the real botmux
 * worker process (src/worker.ts) over its daemon IPC, a real logged-in Kimi
 * Code, and the real tmux backend. No Feishu traffic (apiOnly).
 *
 * Verifies, against Kimi's real wire log:
 *   - a turn's thinking and tool activity reach the daemon as `thinking_update`
 *     for THAT turn, and the closing answer is not duplicated into it,
 *   - the next turn's activity does not leak into the previous turn and vice
 *     versa,
 *   - native usage (tokens, context window, model) resolves for the session,
 *   - a respawn with resume follows the resumed session without replaying
 *     history into the new turn,
 *   - `/new` inside the running Kimi moves the observer to the new session.
 *
 * Kimi asks to trust every new working directory, so point the test at one
 * Kimi already trusts:
 *   BOTMUX_KIMI_E2E=1 BOTMUX_KIMI_E2E_CWD=/path/to/trusted/dir \
 *     vitest run --project e2e test/kimi-worker.e2e.ts
 */
import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CotEntry, DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { killWorkerTmuxSession, workerTmuxArgs } from './helpers/worker-tmux-session.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const roots: string[] = [];
const children: ChildProcess[] = [];
const tmuxSessions: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
      await pause(1500);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  for (const name of tmuxSessions.splice(0)) killWorkerTmuxSession(name);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function startWorker(opts: { root: string; cwd: string; sessionId: string; resume?: boolean }) {
  const dataDir = join(opts.root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: opts.sessionId, BOTMUX_NO_CLAIM: '1',
    LARK_APP_ID: 'app_kimi_e2e', LARK_APP_SECRET: 'test-secret',
  };
  const child = spawnTsScript(resolve('src/worker.ts'), [], { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  child.on('message', m => messages.push(m as WorkerToDaemon));
  child.stdout?.on('data', b => logs.push(b.toString()));
  child.stderr?.on('data', b => logs.push(b.toString()));
  child.send({
    type: 'init', sessionId: opts.sessionId, chatId: 'oc_kimi_e2e', chatType: 'group', rootMessageId: 'om_root',
    workingDir: opts.cwd, cliId: 'kimi', backendType: 'tmux', prompt: '', apiOnly: true,
    resume: opts.resume, larkAppId: 'app_kimi_e2e', larkAppSecret: 'test-secret',
  } satisfies DaemonToWorker);
  const log = () => logs.join('');
  const waitFor = async (cond: () => boolean, what: string, timeoutMs = 180_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() >= deadline || child.exitCode != null) {
        const types = messages.map(m => m.type + ('turnId' in m && m.turnId ? `:${m.turnId}` : '')).join(' ');
        throw new Error(`worker timed out: ${what}\n--- ipc ---\n${types.slice(-3000)}\n--- logs ---\n${log().slice(-6000)}`);
      }
      await pause(250);
    }
  };
  // The routing envelope every botmux prompt starts with is what ties a Kimi
  // session to its botmux session; the daemon adds it in production.
  const send = (text: string, turnId: string) =>
    child.send({ type: 'message', content: `<session_id>${opts.sessionId}</session_id>\n${text}`, turnId } satisfies DaemonToWorker);
  /** The turn is settled once the CLI is idle again after its input was
   *  started executing (the daemon closes an ordinary Kimi turn on `prompt_ready`). */
  const settled = (turnId: string) => {
    const committed = messages.findIndex(m => m.type === 'turn_execution_started' && m.turnId === turnId);
    return committed >= 0 && messages.slice(committed + 1).some(m => m.type === 'prompt_ready');
  };
  /** Latest cumulative activity the worker published for `turnId`. */
  const activity = (turnId: string): CotEntry[] => {
    const updates = messages.filter((m): m is Extract<WorkerToDaemon, { type: 'thinking_update' }> =>
      m.type === 'thinking_update' && m.turnId === turnId);
    return updates.at(-1)?.entries ?? [];
  };
  return { child, messages, log, waitFor, send, settled, activity };
}

const toolIds = (entries: readonly CotEntry[]) =>
  entries.filter((e): e is Extract<CotEntry, { kind: 'tool_call' }> => e.kind === 'tool_call').map(e => e.id);
const hasToolMentioning = (entries: readonly CotEntry[], token: string) =>
  entries.some(e => e.kind === 'tool_call' && (e.args.includes(token) || (e.subject ?? '').includes(token)));

describe.runIf(process.env.BOTMUX_KIMI_E2E === '1')('Kimi reply-card activity through the real worker', () => {
  it('streams per-turn thinking and tools, resolves usage, and resumes without replay', async () => {
    const cwd = process.env.BOTMUX_KIMI_E2E_CWD;
    if (!cwd) throw new Error('Set BOTMUX_KIMI_E2E_CWD to a working directory Kimi already trusts');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-kimi-')));
    roots.push(root);
    const sessionId = randomUUID();
    tmuxSessions.push(TmuxBackend.sessionName(sessionId));
    const token = `KE2E${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    // A live private server makes a missing pane a definite `missing`, rather
    // than an absent-socket `unknown` on a developer host with other servers.
    const anchor = `kimi-anchor-${randomUUID()}`;
    execFileSync('tmux', [...workerTmuxArgs(), 'new-session', '-d', '-s', anchor, 'sleep', '900'], { timeout: 5000 });
    tmuxSessions.push(anchor);

    const w = startWorker({ root, cwd, sessionId });
    await w.waitFor(() => w.messages.some(m => m.type === 'ready'), 'worker ready', 60_000);

    // Turn 1: one tool call, then a fixed short answer.
    w.send(`Use your shell tool to run exactly: echo ${token}_ONE . After it finishes reply with only FIRST_OK.`, 'om_turn_1');
    await w.waitFor(() => w.settled('om_turn_1'), 'turn 1 settled');
    const t1 = w.activity('om_turn_1');
    expect(t1.some(e => e.kind === 'thinking')).toBe(true);
    expect(hasToolMentioning(t1, `${token}_ONE`)).toBe(true);
    const t1Tools = toolIds(t1);
    expect(t1.some(e => e.kind === 'tool_result' && t1Tools.includes(e.id))).toBe(true);
    // The closing answer belongs to the reply path, not the activity panel.
    expect(t1.some(e => e.kind === 'text' && e.text.includes('FIRST_OK'))).toBe(false);

    // Turn 2 in the same session: its activity is its own.
    w.send(`Use your shell tool to run exactly: echo ${token}_TWO . After it finishes reply with only SECOND_OK.`, 'om_turn_2');
    await w.waitFor(() => w.settled('om_turn_2'), 'turn 2 settled');
    const t2 = w.activity('om_turn_2');
    expect(hasToolMentioning(t2, `${token}_TWO`)).toBe(true);
    expect(hasToolMentioning(t2, `${token}_ONE`)).toBe(false);
    expect(hasToolMentioning(w.activity('om_turn_1'), `${token}_TWO`)).toBe(false);

    // Native usage of this botmux session (the daemon's card/footer path).
    const { getSessionUsageSnapshot } = await import('../src/core/cost-calculator.js');
    const usage = getSessionUsageSnapshot({ cliId: 'kimi', sessionId, cwd, fresh: true });
    expect(usage.tokens?.in ?? 0).toBeGreaterThan(0);
    expect(usage.tokens?.out ?? 0).toBeGreaterThan(0);
    expect(usage.turnTokens?.out ?? 0).toBeGreaterThan(0);
    expect(usage.context?.usedTokens ?? 0).toBeGreaterThan(0);
    expect(usage.context?.windowTokens ?? 0).toBeGreaterThan(0);
    expect(usage.model).toMatch(/\//);
    if (process.env.BOTMUX_KIMI_E2E_EVIDENCE) {
      writeFileSync(process.env.BOTMUX_KIMI_E2E_EVIDENCE, JSON.stringify({ sessionId, cwd, turn1: t1, turn2: t2, usage }, null, 2));
    }

    // Respawn with resume: Kimi resumes the same session; only new activity
    // reaches the new turn.
    w.child.send({ type: 'close' } satisfies DaemonToWorker);
    await pause(3000);
    const r = startWorker({ root, cwd, sessionId, resume: true });
    await r.waitFor(() => r.messages.some(m => m.type === 'ready'), 'resumed worker ready', 60_000);
    r.send(`Use your shell tool to run exactly: echo ${token}_THREE . After it finishes reply with only THIRD_OK.`, 'om_turn_3');
    await r.waitFor(() => r.settled('om_turn_3'), 'turn 3 settled');
    const t3 = r.activity('om_turn_3');
    expect(hasToolMentioning(t3, `${token}_THREE`)).toBe(true);
    expect(hasToolMentioning(t3, `${token}_ONE`) || hasToolMentioning(t3, `${token}_TWO`)).toBe(false);
    expect(r.log()).toMatch(/Kimi activity observer bound to .*from end/);

    // `/new` (passed through from Feishu as raw input) starts a new Kimi
    // session inside the same process: the observer moves to it.
    const readyBefore = r.messages.filter(m => m.type === 'prompt_ready').length;
    r.child.send({ type: 'raw_input', content: '/new' } satisfies DaemonToWorker);
    await r.waitFor(() => r.messages.filter(m => m.type === 'prompt_ready').length > readyBefore, '/new settled', 60_000);
    await pause(1500);
    r.send(`Use your shell tool to run exactly: echo ${token}_FOUR . After it finishes reply with only FOURTH_OK.`, 'om_turn_4');
    await r.waitFor(() => r.settled('om_turn_4'), 'turn 4 settled');
    const t4 = r.activity('om_turn_4');
    expect(hasToolMentioning(t4, `${token}_FOUR`)).toBe(true);
    expect(hasToolMentioning(t4, `${token}_THREE`)).toBe(false);
    const binds = [...r.log().matchAll(/Kimi activity observer bound to (\S+)/g)].map(m => m[1]);
    expect(binds).toHaveLength(2);
    expect(binds[1]).not.toBe(binds[0]);
  }, 900_000);
});
