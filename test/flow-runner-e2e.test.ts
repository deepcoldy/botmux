/**
 * flow runner 进程级验收（设计文档 §11 M1 验收 1/2/3/4/11/12/13/16 的可自动化部分）。
 *
 * 真实拓扑：runner 进程 → script host 进程 → agent worker 进程（假 agent，不起 CLI）；
 * 容器走真实 cgroup（本宿主 v1 freezer）。故障注入用 `BOTMUX_FLOW_CRASH_AT`（SIGKILL 自己）
 * 与 `BOTMUX_FLOW_PAUSE_AT`（SIGSTOP 自己）在 runner 的钩子点上精确放置。
 *
 * 容器后端不可用的宿主上整组跳过——跳过不等于验证过。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRunContainers, containerPath, subtreeProcs, runTreePath } from '../src/flow/container.js';
import { loadJournal, journalPath } from '../src/flow/journal.js';
import { leaseExists, readLeaseUnlocked } from '../src/flow/ownership.js';
import { readRunJson } from '../src/flow/runner.js';
import { inspectRun } from '../src/cli/flow.js';
import { checkReplay } from '../src/flow/check-replay.js';
import { type ControlResponse, type JournalRow } from '../src/flow/types.js';
import { SRC_DIR, backend, control, harness, pidAlive, rows, startRunner, summaryOf, waitFor, waitForStderr, type RunnerProc } from './helpers/flow-e2e.js';

const describeIf = backend ? describe : describe.skip;

const SLOGAN = `
export default async function (ctx) {
  const { input, parallel, agent, log } = ctx;
  await log('start ' + input.topic);
  const drafts = await parallel(['warm', 'bold'].map((tone) => (c) =>
    c.agent({ cli: 'claude-code', prompt: tone + ' slogan for ' + input.topic })));
  const ok = drafts.filter((d) => d.ok);
  const review = await agent({ cli: 'codex', prompt: 'review ' + ok.map((d) => d.value).join('|') });
  return { drafts: drafts.map((d) => d.ok ? d.value : d.category), review: review.ok ? review.value : review.category };
}
`;

describeIf('flow runner 进程级（真实三进程拓扑 + 真实 cgroup）', () => {
  beforeAll(() => {
    expect(existsSync(join(SRC_DIR, 'flow-runner.ts'))).toBe(true);
    // 进程内调用 checkReplay 也要从源码起 script host
    process.env.BOTMUX_FLOW_TS_SRC_DIR = SRC_DIR;
  });

  it('全新 run：三 agent 完成；journal 行序完整；容器回收；lease 释放；resume 零 spawn 全缓存且返回值相等', async () => {
    const h = harness(SLOGAN);
    const first = startRunner(h, 'run');
    const exit1 = await first.exit;
    expect(exit1.code, first.stderr()).toBe(0);
    const s1 = summaryOf(first);
    expect(s1.status).toBe('completed');
    expect(s1.gen).toBe(1);
    expect(s1.returned).toEqual({ drafts: ['echo:warm slogan for tea', 'echo:bold slogan for tea'], review: 'echo:review echo:warm slogan for tea|echo:bold slogan for tea' });
    expect(s1.replay).toBe('none');

    const types = rows(h).map((r) => r.t);
    expect(types[0]).toBe('run.started');
    expect(types.filter((t) => t === 'started')).toHaveLength(3);
    expect(types.filter((t) => t === 'container.created')).toHaveLength(3);
    expect(types.filter((t) => t === 'send.intent')).toHaveLength(3);
    expect(types.filter((t) => t === 'send.confirmed')).toHaveLength(3);
    expect(types.filter((t) => t === 'result')).toHaveLength(3);
    expect(types[types.length - 1]).toBe('run.finished');
    // 每个 attempt 的顺序：started → queued → container.created → spawning → ready → send.intent → … → result
    // log 不占位：parallel 是 #0，分支 #0/par:i#0，review 是 #1
    const forWarm = rows(h).filter((r) => 'identity' in r && r.identity === '#0/par:0#0').map((r) => (r.t === 'attempt.state' ? `state:${r.state}` : r.t));
    expect(forWarm).toEqual(['started', 'state:queued', 'state:spawning', 'state:ready', 'send.intent', 'send.confirmed', 'result']);
    const intents = rows(h).filter((r): r is Extract<JournalRow, { t: 'send.intent' }> => r.t === 'send.intent');
    expect(new Set(intents.map((r) => r.outboxFile)).size).toBe(3);
    expect(intents[0]!.outboxFile).toMatch(/^response-1-1-[0-9a-f]{12}\.md$/);
    // 契约文件落在 attempt 目录
    const spawning = rows(h).find((r): r is Extract<JournalRow, { t: 'attempt.state' }> => r.t === 'attempt.state' && r.state === 'spawning')!;
    expect(spawning.pid).toBeGreaterThan(0);
    expect(pidAlive(spawning.pid!)).toBe(false);

    expect(leaseExists(h.runDir)).toBe(false);
    expect(listRunContainers(backend!, h.runId)).toEqual([]);
    expect(existsSync(runTreePath(backend!, h.runId))).toBe(false);
    const runJson = readRunJson(h.runDir)!;
    expect(runJson).toMatchObject({ gen: 1, status: 'completed', holder: null, containment: 'cooperative' });
    const report = inspectRun(h.runDir);
    expect(report.status).toBe('completed');
    expect(report.containment).toMatchObject({ containment: 'cooperative', probe: { attempted: true, migratedOut: process.getuid?.() === 0 } });
    expect(readFileSync(h.slotsFile, 'utf8')).toContain('"entries": []');

    // resume：全部缓存，零 spawn
    const second = startRunner(h, 'resume');
    expect((await second.exit).code, second.stderr()).toBe(0);
    const s2 = summaryOf(second);
    expect(s2.gen).toBe(2);
    expect(s2.status).toBe('completed');
    expect(s2.replay).toBe('full');
    expect(s2.returned).toEqual(s1.returned);
    const gen2 = rows(h).filter((r) => r.gen === 2).map((r) => r.t);
    expect(gen2).not.toContain('started');
    expect(gen2).toContain('run.takeover');
    expect(loadJournal(h.runDir).integrity.dropped).toEqual([]);
    const takeover = rows(h).find((r): r is Extract<JournalRow, { t: 'run.takeover' }> => r.t === 'run.takeover')!;
    expect(takeover.reason).toBe('lease_missing');

    // --check-replay：只读重放，返回值一致
    const check = await checkReplay({ runDir: h.runDir, distDir: SRC_DIR });
    expect(check).toMatchObject({ ok: true, completed: true, returnedMatches: true, cacheHits: 3 });
  }, 120_000);

  it('resume 不带 cwd / cliPaths / model / limits 时从 run.json 恢复并全缓存；显式换 cwd 则全部重跑并记日志', async () => {
    // 真 CLI 冒烟踩过：`flow resume` 没带 --cwd，runner 用 process.cwd() 当 cwd → content 全变，三步全部重跑。
    const h = harness(SLOGAN);
    const execExtra = { cliPaths: { codex: '/opt/fake/codex' }, model: 'm-1', limits: { agentTimeoutMs: 20_000, scriptSliceMs: 20_000, maxConcurrency: 3 } };
    const first = startRunner(h, 'run', {}, execExtra);
    expect((await first.exit).code, first.stderr()).toBe(0);
    const s1 = summaryOf(first);
    expect(s1.status).toBe('completed');
    const rj1 = readRunJson(h.runDir)!;
    // 假 agent（BOTMUX_FLOW_FAKE_AGENT）隐含 pty 执行器，并记进 run.json 供 resume 沿用
    expect(rj1.execConfig).toEqual({ cwd: realpathSync(h.dataDir), cliPaths: { codex: '/opt/fake/codex' }, model: 'm-1', executor: 'pty' });
    expect(rj1.execConfigDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(rj1.limits.maxConcurrency).toBe(3);

    // resume：什么都不带（cwd 也不带 → 缺省是 process.cwd()，与 run 时不同）
    const second = startRunner(h, 'resume', {}, { cwd: undefined, limits: undefined });
    expect((await second.exit).code, second.stderr()).toBe(0);
    const s2 = summaryOf(second);
    expect(s2).toMatchObject({ gen: 2, status: 'completed', replay: 'full' });
    expect(s2.returned).toEqual(s1.returned);
    expect(rows(h).filter((r) => r.gen === 2).map((r) => r.t)).not.toContain('started');
    const rj2 = readRunJson(h.runDir)!;
    expect(rj2.execConfig).toEqual(rj1.execConfig);
    expect(rj2.execConfigDigest).toBe(rj1.execConfigDigest);
    expect(rj2.limits.maxConcurrency).toBe(3);
    expect(second.stderr()).not.toContain('exec config differs');

    // 显式换 cwd：content 全变 → 三步重跑（gen 3 有 started 行），并明确记日志
    const other = mkdtempSync(join(tmpdir(), 'flow-e2e-other-'));
    try {
      const third = startRunner(h, 'resume', {}, { cwd: other, limits: undefined });
      expect((await third.exit).code, third.stderr()).toBe(0);
      const s3 = summaryOf(third);
      expect(s3).toMatchObject({ gen: 3, status: 'completed', replay: 'none' });
      expect(rows(h).filter((r) => r.gen === 3 && r.t === 'started')).toHaveLength(3);
      expect(third.stderr()).toContain('exec config differs from the recorded run');
      expect(readRunJson(h.runDir)!.execConfig.cwd).toBe(realpathSync(other));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }, 120_000);

  it('发送意图三点崩溃：写入前 → 自动重跑；写入后授权前 / PTY 写入后确认前 → uncertain 待决策', async () => {
    for (const [point, expectation] of [
      ['before_send_intent', 'auto'],
      ['after_send_intent', 'uncertain'],
      ['after_authorize', 'uncertain'],
    ] as const) {
      const h = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'crash test ${point}' })).value;`);
      const crashed = startRunner(h, 'run', { BOTMUX_FLOW_CRASH_AT: point, BOTMUX_FLOW_FAKE_AGENT_SPAWN: '1' });
      const exit1 = await crashed.exit;
      expect(exit1.signal, crashed.stderr()).toBe('SIGKILL');
      // lease 还在（没人释放），worker 的容器里可能还留有后代
      expect(leaseExists(h.runDir)).toBe(true);
      const before = loadJournal(h.runDir).projection;
      expect(before.identities.get('#0')!.latest.state).toBe('inflight');
      expect(before.identities.get('#0')!.latest.intent !== null).toBe(expectation === 'uncertain');

      const resumed = startRunner(h, 'resume');
      if (expectation === 'auto') {
        expect((await resumed.exit).code, resumed.stderr()).toBe(0);
        const s = summaryOf(resumed);
        expect(s.status).toBe('completed');
        expect(s.returned).toBe(`echo:crash test ${point}`);
        const attempts = rows(h).filter((r): r is Extract<JournalRow, { t: 'started' }> => r.t === 'started');
        expect(attempts.map((a) => [a.gen, a.attempt])).toEqual([[1, 1], [2, 2]]);
        const settled = rows(h).find((r): r is Extract<JournalRow, { t: 'failed' }> => r.t === 'failed' && r.attempt === 1)!;
        expect(settled).toMatchObject({ gen: 2, category: 'interrupted', retry: 'auto', effects: 'none' });
      } else {
        await waitForStderr(resumed, 'needs a decision');
        const status = await control(h, { t: 'status' });
        expect(status.ok && status.status).toBe('paused');
        const pending = (status as Extract<ControlResponse, { ok: true }>).pending;
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ identity: '#0', attempt: 1, reason: 'uncertain', outcome: { category: 'interrupted', retry: 'manual', effects: 'uncertain' } });
        const settled = rows(h).find((r): r is Extract<JournalRow, { t: 'failed' }> => r.t === 'failed' && r.attempt === 1)!;
        expect(settled).toMatchObject({ gen: 2, category: 'interrupted', effects: 'uncertain' });
        const decided = await control(h, { t: 'decide', identity: '#0', content: pending[0]!.content, attempt: 1, choice: 'retry', by: 'e2e' });
        expect(decided.ok).toBe(true);
        expect((await resumed.exit).code, resumed.stderr()).toBe(0);
        const s = summaryOf(resumed);
        expect(s.status).toBe('completed');
        expect(s.returned).toBe(`echo:crash test ${point}`);
        const decision = rows(h).find((r): r is Extract<JournalRow, { t: 'decision' }> => r.t === 'decision')!;
        expect(decision).toMatchObject({ gen: 2, choice: 'retry', scope: { identity: '#0', attempt: 1 } });
      }
      // 旧代次容器（含假 agent 留下的 sleep 后代）已被回收，run 树为空
      expect(listRunContainers(backend!, h.runId)).toEqual([]);
      expect(loadJournal(h.runDir).integrity.dropped).toEqual([]);
      expect(leaseExists(h.runDir)).toBe(false);
    }
  }, 240_000);

  it('接管与存活旧写者竞争：旧 runner 在 send.intent 前 SIGSTOP、lease 丢失、新 runner 接管后旧 runner 的追加被围栏', async () => {
    const h = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'race' })).value;`);
    const old = startRunner(h, 'run', { BOTMUX_FLOW_PAUSE_AT: 'before_send_intent' });
    await waitForStderr(old, 'pause injection at before_send_intent');
    await waitFor(() => /\) T /.test(readFileSync(`/proc/${old.child.pid}/stat`, 'utf8')), 5_000, 'old runner stopped');
    const oldLease = readLeaseUnlocked(h.runDir)!;
    expect(oldLease.holderPid).toBe(old.child.pid);
    const oldContainers = listRunContainers(backend!, h.runId);
    expect(oldContainers).toEqual(['c-1-0']);
    const oldWorkerPids = subtreeProcs(containerPath(backend!, h.runId, 'c-1-0')).flatMap((e) => e.pids);
    expect(oldWorkerPids.length).toBeGreaterThan(0);

    // lease 丢失（模拟），且 run.json 里记录的 holder 指向一个已死的 pid：接管者「不知道」旧写者还活着，
    // 只能靠围栏挡住它——这才是设计里「存活旧写者竞争」要验证的路径（若 holder 记录准确，接管会直接杀掉它）
    rmSync(join(h.runDir, 'run.lease'));
    const ghost = spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
    await new Promise<void>((r) => ghost.once('exit', () => r()));
    const runJsonPath = join(h.runDir, 'run.json');
    const runJson = JSON.parse(readFileSync(runJsonPath, 'utf8')) as { holder: { pid: number; identity: string } };
    runJson.holder = { pid: ghost.pid!, identity: `${ghost.pid}:ghost` };
    writeFileSync(runJsonPath, JSON.stringify(runJson));
    const fresh = startRunner(h, 'resume');
    expect((await fresh.exit).code, fresh.stderr()).toBe(0);
    const s = summaryOf(fresh);
    expect(s.gen).toBe(2);
    expect(s.status).toBe('completed');
    // 旧代次的 worker 被 run 级树扫描回收；旧 runner 本身仍活着（SIGSTOP 中）
    for (const pid of oldWorkerPids) expect(pidAlive(pid), `old worker ${pid}`).toBe(false);
    expect(pidAlive(old.child.pid!)).toBe(true);
    const takeover = rows(h).find((r): r is Extract<JournalRow, { t: 'run.takeover' }> => r.t === 'run.takeover')!;
    expect(takeover.reason).toBe('lease_missing');
    expect(takeover.from.pid).toBe(ghost.pid);

    // 放行旧 runner：它的 send.intent 追加必须被围栏，且不能出现在 takeover 之后
    old.child.kill('SIGCONT');
    const oldExit = await old.exit;
    expect(oldExit.code, old.stderr()).toBe(75);
    expect(old.stderr()).toContain('fenced');
    const all = rows(h);
    const takeoverIdx = all.findIndex((r) => r.t === 'run.takeover');
    const gen1After = all.slice(takeoverIdx).filter((r) => r.gen === 1);
    expect(gen1After).toEqual([]);
    expect(loadJournal(h.runDir).integrity.dropped).toEqual([]);
    // 元数据不回退：run.json 是 gen 2 的
    expect(readRunJson(h.runDir)).toMatchObject({ gen: 2, status: 'completed', holder: null });
    expect(listRunContainers(backend!, h.runId)).toEqual([]);
  }, 120_000);

  it('心跳陈旧的假死 runner 被接管并杀死（heartbeat_stale）；两个终端同时 resume 只有一个成功', async () => {
    const h = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'stale' })).value;`);
    const stuck = startRunner(h, 'run', { BOTMUX_FLOW_PAUSE_AT: 'after_send_intent' });
    await waitForStderr(stuck, 'pause injection at after_send_intent');
    await new Promise((r) => setTimeout(r, 3_500)); // 超过 heartbeatStaleMs
    // 卡在 send.intent 之后：接管后是 uncertain → 需要决策；两边都带 --retry-uncertain 让它自动展开成 retry 决策
    const a = startRunner(h, 'resume', {}, { retryUncertain: true });
    const b = startRunner(h, 'resume', {}, { retryUncertain: true });
    const [ea, eb] = await Promise.all([a.exit, b.exit]);
    const ok = [[a, ea], [b, eb]].filter(([, e]) => (e as { code: number }).code === 0);
    const busy = [[a, ea], [b, eb]].filter(([p]) => (p as RunnerProc).stderr().includes('run_busy'));
    expect(ok, `${a.stderr()}\n---\n${b.stderr()}`).toHaveLength(1);
    expect(busy).toHaveLength(1);
    const stuckExit = await stuck.exit;
    expect(stuckExit.signal === 'SIGKILL' || stuckExit.signal === 'SIGTERM' || stuckExit.code === 75).toBe(true);
    const takeovers = rows(h).filter((r): r is Extract<JournalRow, { t: 'run.takeover' }> => r.t === 'run.takeover');
    expect(takeovers).toHaveLength(1);
    expect(takeovers[0]!.reason).toBe('heartbeat_stale');
    expect(takeovers[0]!.from.pid).toBe(stuck.child.pid);
    const winner = ok[0]![0] as RunnerProc;
    const s = summaryOf(winner);
    expect(s.status).toBe('completed');
    expect(s.returned).toBe('echo:stale');
    const decision = rows(h).find((r): r is Extract<JournalRow, { t: 'decision' }> => r.t === 'decision')!;
    expect(decision).toMatchObject({ gen: 2, choice: 'retry', scope: { identity: '#0', attempt: 1 } });
    expect(listRunContainers(backend!, h.runId)).toEqual([]);
    expect(leaseExists(h.runDir)).toBe(false);
  }, 120_000);

  it('--retry-uncertain 展开为逐条 retry 决策；坏 cliPath 与登录向导两种失败 effects:none 且带证据', async () => {
    const h = harness(`export default async (ctx) => {
      const a = await ctx.agent({ cli: 'codex', prompt: 'one' });
      return a.ok ? a.value : { category: a.category, retry: a.retry, effects: a.effects, tail: a.evidence.screenTail };
    }`);
    const setup = startRunner(h, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'setup' });
    expect((await setup.exit).code, setup.stderr()).toBe(1);
    const s1 = summaryOf(setup);
    expect(s1.status).toBe('failed');
    expect(s1.returned).toMatchObject({ category: 'setup_required', retry: 'manual', effects: 'none', tail: 'Please sign in to continue' });

    const h2 = harness(`export default async (ctx) => {
      const a = await ctx.agent({ cli: 'codex', prompt: 'two' });
      return a.ok ? a.value : { category: a.category, retry: a.retry, effects: a.effects };
    }`);
    const bad = startRunner(h2, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'open-fail' });
    expect((await bad.exit).code, bad.stderr()).toBe(1);
    expect(summaryOf(bad).returned).toMatchObject({ category: 'spawn_failed', retry: 'auto', effects: 'none' });
    // resume（agent 修好了）：spawn_failed/auto/none 自动重跑
    const fixed = startRunner(h2, 'resume');
    expect((await fixed.exit).code, fixed.stderr()).toBe(0);
    expect(summaryOf(fixed).returned).toBe('echo:two');

    // exit 模式：提交后 CLI 退出 → crashed/auto/uncertain → 待决策；--retry-uncertain 直接展开
    const h3 = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'three' })).value;`);
    const crash = startRunner(h3, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'exit' });
    expect((await crash.exit).code, crash.stderr()).toBe(1);
    const failedRow = rows(h3).find((r): r is Extract<JournalRow, { t: 'failed' }> => r.t === 'failed')!;
    expect(failedRow).toMatchObject({ category: 'crashed', retry: 'auto', effects: 'uncertain' });
    const retried = startRunner(h3, 'resume', {}, { retryUncertain: true });
    expect((await retried.exit).code, retried.stderr()).toBe(0);
    expect(summaryOf(retried).returned).toBe('echo:three');
    const decision = rows(h3).find((r): r is Extract<JournalRow, { t: 'decision' }> => r.t === 'decision')!;
    expect(decision).toMatchObject({ choice: 'retry', scope: { identity: '#0', attempt: 1 } });
  }, 180_000);

  it('schema：契约文件里取最后一个 JSON 块；一次 repair 后仍不符 → schema_mismatch；同容器两次提交文件名不同', async () => {
    const h = harness(`export default async (ctx) => {
      const good = await ctx.agent({ cli: 'codex', prompt: 'nice', schema: { type: 'object', required: ['slogan'], properties: { slogan: { type: 'string' } } } });
      const fixed = await ctx.agent({ cli: 'codex', prompt: 'repair-me', schema: { type: 'object', required: ['slogan'], properties: { slogan: { type: 'string' } } } });
      const bad = await ctx.agent({ cli: 'codex', prompt: 'strict', schema: { type: 'object', required: ['index'], properties: { index: { type: 'integer' } } } });
      return { good: good.value, fixed: fixed.value, bad: bad.ok ? 'unexpected' : bad.category };
    }`);
    const p = startRunner(h, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'json' });
    expect((await p.exit).code, p.stderr()).toBe(2); // partial：一个失败
    expect(summaryOf(p).returned).toEqual({ good: { slogan: 'nice' }, fixed: { slogan: 'repair-me' }, bad: 'schema_mismatch' });
    const intents = rows(h).filter((r): r is Extract<JournalRow, { t: 'send.intent' }> => r.t === 'send.intent');
    const byIdentity = new Map<string, string[]>();
    for (const i of intents) byIdentity.set(i.identity, [...(byIdentity.get(i.identity) ?? []), i.outboxFile]);
    expect(byIdentity.get('#1')).toHaveLength(2); // repair 是第二次提交
    expect(new Set(byIdentity.get('#1')).size).toBe(2);
    expect(byIdentity.get('#2')).toHaveLength(2);
    const failed = rows(h).find((r): r is Extract<JournalRow, { t: 'failed' }> => r.t === 'failed')!;
    expect(failed).toMatchObject({ identity: '#2', category: 'schema_mismatch', retry: 'manual', effects: 'uncertain' });
  }, 120_000);

  it('手工追加 gen 不匹配的行 → journal_integrity 暂停；--accept-journal 后继续且写 decision', async () => {
    const h = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'integrity' })).value;`);
    const first = startRunner(h, 'run');
    expect((await first.exit).code, first.stderr()).toBe(0);
    writeFileSync(journalPath(h.runDir), `${JSON.stringify({ t: 'note', gen: 7, ts: Date.now(), text: 'hand edited' })}\n`, { flag: 'a' });
    const paused = startRunner(h, 'resume');
    await waitForStderr(paused, 'journal_integrity');
    const status = await control(h, { t: 'status' });
    expect(status.ok && status.status).toBe('paused');
    const decided = await control(h, { t: 'decide-run', choice: 'accept-journal', by: 'e2e' });
    expect(decided.ok).toBe(true);
    expect((await paused.exit).code, paused.stderr()).toBe(0);
    expect(summaryOf(paused).replay).toBe('full');
    const decision = rows(h).find((r): r is Extract<JournalRow, { t: 'decision' }> => r.t === 'decision')!;
    expect(decision).toMatchObject({ gen: 2, choice: 'accept-journal', scope: { run: true } });
    const flagged = startRunner(h, 'resume', {}, { acceptJournal: true });
    expect((await flagged.exit).code, flagged.stderr()).toBe(0);
    expect(inspectRun(h.runDir).integrity.dropped).toBe(1);
  }, 120_000);

  it('失速看门狗：await new Promise(() => {}) 在 scriptSliceMs 内 script_stalled；cancel 控制命令使 run canceled', async () => {
    const h = harness(`export default async (ctx) => { await ctx.log('about to stall'); await new Promise(() => {}); }`);
    const stalled = startRunner(h, 'run', {}, { limits: { scriptSliceMs: 2_000 } });
    expect((await stalled.exit).code, stalled.stderr()).toBe(1);
    const err = rows(h).find((r): r is Extract<JournalRow, { t: 'run.error' }> => r.t === 'run.error')!;
    expect(err.code).toBe('script_stalled');
    expect(summaryOf(stalled).status).toBe('failed');

    const h2 = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'slow' })).value;`);
    const slow = startRunner(h2, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'slow:30000' });
    await waitFor(() => rows(h2).some((r) => r.t === 'send.intent'), 30_000, 'send.intent');
    const cancelled = await control(h2, { t: 'cancel', by: 'e2e' });
    expect(cancelled.ok).toBe(true);
    expect((await slow.exit).code, slow.stderr()).toBe(1);
    expect(summaryOf(slow).status).toBe('canceled');
    expect(listRunContainers(backend!, h2.runId)).toEqual([]);
  }, 120_000);

  it('违反 §5.2 的脚本（++rank）：run 本身完成，但 --check-replay 只读重放返回值不一致', async () => {
    const h = harness(`export default async (ctx) => {
      let rank = 0;
      const results = await ctx.parallel(['a', 'b'].map((name) => async (c) => {
        const r = await c.agent({ cli: 'codex', prompt: 'rank ' + name });
        return { name, rank: ++rank, value: r.value };
      }));
      return results.map((r) => r.value); // 分支返回值被包成 Outcome
    }`);
    // a 慢、b 快 → 首跑 b 先拿 rank 1；重放时全部命中缓存、按代码顺序结算 → a 先拿 rank 1：返回值不同
    const first = startRunner(h, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'slow-if:rank a:1500' });
    expect((await first.exit).code, first.stderr()).toBe(0);
    const s1 = summaryOf(first);
    expect(s1.status).toBe('completed');
    expect(s1.returned).toEqual([{ name: 'a', rank: 2, value: 'echo:rank a' }, { name: 'b', rank: 1, value: 'echo:rank b' }]);
    const check = await checkReplay({ runDir: h.runDir, distDir: SRC_DIR });
    expect(check.completed).toBe(true);
    expect(check.cacheHits).toBe(2);
    expect(check.returnedMatches).toBe(false);
    expect(check.ok).toBe(false);
    expect(check.actual).toEqual([{ name: 'a', rank: 1, value: 'echo:rank a' }, { name: 'b', rank: 2, value: 'echo:rank b' }]);
  }, 120_000);

  it('全部 agent 失败 → status failed / health all_failed；退出码 1；大结果落 value.json 并在缓存与 check-replay 中还原', async () => {
    const h = harness(`export default async (ctx) => {
      const rs = await ctx.parallel([1, 2, 3].map((i) => (c) => c.agent({ cli: 'codex', prompt: 'fail ' + i })));
      return rs.map((r) => r.ok ? 'ok' : r.category);
    }`);
    const p = startRunner(h, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'exit' });
    expect((await p.exit).code, p.stderr()).toBe(1);
    const s = summaryOf(p);
    expect(s.status).toBe('failed');
    expect(s.returned).toEqual(['crashed', 'crashed', 'crashed']);
    const finished = rows(h).find((r): r is Extract<JournalRow, { t: 'run.finished' }> => r.t === 'run.finished')!;
    expect(finished).toMatchObject({ status: 'failed', health: 'all_failed', counts: { started: 3, ok: 0, failed: 3 } });
    expect(inspectRun(h.runDir).pending).toHaveLength(3); // crashed/auto/uncertain → 待决策

    const h2 = harness(`export default async (ctx) => {
      const r = await ctx.agent({ cli: 'codex', prompt: 'big' });
      return { len: r.value.length, head: r.value.slice(0, 20) };
    }`);
    const big = startRunner(h2, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'big:20000' });
    expect((await big.exit).code, big.stderr()).toBe(0);
    expect(summaryOf(big).returned).toEqual({ len: 20000, head: 'x'.repeat(20) });
    const result = rows(h2).find((r): r is Extract<JournalRow, { t: 'result' }> => r.t === 'result')!;
    expect(result.value).toMatchObject({ $file: expect.stringMatching(/value\.json$/) });
    expect(existsSync((result.value as { $file: string }).$file)).toBe(true);
    const again = startRunner(h2, 'resume');
    expect((await again.exit).code, again.stderr()).toBe(0);
    expect(summaryOf(again)).toMatchObject({ replay: 'full', returned: { len: 20000, head: 'x'.repeat(20) } });
    const check = await checkReplay({ runDir: h2.runDir, distDir: SRC_DIR });
    expect(check).toMatchObject({ ok: true, cacheHits: 1 });
  }, 120_000);

  it('runner 收到 SIGTERM：写 run.interrupted、回收容器、释放 lease、退出码 130；resume 后自动续跑', async () => {
    const h = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'interrupt me' })).value;`);
    const p = startRunner(h, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'slow:30000', BOTMUX_FLOW_FAKE_AGENT_SPAWN: '1' });
    await waitFor(() => rows(h).some((r) => r.t === 'send.intent'), 30_000, 'send.intent');
    const worker = subtreeProcs(containerPath(backend!, h.runId, 'c-1-0')).flatMap((e) => e.pids);
    expect(worker.length).toBeGreaterThan(1); // worker + sleep
    p.child.kill('SIGTERM');
    expect((await p.exit).code, p.stderr()).toBe(130);
    const interrupted = rows(h).find((r): r is Extract<JournalRow, { t: 'run.interrupted' }> => r.t === 'run.interrupted')!;
    expect(interrupted).toMatchObject({ gen: 1, reason: 'SIGTERM', inflight: ['#0'] });
    for (const pid of worker) expect(pidAlive(pid), `pid ${pid}`).toBe(false);
    expect(listRunContainers(backend!, h.runId)).toEqual([]);
    expect(leaseExists(h.runDir)).toBe(false);
    expect(inspectRun(h.runDir).status).toBe('interrupted');
    // 中断时 send.intent 已写 → uncertain；--retry-uncertain 续跑
    const resumed = startRunner(h, 'resume', {}, { retryUncertain: true });
    expect((await resumed.exit).code, resumed.stderr()).toBe(0);
    expect(summaryOf(resumed).returned).toBe('echo:interrupt me');
    const takeover = rows(h).find((r): r is Extract<JournalRow, { t: 'run.takeover' }> => r.t === 'run.takeover')!;
    expect(takeover.reason).toBe('lease_missing');
  }, 120_000);
});
