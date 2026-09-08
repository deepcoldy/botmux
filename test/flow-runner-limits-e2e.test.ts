/**
 * flow runner 进程级验收，第二组（设计文档 §11 M1 验收 5/7/8/10/11/15/17）：
 * 容器创建临界区内外的接管边界、三代次复用、无容器后端的暂停、逃逸检测、CPU 预算 / maxNotes、
 * 槽位与清扫器、常驻 run 上限与 RSS 测量。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { containerPath, listRunContainers, subtreeProcs } from '../src/flow/container.js';
import { leaseExists } from '../src/flow/ownership.js';
import { acquireSlot, listSlots, sweepSlots } from '../src/flow/slots.js';
import { cmdFlow, countResidentRuns } from '../src/cli/flow.js';
import { FLOW_ATTEMPT_ENV_KEY, type JournalRow } from '../src/flow/types.js';
import { SRC_DIR, backend, control, harness, pidAlive, rows, startRunner, summaryOf, waitFor, waitForStderr } from './helpers/flow-e2e.js';

const describeIf = backend ? describe : describe.skip;

function environOf(pid: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0')) {
    const eq = kv.indexOf('=');
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}

function rssKb(pid: number): number {
  const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
  return m ? Number(m[1]) : -1;
}

describeIf('flow runner 进程级（第二组：资源边界与上限）', () => {
  beforeAll(() => {
    process.env.BOTMUX_FLOW_TS_SRC_DIR = SRC_DIR;
  });

  it('容器创建与接管的资源边界：在临界区内 / mkdir 后入容器前 / 入容器后告知 worker 前 SIGSTOP 旧 runner，接管后旧代次无进程残留', async () => {
    for (const point of ['in_container_created_section', 'after_container_created', 'in_contained_section', 'before_contained_notify'] as const) {
      const h = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'boundary ${point}' })).value;`);
      const old = startRunner(h, 'run', { BOTMUX_FLOW_PAUSE_AT: point });
      await waitForStderr(old, `pause injection at ${point}`);
      await waitFor(() => /\) T /.test(readFileSync(`/proc/${old.child.pid}/stat`, 'utf8')), 5_000, 'old runner stopped');
      const inSection = point.startsWith('in_');
      const oldTree = subtreeProcs(containerPath(backend!, h.runId, 'c-1-0')).flatMap((e) => e.pids);
      // 旧 runner 的直接子进程（script host + 可能已 spawn 的 worker）
      const oldChildren = readFileSync(`/proc/${old.child.pid}/task/${old.child.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
      expect(oldChildren.length).toBeGreaterThan(0);

      await new Promise((r) => setTimeout(r, 3_500)); // 心跳 / 锁占有都超过 3s 陈旧阈值
      const fresh = startRunner(h, 'resume', {}, { retryUncertain: true });
      expect((await fresh.exit).code, fresh.stderr()).toBe(0);
      const s = summaryOf(fresh);
      expect(s.status).toBe('completed');
      expect(s.returned).toBe(`echo:boundary ${point}`);
      const takeover = rows(h).find((r): r is Extract<JournalRow, { t: 'run.takeover' }> => r.t === 'run.takeover')!;
      // 临界区内停住的持有者同时也是 lease 持有者：心跳陈旧先于锁占有到期被判定，杀死后其残留锁按死 pid 陈旧回收
      expect(takeover.reason).toBe('heartbeat_stale');
      expect(takeover.from.pid).toBe(old.child.pid);
      if (inSection) expect(fresh.stderr()).not.toContain('run_busy');
      // 旧 runner 被杀；旧代次容器与其中一切进程都没了；待握手的 worker 也没了
      await waitFor(() => !pidAlive(old.child.pid!), 10_000, 'old runner dead');
      expect(listRunContainers(backend!, h.runId)).toEqual([]);
      for (const pid of oldTree) expect(pidAlive(pid), `container pid ${pid}`).toBe(false);
      await waitFor(() => oldChildren.every((pid) => !pidAlive(pid)), 15_000, `old runner children ${oldChildren.join(',')} gone`);
      expect(loadRowsGen(h, 2).some((t) => t === 'started')).toBe(true);
      expect(leaseExists(h.runDir)).toBe(false);
    }
  }, 300_000);

  it('从话题 CLI 的 shell 里触发：script host 与 agent worker 的真实 environ 不含父话题的会话身份，只带本 run 的 flow 标记', async () => {
    // 触发 shell 就是某个话题的 CLI 时，process.env 带着那个话题的路由身份；子 agent 若继承会把
    // 自己当成父话题会话（hook / botmux send 误路由）。这里在 runner 的 env 里放一份假话题身份，
    // 读子进程 /proc/<pid>/environ 核实边界。
    const h = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'env' })).value;`);
    const parentTopic = {
      BOTMUX_SESSION_ID: 'parent-topic', BOTMUX_CHAT_ID: 'oc_parent', BOTMUX_LARK_APP_ID: 'cli_parent', BOTMUX_CHAT_TYPE: 'thread',
      BOTMUX_OWNER_OPEN_ID: 'ou_parent', __OWNER_OPEN_ID: 'ou_parent', BOTMUX_MCP_GATEWAY_SOCKET: '/tmp/parent-gw.sock',
      BOTS_CONFIG: '/tmp/parent-bots.json', SESSION_DATA_DIR: '/tmp/parent-data', LARK_APP_ID: 'cli_parent', LARK_APP_SECRET: 'secret',
      CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent-claude', TMUX: '/tmp/tmux-0/default,1,0',
      BOTMUX_FLOW_ATTEMPT: 'outer-run/#9/1-1', BOTMUX_FLOW_RUN_ID: 'outer-run', BOTMUX_FLOW_RUN_DIR: '/tmp/outer-run',
      FLOW_E2E_PLAIN: 'kept',
    };
    const p = startRunner(h, 'run', { ...parentTopic, BOTMUX_FLOW_FAKE_AGENT: 'slow:4000' });
    await waitFor(() => rows(h).some((r) => r.t === 'attempt.state' && r.state === 'ready'), 30_000, 'agent ready');
    const workerPid = (rows(h).find((r): r is Extract<JournalRow, { t: 'attempt.state' }> => r.t === 'attempt.state' && r.state === 'spawning'))!.pid!;
    const hostPid = Number(/script host pid (\d+)/.exec(p.stderr())![1]);
    const worker = environOf(workerPid);
    const host = environOf(hostPid);
    for (const env of [worker, host]) {
      for (const key of Object.keys(parentTopic)) {
        if (key.startsWith('BOTMUX_FLOW_') || key === 'FLOW_E2E_PLAIN') continue;
        expect(env, key).not.toHaveProperty(key);
      }
      expect(env.FLOW_E2E_PLAIN).toBe('kept');
      expect(env.BOTMUX_FLOW_RUN_ID).toBe(h.runId);
      expect(env.BOTMUX_FLOW_RUN_DIR).toBe(h.runDir);
    }
    // 外层 run 的 attempt 标记不得继承（标记只由 worker 打在它起的 CLI env 上，worker 自身没有）
    expect(worker).not.toHaveProperty(FLOW_ATTEMPT_ENV_KEY);
    expect(host).not.toHaveProperty(FLOW_ATTEMPT_ENV_KEY);
    expect(worker.BOTMUX_FLOW_FAKE_AGENT).toBe('slow:4000');
    expect((await p.exit).code, p.stderr()).toBe(0);
    expect(summaryOf(p).returned).toBe('echo:env');
  }, 60_000);

  it('连续三代次：gen 1 失败在 gen 2 决策重试成功，gen 3 全部缓存零 spawn；gen 严格单调', async () => {
    const h = harness(`export default async (ctx) => {
      const a = await ctx.agent({ cli: 'codex', prompt: 'first' });
      const b = await ctx.agent({ cli: 'codex', prompt: 'second' });
      return [a.ok ? a.value : a.category, b.ok ? b.value : b.category];
    }`);
    // gen 1：first 崩溃（crashed/auto/uncertain → 待决策），脚本继续跑 second 成功
    const g1 = startRunner(h, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'slow-if:first:99999999' });
    await waitFor(() => rows(h).some((r) => r.t === 'send.intent'), 30_000, 'send.intent');
    g1.child.kill('SIGKILL');
    await g1.exit;
    // gen 2：first 是 inflight+intent → uncertain；--retry-uncertain 展开
    const g2 = startRunner(h, 'resume', {}, { retryUncertain: true });
    expect((await g2.exit).code, g2.stderr()).toBe(0);
    expect(summaryOf(g2)).toMatchObject({ gen: 2, status: 'completed', returned: ['echo:first', 'echo:second'], replay: 'none' });
    const started = rows(h).filter((r): r is Extract<JournalRow, { t: 'started' }> => r.t === 'started').map((r) => [r.gen, r.identity, r.attempt]);
    expect(started).toEqual([[1, '#0', 1], [2, '#0', 2], [2, '#1', 1]]);
    // gen 3：全缓存
    const g3 = startRunner(h, 'resume');
    expect((await g3.exit).code, g3.stderr()).toBe(0);
    expect(summaryOf(g3)).toMatchObject({ gen: 3, status: 'completed', returned: ['echo:first', 'echo:second'], replay: 'full' });
    expect(rows(h).filter((r) => r.gen === 3 && r.t === 'started')).toEqual([]);
    const gens = rows(h).filter((r) => r.t === 'run.started' || r.t === 'run.takeover').map((r) => r.gen);
    expect(gens).toEqual([1, 2, 3]);
  }, 180_000);

  it('无容器后端时 resume 带在途 attempt → paused(container_unavailable)；assume-clean 决策后继续', async () => {
    const h = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'nobackend' })).value;`);
    const g1 = startRunner(h, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'slow:99999999' }, { containerBackend: null });
    await waitFor(() => rows(h).some((r) => r.t === 'send.intent'), 30_000, 'send.intent');
    g1.child.kill('SIGKILL');
    await g1.exit;
    const g2 = startRunner(h, 'resume', {}, { containerBackend: null, retryUncertain: true });
    await waitForStderr(g2, 'container_unavailable');
    const status = await control(h, { t: 'status' });
    expect(status.ok && status.status).toBe('paused');
    expect((await control(h, { t: 'decide-run', choice: 'assume-clean', by: 'e2e' })).ok).toBe(true);
    expect((await g2.exit).code, g2.stderr()).toBe(0);
    expect(summaryOf(g2).returned).toBe('echo:nobackend');
    // 拒绝 assume-clean → canceled
    const h2 = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'nobackend2' })).value;`);
    const k1 = startRunner(h2, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'slow:99999999' }, { containerBackend: null });
    await waitFor(() => rows(h2).some((r) => r.t === 'send.intent'), 30_000, 'send.intent');
    k1.child.kill('SIGKILL');
    await k1.exit;
    const k2 = startRunner(h2, 'resume', {}, { containerBackend: null });
    await waitForStderr(k2, 'container_unavailable');
    expect((await control(h2, { t: 'cancel', by: 'e2e' })).ok).toBe(true);
    expect((await k2.exit).code, k2.stderr()).toBe(1);
    expect(summaryOf(k2).status).toBe('canceled');
  }, 120_000);

  it('逃逸检测：带本 run 标记却不在任何容器里的进程 → resume paused(escape) 并写 escape 行；assume-clean 后继续；--require-containment 在 cooperative 下拒绝', async () => {
    const h = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'escape' })).value;`);
    const first = startRunner(h, 'run');
    expect((await first.exit).code, first.stderr()).toBe(0);
    // 模拟逃逸者：容器外的进程带着 marker
    const escapee = spawn('sleep', ['120'], { stdio: 'ignore', env: { ...process.env, [FLOW_ATTEMPT_ENV_KEY]: `${h.runId}/#0/1-1` } });
    try {
      const resumed = startRunner(h, 'resume');
      await waitForStderr(resumed, 'escape');
      const status = await control(h, { t: 'status' });
      expect(status.ok && status.status).toBe('paused');
      const escapeRow = rows(h).find((r): r is Extract<JournalRow, { t: 'escape' }> => r.t === 'escape')!;
      expect(escapeRow.pids).toContain(escapee.pid);
      expect((await control(h, { t: 'decide-run', choice: 'assume-clean', by: 'e2e' })).ok).toBe(true);
      expect((await resumed.exit).code, resumed.stderr()).toBe(0);
      expect(summaryOf(resumed).replay).toBe('full');
    } finally {
      escapee.kill('SIGKILL');
    }
    const strict = startRunner(h, 'resume', {}, { requireContainment: true });
    const exit = await strict.exit;
    expect(exit.code).not.toBe(0);
    expect(strict.stderr()).toContain('--require-containment');
  }, 120_000);

  it('CPU 预算：纯计算脚本超过 maxScriptCpuMs → script_cpu_exceeded；log 刷到 maxNotes → 硬错误；activeMs/cpuMs 经 activity 行跨代次恢复', async () => {
    // 失控的纯计算（lint 禁止 Date，这里就是个死循环）：只能靠 CPU 预算终止
    const h = harness(`export default async (ctx) => {
      await ctx.log('spin');
      let x = 1;
      while (x > 0) { x = (x * 31 + 7) % 1000003 + 1; }
      return x;
    }`);
    const spin = startRunner(h, 'run', {}, { limits: { maxScriptCpuMs: 1_500, scriptSliceMs: 30_000 } });
    expect((await spin.exit).code, spin.stderr()).toBe(1);
    const err = rows(h).find((r): r is Extract<JournalRow, { t: 'run.error' }> => r.t === 'run.error')!;
    expect(err.code).toBe('script_cpu_exceeded');
    const activity = rows(h).filter((r): r is Extract<JournalRow, { t: 'activity' }> => r.t === 'activity');
    expect(activity.length).toBeGreaterThan(0);
    expect(activity[activity.length - 1]!.cpuMs).toBeGreaterThan(1_000);
    // script host 已被清理
    const scriptPid = Number(/script host pid (\d+)/.exec(spin.stderr())?.[1]);
    await waitFor(() => !pidAlive(scriptPid), 5_000, 'script host gone');

    const h2 = harness(`export default async (ctx) => { for (let i = 0; i < 10; i++) await ctx.log('n' + i); return 'done'; }`);
    const notes = startRunner(h2, 'run', {}, { limits: { maxNotes: 3 } });
    expect((await notes.exit).code, notes.stderr()).toBe(1);
    const err2 = rows(h2).find((r): r is Extract<JournalRow, { t: 'run.error' }> => r.t === 'run.error')!;
    expect(err2.error).toContain('maxNotes');
    expect(rows(h2).filter((r) => r.t === 'note')).toHaveLength(3);

    // activeMs 恢复：gen 1 跑 ~2s 后被杀，gen 2 的 activity 行从 gen 1 的值继续
    const h3 = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'active' })).value;`);
    const g1 = startRunner(h3, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'slow:99999999' });
    await waitFor(() => rows(h3).some((r) => r.t === 'send.intent'), 30_000, 'send.intent');
    await new Promise((r) => setTimeout(r, 2_500));
    g1.child.kill('SIGKILL');
    await g1.exit;
    const g2 = startRunner(h3, 'resume', {}, { retryUncertain: true });
    expect((await g2.exit).code, g2.stderr()).toBe(0);
    const acts = rows(h3).filter((r): r is Extract<JournalRow, { t: 'activity' }> => r.t === 'activity');
    const lastGen1 = [...acts].reverse().find((a) => a.gen === 1)!;
    const firstGen2 = acts.find((a) => a.gen === 2)!;
    // activity 行只在时钟状态切换与每 60s 写，恢复值的误差上限是一个写入间隔（§9）：只断言单调不回退
    expect(lastGen1.activeMs).toBeGreaterThan(0);
    expect(firstGen2.activeMs).toBeGreaterThanOrEqual(lastGen1.activeMs);
    const finalAct = acts[acts.length - 1]!;
    expect(finalAct.gen).toBe(2);
    expect(finalAct.activeMs).toBeGreaterThan(lastGen1.activeMs);
  }, 180_000);

  it('槽位不早于容器清空释放：旧 runner SIGKILL 后容器留有后代，另一 run 申请槽位被挡；清扫器回收确认为空后才放行', async () => {
    const dataDirHolder = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'holder' })).value;`);
    const holder = startRunner(dataDirHolder, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'slow:99999999', BOTMUX_FLOW_FAKE_AGENT_SPAWN: '1' }, { hostSlots: 1 });
    await waitFor(() => rows(dataDirHolder).some((r) => r.t === 'send.intent'), 30_000, 'send.intent');
    const residents = subtreeProcs(containerPath(backend!, dataDirHolder.runId, 'c-1-0')).flatMap((e) => e.pids);
    expect(residents.length).toBeGreaterThan(1);
    holder.child.kill('SIGKILL');
    await holder.exit;
    await new Promise((r) => setTimeout(r, 500));
    // 容器仍非空（worker 因 IPC 断开会自退，它留下的 sleep 不会）
    expect(subtreeProcs(containerPath(backend!, dataDirHolder.runId, 'c-1-0')).flatMap((e) => e.pids).length).toBeGreaterThan(0);
    const slots = await listSlots(dataDirHolder.slotsFile);
    expect(slots).toHaveLength(1);
    expect(slots[0]!.state).toBe('held');

    // 另一个 run 共用同一 slots 文件、容量 1 → 排队
    const other = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'other' })).value;`);
    const waiting = startRunner(other, 'run', {}, { hostSlots: 1, slotsFile: dataDirHolder.slotsFile });
    await waitFor(() => rows(other).some((r) => r.t === 'attempt.state' && r.state === 'queued'), 30_000, 'queued');
    await new Promise((r) => setTimeout(r, 2_000));
    expect(rows(other).some((r) => r.t === 'container.created')).toBe(false);
    // 清扫器（daemon 侧）：标记 → 回收容器 → 确认为空 → 释放
    const report = await sweepSlots(dataDirHolder.slotsFile, backend);
    expect(report.marked.map((m) => m.runId)).toEqual([dataDirHolder.runId]);
    expect(report.reclaimed.map((m) => m.runId)).toEqual([dataDirHolder.runId]);
    for (const pid of residents) expect(pidAlive(pid), `resident ${pid}`).toBe(false);
    expect(listRunContainers(backend!, dataDirHolder.runId)).toEqual([]);
    expect(await listSlots(dataDirHolder.slotsFile)).not.toContainEqual(expect.objectContaining({ runId: dataDirHolder.runId }));
    expect((await waiting.exit).code, waiting.stderr()).toBe(0);
    expect(summaryOf(waiting).returned).toBe('echo:other');
    // 之后 resume 旧 run：没有可改记的条目，正常续跑，清扫器不会重复释放
    const resumed = startRunner(dataDirHolder, 'resume', {}, { retryUncertain: true, hostSlots: 1 });
    expect((await resumed.exit).code, resumed.stderr()).toBe(0);
    expect(await listSlots(dataDirHolder.slotsFile)).toEqual([]);

    // 反向：先 resume 旧 run（新 runner 改记条目、回收后释放），清扫器无事可做
    const h3 = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'adopt' })).value;`);
    const k = startRunner(h3, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'slow:99999999', BOTMUX_FLOW_FAKE_AGENT_SPAWN: '1' }, { hostSlots: 1 });
    await waitFor(() => rows(h3).some((r) => r.t === 'send.intent'), 30_000, 'send.intent');
    k.child.kill('SIGKILL');
    await k.exit;
    const r2 = startRunner(h3, 'resume', {}, { retryUncertain: true, hostSlots: 1 });
    expect((await r2.exit).code, r2.stderr()).toBe(0);
    expect(summaryOf(r2).returned).toBe('echo:adopt');
    expect(await listSlots(h3.slotsFile)).toEqual([]);
    const report2 = await sweepSlots(h3.slotsFile, backend);
    expect(report2).toEqual({ marked: [], reclaimed: [], failed: [], skipped: [] });
  }, 180_000);

  it('常驻 run 上限：live runner 数达到上限时 flow run/resume 拒绝；paused 下 runner + script host 的 RSS 有测量记录', async () => {
    const h = harness(`export default async (ctx) => (await ctx.agent({ cli: 'codex', prompt: 'resident' })).value;`);
    const crashed = startRunner(h, 'run', { BOTMUX_FLOW_FAKE_AGENT: 'exit' });
    expect((await crashed.exit).code).toBe(1);
    // resume：crashed/auto/uncertain 的重放处置是待决策 → paused（runner 常驻）
    const paused = startRunner(h, 'resume');
    await waitForStderr(paused, 'needs a decision');
    expect(countResidentRuns(h.dataDir)).toMatchObject({ count: 1, runIds: [h.runId] });
    const scriptPid = Number(/script host pid (\d+)/.exec(paused.stderr())?.[1]);
    const rss = { runnerKb: rssKb(paused.child.pid!), scriptHostKb: rssKb(scriptPid) };
    expect(rss.runnerKb).toBeGreaterThan(0);
    expect(rss.scriptHostKb).toBeGreaterThan(0);
    process.stdout.write(`[flow rss] paused runner ${Math.round(rss.runnerKb / 1024)} MB, script host ${Math.round(rss.scriptHostKb / 1024)} MB\n`);

    const out: string[] = [];
    const err: string[] = [];
    const script = join(h.dataDir, 'another.mjs');
    writeFileSync(script, `export default async (ctx) => 'x';`);
    const code = await cmdFlow('run', [script, '--data-dir', h.dataDir, '--max-resident-runs', '1', '--foreground'], { dataDir: h.dataDir, distDir: SRC_DIR, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('maxResidentRuns (1) reached');
    expect(out).toEqual([]);
    // 决策后 runner 退出，上限释放
    const status = await control(h, { t: 'status' });
    const pending = (status as Extract<typeof status, { ok: true }>).pending[0]!;
    expect((await control(h, { t: 'decide', identity: '#0', content: pending.content, attempt: 1, choice: 'accept-failed', by: 'e2e' })).ok).toBe(true);
    expect((await paused.exit).code, paused.stderr()).toBe(1);
    expect(countResidentRuns(h.dataDir).count).toBe(0);
    mkdirSync(join(h.dataDir, 'flow-runs'), { recursive: true });
    const code2 = await cmdFlow('run', [script, '--data-dir', h.dataDir, '--max-resident-runs', '1', '--foreground', '--unsafe-no-container'], { dataDir: h.dataDir, distDir: SRC_DIR, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
    expect(code2, err.join('\n')).toBe(0);
    expect(out.some((l) => l.includes('completed'))).toBe(true);
    expect(existsSync(join(h.dataDir, 'flow-runs'))).toBe(true);
  }, 120_000);
});

function loadRowsGen(h: ReturnType<typeof harness>, gen: number): string[] {
  return rows(h).filter((r) => r.gen === gen).map((r) => r.t);
}
