/**
 * flow `bot` 执行器的 runner 级 e2e：真实 FlowRunner（进程内）+ 真实 script host 子进程 +
 * 一个进程内的假「bot daemon」（实现 agent-turn / trigger-result / close 三条路）。
 *
 * 覆盖：cli → bot 解析与 started 行、attempt.state ready 带 sessionId、send.intent / send.confirmed、
 * result 证据来源 daemon、结算后关会话、schema 修复回到同一会话、超时关会话、daemon 侧失败进决策、
 * 选不到 bot 的 setup_required、取消关会话、接管时关掉上一代会话、run.json 记录 executor。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FlowRunner, readRunJson } from '../src/flow/runner.js';
import type { BotExecutorDeps, BotHttpResponse } from '../src/flow/bot-executor.js';
import type { AttemptStateRow, FlowAgentTurnRequest, JournalRow, ResultRow, RunBinding, StartedRow } from '../src/flow/types.js';
import type { OnlineDaemonInfo } from '../src/utils/daemon-discovery.js';
import { SRC_DIR, control, harness, rows, type Harness } from './helpers/flow-e2e.js';

const DAEMONS: OnlineDaemonInfo[] = [
  { larkAppId: 'cli_own', ipcPort: 4001, botName: 'Owner Bot', cliId: 'claude-code' },
  { larkAppId: 'cli_codex', ipcPort: 4002, botName: 'Codex Bot', cliId: 'codex' },
];

interface FakeTurn {
  triggerId: string;
  prompt: string;
  attempt: number;
  turn: number;
  state: 'running' | 'completed' | 'failed';
  content?: string;
  error?: string;
}

interface FakeSession {
  sessionId: string;
  bot: string;
  closed: boolean;
  turns: FakeTurn[];
}

type Behaviour = (req: FlowAgentTurnRequest, session: FakeSession) => { content?: string; fail?: string; hang?: boolean; delayMs?: number };

/** 进程内假 daemon：按端口区分 bot；会话与回合状态都在内存里。 */
class FakeDaemon {
  readonly sessions = new Map<string, FakeSession>();
  readonly dispatches: FlowAgentTurnRequest[] = [];
  readonly closes: Array<{ sessionId: string; reason: string }> = [];
  private seq = 0;
  readonly deps: BotExecutorDeps;

  constructor(private readonly behave: Behaviour, private readonly online: OnlineDaemonInfo[] = DAEMONS) {
    this.deps = { listDaemons: () => this.online, pollIntervalMs: 10, fetch: (port, path, init) => this.handle(port, path, init) };
  }

  private async handle(port: number, path: string, init?: { method?: string; body?: string }): Promise<BotHttpResponse> {
    const json = (status: number, body: unknown): BotHttpResponse => ({ status, json: async () => body });
    const daemon = this.online.find((d) => d.ipcPort === port);
    if (!daemon) throw new Error(`ECONNREFUSED 127.0.0.1:${port}`);
    if (path === '/api/flow/agent-turn' && init?.method === 'POST') {
      const req = JSON.parse(init.body!) as FlowAgentTurnRequest;
      this.dispatches.push(req);
      let session = req.sessionId ? this.sessions.get(req.sessionId) : undefined;
      if (req.sessionId && (!session || session.closed)) return json(404, { ok: false, code: 'session_not_found', error: `active session not found: ${req.sessionId}` });
      if (!session) {
        session = { sessionId: `sess_${++this.seq}`, bot: daemon.larkAppId, closed: false, turns: [] };
        this.sessions.set(session.sessionId, session);
      }
      const turn: FakeTurn = { triggerId: `trg_${++this.seq}`, prompt: req.prompt, attempt: req.attempt, turn: req.turn, state: 'running' };
      session.turns.push(turn);
      const plan = this.behave(req, session);
      if (!plan.hang) {
        setTimeout(() => {
          if (turn.state !== 'running') return;
          if (plan.fail !== undefined) {
            turn.state = 'failed';
            turn.error = plan.fail;
          } else {
            turn.state = 'completed';
            turn.content = plan.content ?? '';
          }
        }, plan.delayMs ?? 5);
      }
      return json(200, { ok: true, sessionId: session.sessionId, triggerId: turn.triggerId, bot: daemon.larkAppId, botName: daemon.botName, cliId: daemon.cliId });
    }
    const result = /^\/api\/sessions\/([^/]+)\/trigger-result\?triggerId=(.+)$/.exec(path);
    if (result) {
      const session = this.sessions.get(decodeURIComponent(result[1]!));
      const turn = session?.turns.find((t) => t.triggerId === decodeURIComponent(result[2]!));
      if (!session || !turn) return json(200, { ok: true, state: 'not_found' });
      if (turn.state === 'completed') return json(200, { ok: true, state: 'completed', output: { content: turn.content } });
      if (turn.state === 'failed' || session.closed) return json(200, { ok: true, state: 'failed', error: turn.error ?? 'session closed', errorCode: 'no_output' });
      return json(200, { ok: true, state: 'running' });
    }
    const close = /^\/api\/sessions\/([^/]+)\/close$/.exec(path);
    if (close && init?.method === 'POST') {
      const sessionId = decodeURIComponent(close[1]!);
      this.closes.push({ sessionId, reason: (JSON.parse(init.body ?? '{}') as { reason?: string }).reason ?? '' });
      const session = this.sessions.get(sessionId);
      if (!session) return json(200, { ok: true, alreadyClosed: true });
      session.closed = true;
      return json(200, { ok: true });
    }
    return json(404, { ok: false, error: 'no route' });
  }
}

const binding: RunBinding = { larkAppId: 'cli_own', chatId: 'oc_x', rootId: 'om_root', sessionId: null, ownerOpenId: null, triggeredBy: 'ou_tester', workingDir: '/tmp' };

function runner(h: Harness, fake: FakeDaemon, extra: Partial<ConstructorParameters<typeof FlowRunner>[0]> = {}): FlowRunner {
  return new FlowRunner({
    runId: h.runId,
    runDir: h.runDir,
    mode: 'run',
    script: { path: h.scriptPath, source: readFileSync(h.scriptPath, 'utf8') },
    input: { topic: 'tea' },
    cwd: h.dataDir,
    slotsFile: h.slotsFile,
    distDir: SRC_DIR,
    decidedBy: 'e2e',
    binding,
    daemonLink: null,
    botExecutor: fake.deps,
    heartbeatIntervalMs: 500,
    limits: { agentTimeoutMs: 10_000, scriptSliceMs: 20_000 },
    hooks: { log: () => {} },
    ...extra,
  });
}

function started(h: Harness): StartedRow[] {
  return rows(h).filter((r): r is StartedRow => r.t === 'started');
}

function states(h: Harness, identity: string): AttemptStateRow[] {
  return rows(h).filter((r): r is AttemptStateRow => r.t === 'attempt.state' && r.identity === identity);
}

describe('flow runner · bot executor', () => {
  beforeAll(() => {
    process.env.BOTMUX_FLOW_TS_SRC_DIR = SRC_DIR;
    delete process.env.BOTMUX_FLOW_FAKE_AGENT;
  });
  afterEach(() => {
    delete process.env.BOTMUX_FLOW_FAKE_AGENT;
  });

  it('cli → bot 解析、headless 会话、journal 行与证据、结算后关会话', async () => {
    const h = harness(`export default async (ctx) => {
      const a = await ctx.agent({ cli: 'claude-code', prompt: 'say A' });
      const b = await ctx.agent({ cli: 'codex', prompt: 'say B' });
      const c = await ctx.agent({ prompt: 'say C' });
      return [a.value, b.value, c.value];
    }`);
    const fake = new FakeDaemon((req) => ({ content: `${req.prompt.slice(-1)}!` }));
    const summary = await runner(h, fake).run();
    expect(summary.status).toBe('completed');
    expect(summary.returned).toEqual(['A!', 'B!', 'C!']);
    expect(summary.containment).toBeNull();

    // started 行：解析出的 bot 与 CLI
    expect(started(h).map((r) => [r.identity, r.cli, r.bot, r.botName])).toEqual([
      ['#0', 'claude-code', 'cli_own', 'Owner Bot'],
      ['#1', 'codex', 'cli_codex', 'Codex Bot'],
      ['#2', 'claude-code', 'cli_own', 'Owner Bot'],
    ]);
    // 三个 attempt 都派到了对应端口，工作目录是 run 的 cwd
    expect(fake.dispatches.map((d) => [d.identity, d.turn, d.sessionId])).toEqual([['#0', 1, null], ['#1', 1, null], ['#2', 1, null]]);
    expect(fake.dispatches.every((d) => d.workingDir === h.dataDir || d.workingDir === readRunJson(h.runDir)!.cwd)).toBe(true);
    expect([...fake.sessions.values()].map((s) => s.bot)).toEqual(['cli_own', 'cli_codex', 'cli_own']);
    // attempt.state：queued → spawning（带 bot）→ ready（带 sessionId）
    expect(states(h, '#1').map((r) => [r.state, r.bot, r.sessionId])).toEqual([['queued', undefined, undefined], ['spawning', 'cli_codex', undefined], ['ready', 'cli_codex', 'sess_3']]);
    const seq = rows(h).filter((r) => 'identity' in r && (r as { identity: string }).identity === '#1').map((r) => r.t);
    expect(seq).toEqual(['started', 'attempt.state', 'attempt.state', 'send.intent', 'attempt.state', 'send.confirmed', 'result']);
    const result = rows(h).find((r): r is ResultRow => r.t === 'result' && r.identity === '#1')!;
    expect(result.evidence).toMatchObject({ source: 'daemon', confidence: 'high', bot: 'cli_codex', botName: 'Codex Bot', sessionId: 'sess_3', triggerId: 'trg_4' });
    // 每个会话结算后都关了
    expect(fake.closes.map((c) => c.sessionId)).toEqual(['sess_1', 'sess_3', 'sess_5']);
    expect([...fake.sessions.values()].every((s) => s.closed)).toBe(true);
    // run.json / run.started 记录执行器与档位
    const rj = readRunJson(h.runDir)!;
    expect(rj.execConfig.executor).toBe('bot');
    expect(rj.containment).toBe('delegated');
    const startedRow = rows(h).find((r) => r.t === 'run.started') as Extract<JournalRow, { t: 'run.started' }>;
    expect(startedRow.containment).toBe('delegated');
    expect(rows(h).some((r) => r.t === 'container.created' && r.kind === 'none')).toBe(true);
  }, 60_000);

  it('schema 修复回到同一个会话（turn 2），值是解析后的 JSON；快照带 botName', async () => {
    const h = harness(`export default async (ctx) => {
      const r = await ctx.agent({ cli: 'codex', prompt: 'give json', schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } });
      return r.value;
    }`);
    const fake = new FakeDaemon((req) => (req.turn === 1 ? { content: 'not json at all' } : { content: 'ok:\n```json\n{"n": 7}\n```' }));
    const r = runner(h, fake);
    const summary = await r.run();
    expect(summary.status).toBe('completed');
    expect(summary.returned).toEqual({ n: 7 });
    expect(fake.dispatches.map((d) => [d.turn, d.sessionId])).toEqual([[1, null], [2, 'sess_1']]);
    expect(fake.dispatches[1]!.prompt).toMatch(/did not satisfy the required JSON schema/);
    expect(rows(h).filter((x) => x.t === 'send.intent').map((x) => (x as Extract<JournalRow, { t: 'send.intent' }>).turn)).toEqual([1, 2]);
    expect(fake.closes).toHaveLength(1);
    expect(r.snapshot().attempts).toEqual([expect.objectContaining({ identity: '#0', cli: 'codex', botName: 'Codex Bot', state: 'result' })]);
  }, 60_000);

  it('超时 → timeout（uncertain）并关掉会话；选不到 bot → setup_required', async () => {
    const h = harness(`export default async (ctx) => {
      const slow = await ctx.agent({ cli: 'codex', prompt: 'hang', timeoutMs: 400 });
      const none = await ctx.agent({ cli: 'gemini', prompt: 'nobody' });
      return [slow.ok, slow.error, none.ok, none.error];
    }`);
    const fake = new FakeDaemon(() => ({ hang: true }));
    const r = runner(h, fake);
    const summary = await r.run();
    expect(summary.status).toBe('failed');
    const failed = rows(h).filter((x): x is Extract<JournalRow, { t: 'failed' }> => x.t === 'failed');
    expect(failed.map((f) => [f.identity, f.category, f.retry, f.effects])).toEqual([
      ['#0', 'timeout', 'auto', 'uncertain'],
      ['#1', 'setup_required', 'manual', 'none'],
    ]);
    expect(failed[0]!.error).toMatch(/Codex Bot did not finish the turn within 400ms/);
    expect(failed[1]!.error).toMatch(/no online bot runs cli "gemini"/);
    // 超时关了会话；gemini 根本没派发
    expect(fake.closes.map((c) => c.sessionId)).toEqual(['sess_1']);
    expect(fake.dispatches).toHaveLength(1);
    expect(summary.returned).toEqual([false, expect.stringMatching(/did not finish/), false, expect.stringMatching(/gemini/)]);
  }, 60_000);

  it('daemon 侧会话失败 → crashed/uncertain 返回脚本；resume 时进决策，retry 后第二次 attempt 成功', async () => {
    const h = harness(`export default async (ctx) => {
      const r = await ctx.agent({ cli: 'claude-code', prompt: 'flaky' });
      return r.ok ? r.value : ['failed', r.category, r.error];
    }`);
    const fake = new FakeDaemon((req) => (req.attempt === 1 ? { fail: 'worker exited' } : { content: 'second time lucky' }));
    const s1 = await runner(h, fake).run();
    // 失败作为 Outcome 回到脚本（不阻塞）；run 因全部失败而 failed
    expect(s1.status).toBe('failed');
    expect(s1.returned).toEqual(['failed', 'crashed', 'Owner Bot: worker exited']);
    expect(rows(h).filter((x): x is Extract<JournalRow, { t: 'failed' }> => x.t === 'failed')[0]).toMatchObject({ category: 'crashed', retry: 'auto', effects: 'uncertain', evidence: { bot: 'cli_own', sessionId: 'sess_1', errorCode: 'no_output' } });
    expect(fake.closes.map((c) => c.sessionId)).toEqual(['sess_1']);

    // resume：同一 content 的 uncertain 失败 → 暂停等决策 → retry → attempt 2
    const second = new FlowRunner({
      runId: h.runId, runDir: h.runDir, mode: 'resume', slotsFile: h.slotsFile, distDir: SRC_DIR, decidedBy: 'e2e',
      daemonLink: null, botExecutor: fake.deps, heartbeatIntervalMs: 500,
      hooks: {
        log: () => {},
        at: async (point, detail) => {
          if (point !== 'paused' || detail.identity !== '#0') return;
          const status = await control(h, { t: 'status' });
          const pending = (status as Extract<typeof status, { ok: true }>).pending[0]!;
          expect(pending.outcome).toMatchObject({ category: 'crashed', retry: 'auto', effects: 'uncertain', error: expect.stringMatching(/Owner Bot: worker exited/) });
          await control(h, { t: 'decide', identity: '#0', content: pending.content, attempt: 1, choice: 'retry', by: 'e2e' });
        },
      },
    });
    const s2 = await second.run();
    expect(s2.status, JSON.stringify(rows(h).filter((x) => x.t === 'run.error'))).toBe('completed');
    expect(s2.returned).toBe('second time lucky');
    expect(fake.dispatches.map((d) => [d.gen, d.attempt, d.sessionId])).toEqual([[1, 1, null], [2, 2, null]]);
    expect(fake.closes.map((c) => c.sessionId)).toEqual(['sess_1', 'sess_3']);
  }, 60_000);

  it('取消 run：在途会话被关掉，attempt 结算成 canceled', async () => {
    const h = harness(`export default async (ctx) => {
      const r = await ctx.agent({ cli: 'codex', prompt: 'forever' });
      return r.ok;
    }`);
    const fake = new FakeDaemon(() => ({ hang: true }));
    const r = runner(h, fake, {
      hooks: {
        log: () => {},
        at: async (point) => {
          if (point === 'after_authorize') setTimeout(() => void r.cancelRun('operator'), 50);
        },
      },
    });
    const summary = await r.run();
    expect(summary.status).toBe('canceled');
    const failed = rows(h).find((x): x is Extract<JournalRow, { t: 'failed' }> => x.t === 'failed')!;
    expect(failed).toMatchObject({ category: 'canceled', effects: 'uncertain' });
    expect(fake.closes.map((c) => c.sessionId)).toEqual(['sess_1']);
    expect(fake.sessions.get('sess_1')!.closed).toBe(true);
  }, 60_000);

  it('接管：上一代在途 attempt 的会话按 journal 记录关掉，然后诚实结算并重跑', async () => {
    const h = harness(`export default async (ctx) => {
      const r = await ctx.agent({ cli: 'codex', prompt: 'takeover' });
      return r.value;
    }`);
    // 第一代：派发后 runner 被「打断」（interrupt），会话留在 daemon 里
    const fake = new FakeDaemon((req) => (req.gen === 1 ? { hang: true } : { content: 'done in gen 2' }));
    const first = runner(h, fake, {
      hooks: {
        log: () => {},
        at: async (point) => {
          if (point === 'after_authorize') setTimeout(() => void first.interrupt('SIGTERM'), 30);
        },
      },
    });
    const s1 = await first.run();
    expect(s1.status).toBe('interrupted');
    // interrupt 自己关了在途会话（closeInflightBotSession）
    expect(fake.closes.map((c) => c.sessionId)).toEqual(['sess_1']);
    // 把它「复活」成 daemon 里仍开着的样子，验证接管路径按 journal 的 sessionId 再关一次
    fake.sessions.get('sess_1')!.closed = false;
    fake.closes.length = 0;
    // 被打断的 attempt 已有 send.intent → 诚实结算 interrupted/uncertain → 重放时等决策 → retry
    const second = new FlowRunner({
      runId: h.runId, runDir: h.runDir, mode: 'resume', slotsFile: h.slotsFile, distDir: SRC_DIR, decidedBy: 'e2e',
      daemonLink: null, botExecutor: fake.deps, heartbeatIntervalMs: 500,
      hooks: {
        log: () => {},
        at: async (point, detail) => {
          if (point !== 'paused' || detail.identity !== '#0') return;
          const status = await control(h, { t: 'status' });
          const pending = (status as Extract<typeof status, { ok: true }>).pending[0]!;
          expect(pending.outcome).toMatchObject({ category: 'interrupted', effects: 'uncertain' });
          await control(h, { t: 'decide', identity: '#0', content: pending.content, attempt: 1, choice: 'retry', by: 'e2e' });
        },
      },
    });
    const s2 = await second.run();
    expect(s2.status).toBe('completed');
    expect(s2.returned).toBe('done in gen 2');
    expect(fake.closes[0]).toMatchObject({ sessionId: 'sess_1', reason: expect.stringMatching(/takeover/) });
    expect(readRunJson(h.runDir)!.execConfig.executor).toBe('bot');
    const failed = rows(h).filter((x): x is Extract<JournalRow, { t: 'failed' }> => x.t === 'failed');
    expect(failed.map((f) => [f.gen, f.attempt, f.category])).toEqual([[2, 1, 'interrupted']]);
    expect(fake.dispatches.map((d) => [d.gen, d.attempt])).toEqual([[1, 1], [2, 2]]);
  }, 90_000);
});
