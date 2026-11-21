/**
 * Antigravity CLI (`agy`) ask_question → Lark question card, through the real
 * `runHook` (the `botmux hook antigravity` body) with an injected daemon.
 *
 * The payload is a real PreToolUse stdin captured from agy 1.5.12 (paths
 * scrubbed). What agy does with the hook's stdout was measured on the same
 * build: `{"decision":"deny","reason":R}` → the model's ask_question result is
 * "…tool call denied by pre-tool hook: R" and the picker never opens; an empty
 * stdout → no decision, agy opens its own picker; `{}` → an empty decision,
 * which agy treats as a deny with an EMPTY reason.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tsRunnerPrefix } from './helpers/ts-runner.js';
import { runHook } from '../src/cli.js';
import type { AskResult } from '../src/core/ask-types.js';
import { getHookAdapter } from '../src/core/ask-hook/registry.js';

const PAYLOAD = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/antigravity/pretooluse-ask-question-1.5.12.json'), 'utf-8'));

const ENV: Record<string, string | undefined> = {
  BOTMUX_SESSION_ID: 'sess_agy',
  BOTMUX_CHAT_ID: 'oc_chat',
  BOTMUX_LARK_APP_ID: 'cli_app',
  BOTMUX_ROOT_MESSAGE_ID: 'om_root',
};

const answered = (answers: string[][], extra: Partial<Extract<AskResult, { kind: 'answered' }>> = {}): AskResult => ({
  kind: 'answered', answers, by: 'ou_user', comment: null, timedOut: false, ...extra,
});

/** The directive agy reads from the hook's stdout. */
function directive(stdout: string): { decision: string; reason: string } {
  const parsed = JSON.parse(stdout);
  expect(Object.keys(parsed).sort()).toEqual(['decision', 'reason']);
  return parsed;
}

async function hook(result: AskResult | (() => Promise<AskResult>), opts: {
  env?: Record<string, string | undefined>;
  payload?: unknown;
  origin?: () => { turnId?: string; dispatchAttempt?: number } | null;
} = {}) {
  const bodies: Record<string, unknown>[] = [];
  const post = vi.fn(async (body: Record<string, unknown>) => {
    bodies.push(body);
    return typeof result === 'function' ? result() : result;
  });
  const { stdout } = await runHook(
    opts.payload ?? PAYLOAD,
    opts.env ?? ENV,
    post,
    'antigravity',
    async () => null,
    undefined,
    opts.origin ?? (() => ({ turnId: 'om_turn', dispatchAttempt: 2 })),
  );
  return { stdout, bodies, post };
}

describe('agy ask_question becomes a Lark question card', () => {
  it('posts every question with its options and multi-select flag, frozen to the issuing turn', async () => {
    const { bodies } = await hook(answered([['2'], ['1', '3']]));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      sessionId: 'sess_agy', chatId: 'oc_chat', larkAppId: 'cli_app', rootMessageId: 'om_root',
      originKind: 'hook', originTurnId: 'om_turn', originDispatchAttempt: 2,
    });
    expect(bodies[0]!.questions).toEqual([
      {
        prompt: 'Which database should we use?',
        multiSelect: false,
        options: [
          { key: '1', label: '(Recommended) PostgreSQL' },
          { key: '2', label: 'SQLite' },
          { key: '3', label: 'MySQL' },
        ],
      },
      {
        prompt: 'Which features to enable?',
        multiSelect: true,
        options: [{ key: '1', label: 'Auth' }, { key: '2', label: 'Billing' }, { key: '3', label: 'Search' }],
      },
    ]);
  });

  it('repeated option strings still get distinct keys (a repeated key would make the daemon reject the card)', () => {
    const payload = structuredClone(PAYLOAD);
    payload.toolCall.args.questions[0].options = ['Same', 'Same'];
    const parsed = getHookAdapter('antigravity')!.parseQuestions(payload)!;
    expect(parsed.questions[0]!.options.map(o => o.key)).toEqual(['1', '2']);
  });

  it('agy builds before 1.5.4 sent no hookEventName: still a PreToolUse question', () => {
    const { hookEventName: _drop, ...older } = PAYLOAD;
    expect(getHookAdapter('antigravity')!.parseQuestions(older)?.questions).toHaveLength(2);
  });

  it.each([
    ['another tool', (p: any) => { p.toolCall.name = 'run_command'; }],
    ['another event', (p: any) => { p.hookEventName = 'PostToolUse'; }],
    ['no questions', (p: any) => { p.toolCall.args.questions = []; }],
    ['one option', (p: any) => { p.toolCall.args.questions[0].options = ['only']; }],
    ['a non-string option', (p: any) => { p.toolCall.args.questions[1].options = ['a', { label: 'b' }]; }],
    ['a blank question', (p: any) => { p.toolCall.args.questions[0].question = ' '; }],
  ])('%s: no card, the tool runs as if there were no hook (empty stdout)', async (_label, change) => {
    const payload = structuredClone(PAYLOAD);
    change(payload);
    const { stdout, post } = await hook(answered([['1']]), { payload });
    expect(post).not.toHaveBeenCalled();
    expect(stdout).toBe('');
  });
});

describe('the answer goes back as the deny reason, in agy\'s own A1/A2 lines', () => {
  it('picked options → their labels; multi-select joined like agy\'s picker', async () => {
    const d = directive((await hook(answered([['2'], ['1', '3']]))).stdout);
    expect(d.decision).toBe('deny');
    const lines = d.reason.split('\n');
    expect(lines.slice(-2)).toEqual(['A1: SQLite', 'A2: Auth, Search']);
    // The model must read it as the answer, not as a failed tool call.
    expect(lines[0]).toMatch(/answered/);
    expect(lines[0]).toMatch(/not a failure/);
  });

  it('a per-question typed answer replaces that question\'s picks', async () => {
    const d = directive((await hook(answered([['1'], ['2']], { customAnswers: [null, 'just audit logs'] }))).stdout);
    expect(d.reason.split('\n').slice(-2)).toEqual(['A1: (Recommended) PostgreSQL', 'A2: just audit logs']);
  });

  it('a text reply in the thread answers the questions nothing was picked for', async () => {
    const d = directive((await hook(answered([[], []], { comment: 'MySQL, and only Auth' }))).stdout);
    expect(d.reason.split('\n').slice(-2)).toEqual(['A1: MySQL, and only Auth', 'A2: MySQL, and only Auth']);
  });

  it('a question left unanswered reads like agy\'s own skip', async () => {
    const d = directive((await hook(answered([['3'], []]))).stdout);
    expect(d.reason.split('\n').slice(-2)).toEqual(['A1: MySQL', 'A2: User Skipped']);
  });
});

describe('a routed question nobody answers ends with the reason, never on agy\'s picker', () => {
  // The session is routed to Lark: agy's picker would wait on a terminal
  // nobody watches (and nothing would ever press its keys).
  it('timed out → deny naming the wait; the model is told not to assume an answer', async () => {
    const env = { ...ENV, BOTMUX_ASK_TIMEOUT_MS: String(30 * 60_000) };
    const d = directive((await hook({ kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true }, { env })).stdout);
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('30 min');
    expect(d.reason).toMatch(/Do not assume an answer/);
  });

  it('card withdrawn → deny with the reason', async () => {
    const d = directive((await hook({
      kind: 'invalidated', reason: 'session closed', selected: null, by: null, comment: null, timedOut: false,
    })).stdout);
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('session closed');
  });

  it('card never delivered → deny telling the model to ask in plain text', async () => {
    const d = directive((await hook({
      kind: 'invalidated', reason: 'lark send failed', failureCode: 'card_delivery_failed',
      selected: null, by: null, comment: null, timedOut: false,
    })).stdout);
    expect(d.reason).toMatch(/could not deliver/);
    expect(d.reason).toMatch(/plain text/);
  });

  it('daemon rejects the ask outright → same "could not deliver" deny, no retry loop', async () => {
    const { stdout, post } = await hook(async () => { throw Object.assign(new Error('400'), { retryable: false }); });
    expect(post).toHaveBeenCalledTimes(1);
    expect(directive(stdout).reason).toMatch(/could not deliver/);
  });

  it('other CLIs keep their passthrough on the same outcomes (Claude: native picker)', async () => {
    const claudePayload = {
      hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'q?', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] }] },
    };
    const { stdout } = await runHook(claudePayload, ENV,
      async () => ({ kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true }), 'claude-code', async () => null);
    expect(stdout).toBe('');
  });
});

describe('outside a botmux session agy keeps its own picker', () => {
  it('standalone agy (no session env, no adopted pane): no card, empty stdout — never `{}`', async () => {
    const { stdout, post } = await hook(answered([['1']]), { env: {} });
    expect(post).not.toHaveBeenCalled();
    expect(stdout).toBe('');
  });

  it('a workflow node session passes through like every other CLI', async () => {
    const { stdout, post } = await hook(answered([['1']]), { env: { ...ENV, BOTMUX_WORKFLOW: '1' } });
    expect(post).not.toHaveBeenCalled();
    expect(stdout).toBe('');
  });
});

describe('the hook client does not outlive agy', () => {
  // agy gives up on a waiting handler (Esc, a stopped turn, its timeout) by
  // SIGKILLing only the process it started. A client left behind keeps its
  // ask open: the daemon keeps the card answerable and reads the next text in
  // the thread as the answer to a question nobody waits for (seen live on
  // 1.5.12 with a shell in between). The installed command `exec`s the client
  // (antigravity-hook-install.test.ts); here, a parent in between is killed.
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = async (check: () => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('condition not reached');
      await new Promise(r => setTimeout(r, 50));
    }
  };
  const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

  it('its parent killed while it waits on the card: the client exits and its connection to the daemon closes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-agy-parent-'));
    const dataDir = join(dir, 'data');
    mkdirSync(join(dataDir, 'dashboard-daemons'), { recursive: true });
    let asked = false;
    let closed = false;
    // A daemon that takes the ask and keeps the long-poll open (nobody answers yet).
    const daemon = createServer((req, res) => {
      if (!req.url?.startsWith('/api/asks')) { res.statusCode = 404; res.end(); return; }
      asked = true;
      res.on('close', () => { closed = true; });
    });
    await new Promise<void>(r => daemon.listen(0, '127.0.0.1', r));
    const port = (daemon.address() as AddressInfo).port;
    writeFileSync(join(dataDir, 'dashboard-daemons', 'fake.json'),
      JSON.stringify({ larkAppId: 'cli_app', ipcPort: port, lastHeartbeat: Date.now() }));
    const payloadFile = join(dir, 'payload.json');
    writeFileSync(payloadFile, JSON.stringify(PAYLOAD));
    const pidFile = join(dir, 'client.pid');
    const { command, prefixArgs } = tsRunnerPrefix();
    const client = [command, ...prefixArgs, resolve('src/cli.ts'), 'hook', 'antigravity'].map(shq).join(' ');
    const parent = spawn('sh', ['-c', `${client} < ${shq(payloadFile)} > /dev/null 2>&1 & echo $! > ${shq(pidFile)}; wait`], {
      env: { ...process.env, ...ENV, SESSION_DATA_DIR: dataDir }, stdio: 'ignore',
    });
    let clientPid = 0;
    try {
      await until(() => asked, 90_000);
      clientPid = Number(readFileSync(pidFile, 'utf-8').trim());
      expect(alive(clientPid)).toBe(true);
      parent.kill('SIGKILL');
      await until(() => closed, 15_000);
      await until(() => !alive(clientPid), 15_000);
    } finally {
      if (clientPid && alive(clientPid)) process.kill(clientPid, 'SIGKILL');
      if (parent.exitCode === null) parent.kill('SIGKILL');
      daemon.closeAllConnections?.();
      await new Promise(r => daemon.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);
});
