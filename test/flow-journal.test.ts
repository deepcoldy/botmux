/**
 * journal 追加 / 完整性校验 / 跨代次投影 / 重放规则（设计文档 §5.4、§5.5）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JournalRowTooLargeError,
  appendRow,
  appendRows,
  checkIntegrity,
  journalMaxGen,
  journalPath,
  loadJournal,
  parseJournal,
  project,
  readJournal,
} from '../src/flow/journal.js';
import { decideReplay, interruptedOutcome } from '../src/flow/replay.js';
import { FencedError, acquireRun, selfIdentity, terminateProcess } from '../src/flow/ownership.js';
import {
  attemptSessionId,
  canonicalJson,
  contentHash,
  identityDirName,
  outboxFileName,
  parallelBranchScope,
  pipelineStageScope,
  positionIdentity,
} from '../src/flow/identity.js';
import type { JournalRow } from '../src/flow/types.js';

const dirs: string[] = [];
function makeRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-journal-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let ts = 1_000;
const row = <T extends JournalRow>(r: Omit<T, 'ts'>): T => ({ ...(r as T), ts: ts++ });

const started = (gen: number): JournalRow =>
  row({ t: 'run.started', gen, runId: 'r', script: 's.mjs', scriptHash: 'h', input: {}, binding: null, cwd: '/', execConfigDigest: 'd', bootId: 'b', containment: 'cooperative', boundary: 'none', probe: null, holder: { pid: 1, identity: 'i' } });
const takeover = (gen: number): JournalRow =>
  row({ t: 'run.takeover', gen, from: { pid: 1, identity: 'i' }, reason: 'holder_dead', containment: 'cooperative', boundary: 'none', probe: null, bootId: 'b', holder: { pid: 2, identity: 'j' } });
const attemptStarted = (gen: number, identity: string, attempt: number, content: string): JournalRow =>
  row({ t: 'started', gen, identity, attempt, content, kind: 'agent', cli: 'claude-code' });
const intent = (gen: number, identity: string, attempt: number, turn = 1): JournalRow =>
  row({ t: 'send.intent', gen, identity, attempt, container: `c-${gen}-0`, turn, outboxFile: outboxFileName(gen, turn, identity) });
const result = (gen: number, identity: string, attempt: number, value: unknown): JournalRow =>
  row({ t: 'result', gen, identity, attempt, value, evidence: { source: 'contract_file' } });
const failed = (gen: number, identity: string, attempt: number, retry: 'auto' | 'manual', effects: 'none' | 'uncertain'): JournalRow =>
  row({ t: 'failed', gen, identity, attempt, category: 'timeout', retry, effects, error: 'timed out', evidence: {} });
const decision = (gen: number, identity: string, content: string, attempt: number, choice: 'accept-failed' | 'retry'): JournalRow =>
  row({ t: 'decision', gen, scope: { identity, content, attempt }, choice, by: 'tester' });

describe('identity（§5.2）', () => {
  it('位置身份与子 scope 的形态', () => {
    expect(positionIdentity('', 0)).toBe('#0');
    expect(parallelBranchScope('#1', 2)).toBe('#1/par:2');
    expect(positionIdentity('#1/par:2', 0)).toBe('#1/par:2#0');
    expect(pipelineStageScope('#3', 1, 0)).toBe('#3/pipe:1:0');
  });

  it('内容哈希对键顺序不敏感，对任一分量敏感', () => {
    const a = contentHash({ kind: 'agent', cli: 'codex', prompt: 'p', schema: { type: 'object', required: ['x'] } });
    const b = contentHash({ kind: 'agent', cli: 'codex', prompt: 'p', schema: { required: ['x'], type: 'object' } });
    expect(a).toBe(b);
    expect(contentHash({ kind: 'agent', cli: 'codex', prompt: 'p', model: 'm' })).not.toBe(contentHash({ kind: 'agent', cli: 'codex', prompt: 'p' }));
    expect(contentHash({ kind: 'signal', prompt: 'p' })).not.toBe(contentHash({ kind: 'agent', prompt: 'p' }));
    // 长度前缀：分量边界移动不能撞
    expect(contentHash({ kind: 'agent', cli: 'ab', prompt: 'c' })).not.toBe(contentHash({ kind: 'agent', cli: 'a', prompt: 'bc' }));
  });

  it('canonicalJson 丢 undefined、排序、非有限数为 null', () => {
    expect(canonicalJson({ b: 1, a: [undefined, 2], c: undefined })).toBe('{"a":[null,2],"b":1}');
    expect(canonicalJson({ x: Number.NaN })).toBe('{"x":null}');
  });

  it('outbox 文件名与 identity 目录名可作纯 basename', () => {
    const name = outboxFileName(2, 7, '#1/par:0#0');
    expect(name).toMatch(/^response-2-7-[0-9a-f]{12}\.md$/);
    expect(identityDirName('#1/par:0#0')).toMatch(/^1_par_0_0-[0-9a-f]{12}$/);
    expect(identityDirName('#0')).toMatch(/^0-[0-9a-f]{12}$/);
  });

  it('attempt 会话 id 是确定性的 v4 形状 UUID（claude-code --session-id 只收 UUID），四元组任一变化即不同', () => {
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const a = attemptSessionId('run-1', '#0/par:0#0', 1, 1);
    expect(a).toMatch(uuidV4);
    expect(attemptSessionId('run-1', '#0/par:0#0', 1, 1)).toBe(a);
    const others = [
      attemptSessionId('run-2', '#0/par:0#0', 1, 1),
      attemptSessionId('run-1', '#0/par:1#0', 1, 1),
      attemptSessionId('run-1', '#0/par:0#0', 2, 1),
      attemptSessionId('run-1', '#0/par:0#0', 1, 2),
    ];
    for (const o of others) expect(o).toMatch(uuidV4);
    expect(new Set([a, ...others]).size).toBe(5);
  });
});

describe('journal 追加（写即核对）', () => {
  it('持有者能追加；fsync 类行也落盘；被围栏者追加失败且文件不变', async () => {
    const runDir = makeRunDir();
    const { gen } = await acquireRun(runDir, {
      pid: process.pid,
      identity: selfIdentity(),
      persistedMaxGen: () => 0,
      onCommit: () => {},
      killProcess: terminateProcess,
    });
    const self = { pid: process.pid, identity: selfIdentity(), gen };
    await appendRow(runDir, self, started(gen));
    await appendRows(runDir, self, [attemptStarted(gen, '#0', 1, 'c0'), intent(gen, '#0', 1)]);
    const before = readFileSync(journalPath(runDir), 'utf8');
    expect(before.split('\n').filter(Boolean)).toHaveLength(3);
    await expect(appendRow(runDir, { ...self, gen: gen + 1 }, result(gen + 1, '#0', 1, 1))).rejects.toBeInstanceOf(FencedError);
    expect(readFileSync(journalPath(runDir), 'utf8')).toBe(before);
    const loaded = loadJournal(runDir);
    expect(loaded.integrity.dropped).toEqual([]);
    expect(loaded.projection.identities.get('#0')!.latest.intent?.turn).toBe(1);
  });

  it('超过 4KB 的行整体拒绝，什么都不写', async () => {
    const runDir = makeRunDir();
    const { gen } = await acquireRun(runDir, {
      pid: process.pid,
      identity: selfIdentity(),
      persistedMaxGen: () => 0,
      onCommit: () => {},
      killProcess: terminateProcess,
    });
    const self = { pid: process.pid, identity: selfIdentity(), gen };
    const big = row<JournalRow>({ t: 'note', gen, text: 'x'.repeat(5000) } as never);
    await expect(appendRows(runDir, self, [started(gen), big])).rejects.toBeInstanceOf(JournalRowTooLargeError);
    expect(readJournal(runDir).rows).toEqual([]);
  });

  it('读取容忍末尾半行与非行形状的 JSON', () => {
    const runDir = makeRunDir();
    writeFileSync(journalPath(runDir), `${JSON.stringify(started(1))}\n{"t":"note"}\n{"t":"note","gen":1,"ts":5,"text":"ok"}\n{"t":"resu`);
    const raw = readJournal(runDir);
    expect(raw.rows.map((r) => r.t)).toEqual(['run.started', 'note']);
    expect(raw.malformed.map((m) => m.line)).toEqual([2, 4]);
    expect(parseJournal('').rows).toEqual([]);
  });
});

describe('完整性校验（第一步）', () => {
  it('协议内写入不剔除任何行；代次不前进或不匹配的行被剔除并计数', () => {
    const rows = [
      started(1),
      attemptStarted(1, '#0', 1, 'c'),
      takeover(2),
      row({ t: 'note', gen: 1, text: 'stale writer' }) as JournalRow, // 旧写者绕过协议
      takeover(2), // 代次不前进
      row({ t: 'note', gen: 2, text: 'ok' }) as JournalRow,
      row({ t: 'note', gen: 3, text: 'future' }) as JournalRow, // 没有 takeover(3)
    ];
    const res = checkIntegrity(rows);
    expect(res.gen).toBe(2);
    expect(res.valid.map((r) => r.t)).toEqual(['run.started', 'started', 'run.takeover', 'note']);
    expect(res.dropped.map((d) => [d.index, d.reason])).toEqual([[3, 'gen_mismatch'], [4, 'gen_not_advancing'], [6, 'gen_mismatch']]);
    expect(journalMaxGen(rows)).toBe(2);
  });

  it('journal 为空时 gen 0，代次跳跃（lease 已写 takeover 未写）也被接受', () => {
    expect(checkIntegrity([]).gen).toBe(0);
    const res = checkIntegrity([started(1), takeover(3)]);
    expect(res.dropped).toEqual([]);
    expect(res.gen).toBe(3);
  });
});

describe('跨代次投影（第二步）与重放规则（§5.5）', () => {
  it('gen 2 继承 gen 1 的成功结果、失败记录与决策', () => {
    const c = 'content-A';
    const rows = [
      started(1),
      attemptStarted(1, '#0', 1, c),
      intent(1, '#0', 1),
      result(1, '#0', 1, { slogan: 'x' }),
      attemptStarted(1, '#1', 1, 'content-B'),
      intent(1, '#1', 1),
      failed(1, '#1', 1, 'manual', 'uncertain'),
      attemptStarted(1, '#2', 1, 'content-C'),
      failed(1, '#2', 1, 'auto', 'none'),
      takeover(2),
      decision(2, '#1', 'content-B', 1, 'accept-failed'),
      attemptStarted(2, '#2', 2, 'content-C'),
      result(2, '#2', 2, 'second try'),
    ];
    const p = project(checkIntegrity(rows).valid);
    expect(p.gen).toBe(2);
    expect(p.counts).toEqual({ started: 3, ok: 2, failed: 1, inflight: 0 });
    expect(p.settled).toBe(true);
    expect(p.health).toBe('degraded');

    expect(decideReplay(p, '#0', c)).toMatchObject({ action: 'cached', outcome: { ok: true, value: { slogan: 'x' }, attempt: 1 } });
    expect(decideReplay(p, '#1', 'content-B')).toMatchObject({ action: 'accept_failed', outcome: { ok: false, effects: 'uncertain', attempt: 1 } });
    expect(decideReplay(p, '#2', 'content-C')).toMatchObject({ action: 'cached', outcome: { value: 'second try', attempt: 2 } });
    expect(decideReplay(p, '#3', 'new')).toEqual({ action: 'run', attempt: 1, reason: 'new', divergence: null });
    expect(decideReplay(p, '#0', 'changed')).toMatchObject({ action: 'run', attempt: 2, reason: 'divergence', divergence: { expected: c, actual: 'changed' } });
  });

  it('失败的四种处置：auto/none 自动重跑；manual 待决策；决策 retry 重跑一次且新 attempt 不继承', () => {
    const rows = [
      started(1),
      attemptStarted(1, '#0', 1, 'a'),
      failed(1, '#0', 1, 'auto', 'none'),
      attemptStarted(1, '#1', 1, 'b'),
      failed(1, '#1', 1, 'manual', 'none'),
      attemptStarted(1, '#2', 1, 'c'),
      intent(1, '#2', 1),
      failed(1, '#2', 1, 'auto', 'uncertain'),
    ];
    let p = project(checkIntegrity(rows).valid);
    expect(decideReplay(p, '#0', 'a')).toMatchObject({ action: 'run', attempt: 2, reason: 'auto_retry' });
    expect(decideReplay(p, '#1', 'b')).toMatchObject({ action: 'pending', reason: 'failed_manual', attempt: 1 });
    // effects:uncertain 即使 retry:auto 也不自动重跑
    expect(decideReplay(p, '#2', 'c')).toMatchObject({ action: 'pending', reason: 'uncertain', attempt: 1 });

    rows.push(takeover(2), decision(2, '#2', 'c', 1, 'retry'), attemptStarted(2, '#2', 2, 'c'), intent(2, '#2', 2), failed(2, '#2', 2, 'manual', 'uncertain'));
    p = project(checkIntegrity(rows).valid);
    // 决策只对 attempt 1 生效；attempt 2 的失败重新待决策
    expect(decideReplay(p, '#2', 'c')).toMatchObject({ action: 'pending', reason: 'uncertain', attempt: 2 });
    rows.push(decision(2, '#2', 'c', 1, 'accept-failed'));
    p = project(checkIntegrity(rows).valid);
    expect(decideReplay(p, '#2', 'c')).toMatchObject({ action: 'pending', attempt: 2 });
  });

  it('在途 attempt：无 send.intent 自动重跑；有 send.intent 合成 interrupted/uncertain 待决策', () => {
    const rows = [
      started(1),
      attemptStarted(1, '#0', 1, 'a'),
      row({ t: 'attempt.state', gen: 1, identity: '#0', attempt: 1, container: 'c-1-0', state: 'ready', pid: 42, pidIdentity: 'x' }) as JournalRow,
      attemptStarted(1, '#1', 1, 'b'),
      intent(1, '#1', 1),
      row({ t: 'send.confirmed', gen: 1, identity: '#1', attempt: 1 }) as JournalRow,
    ];
    const p = project(checkIntegrity(rows).valid);
    expect(p.settled).toBe(false);
    expect(p.counts.inflight).toBe(2);
    expect(p.identities.get('#0')!.latest).toMatchObject({ phase: 'ready', pid: 42, intent: null, state: 'inflight' });
    expect(decideReplay(p, '#0', 'a')).toMatchObject({ action: 'run', attempt: 2, reason: 'inflight_no_intent' });
    const pending = decideReplay(p, '#1', 'b');
    expect(pending).toMatchObject({ action: 'pending', reason: 'uncertain', attempt: 1, outcome: { category: 'interrupted', retry: 'manual', effects: 'uncertain' } });
    expect(interruptedOutcome(p.identities.get('#0')!.latest, 'x')).toMatchObject({ retry: 'auto', effects: 'none' });
    expect(interruptedOutcome(p.identities.get('#1')!.latest, 'x')).toMatchObject({ retry: 'manual', effects: 'uncertain', evidence: { confirmed: true } });
  });

  it('健康度与终态行：全失败 all_failed；interrupted 与 finished 以当前代次最后一条为准', () => {
    const rows = [started(1), attemptStarted(1, '#0', 1, 'a'), failed(1, '#0', 1, 'manual', 'none')];
    let p = project(checkIntegrity(rows).valid);
    expect(p.health).toBe('all_failed');
    rows.push(row({ t: 'run.interrupted', gen: 1, reason: 'daemon_disconnect', inflight: [] }) as JournalRow);
    p = project(checkIntegrity(rows).valid);
    expect(p.terminal).toBe('interrupted');
    rows.push(takeover(2));
    p = project(checkIntegrity(rows).valid);
    expect(p.terminal).toBeNull();
    rows.push(row({ t: 'run.finished', gen: 2, status: 'failed', health: 'all_failed', counts: { started: 1, ok: 0, failed: 1 }, returned: null, replay: 'none' }) as JournalRow);
    p = project(checkIntegrity(rows).valid);
    expect(p.terminal).toBe('finished');
    expect(p.finished!.status).toBe('failed');
  });

  it('activity、note 计数、容器、逃逸、决策 run 级都进投影', () => {
    const rows = [
      started(1),
      row({ t: 'container.created', gen: 1, container: 'c-1-0', kind: 'cgroup1-freezer', path: '/sys/fs/cgroup/freezer/x' }) as JournalRow,
      row({ t: 'activity', gen: 1, activeMs: 100, cpuMs: 5 }) as JournalRow,
      row({ t: 'note', gen: 1, text: 'a' }) as JournalRow,
      row({ t: 'note', gen: 1, text: 'b' }) as JournalRow,
      row({ t: 'escape', gen: 1, container: 'c-1-0', pids: [7] }) as JournalRow,
      row({ t: 'decision', gen: 1, scope: { run: true }, choice: 'accept-journal', by: 'me' }) as JournalRow,
      row({ t: 'activity', gen: 1, activeMs: 200, cpuMs: 9 }) as JournalRow,
    ];
    const p = project(checkIntegrity(rows).valid);
    expect(p.activity).toMatchObject({ activeMs: 200, cpuMs: 9 });
    expect(p.notes).toBe(2);
    expect(p.containers.get('c-1-0')!.kind).toBe('cgroup1-freezer');
    expect(p.escapes[0]!.pids).toEqual([7]);
    expect(p.runDecisions[0]!.choice).toBe('accept-journal');
  });
});
