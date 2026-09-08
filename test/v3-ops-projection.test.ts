import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendEvent } from '../src/workflows/v3/journal.js';
import {
  projectRun,
  projectRunById,
  listRuns,
  isValidRunId,
  liveV3TerminalPortForSession,
  ptyLogPathFor,
} from '../src/workflows/v3/ops-projection.js';

/** Build a run dir with a dag.json + a journal, return its path. */
function buildRun(runsDir: string, runId: string, opts: { reportRunning?: boolean } = {}): string {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'dag.json'), JSON.stringify({
    runId,
    nodes: [
      { id: 'research', type: 'goal', goal: '调研 X/Y/Z', depends: [], inputs: [] },
      { id: 'report', type: 'goal', goal: '写报告', depends: ['research'], inputs: [{ from: 'research' }] },
    ],
  }));
  const jp = join(runDir, 'journal.ndjson');
  appendEvent(jp, { type: 'runStarted', runId });
  // research: dispatched → session ready → succeeded (terminal → webTerminal closed)
  appendEvent(jp, { type: 'nodeDispatched', nodeId: 'research', attemptId: 'research/attempts/001' });
  appendEvent(jp, {
    type: 'nodeSessionReady', nodeId: 'research', attemptId: 'research/attempts/001',
    sessionInfo: { sessionId: 'sess-r', webPort: 5101, viewToken: 'view-r' },
    ptyLogPath: join(runDir, 'research/attempts/001/pty.log'),
  });
  appendEvent(jp, { type: 'nodeSucceeded', nodeId: 'research', attemptId: 'research/attempts/001', manifestPath: join(runDir, 'research/attempts/001/manifest.json') });
  // report: dispatched → session ready, still running (live)
  if (opts.reportRunning) {
    appendEvent(jp, { type: 'nodeDispatched', nodeId: 'report', attemptId: 'report/attempts/001' });
    appendEvent(jp, {
      type: 'nodeSessionReady', nodeId: 'report', attemptId: 'report/attempts/001',
      sessionInfo: { sessionId: 'sess-p', webPort: 5102, viewToken: 'view-p' },
      ptyLogPath: join(runDir, 'report/attempts/001/pty.log'),
    });
  }
  return runDir;
}

describe('v3 ops-projection — projectRun', () => {
  it('从 journal+dag 投影出节点状态 + 边 + 终端信息', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-proj-'));
    try {
      const runDir = buildRun(base, 'deepsea-260602-0907', { reportRunning: true });
      const view = projectRun('deepsea-260602-0907', runDir);

      expect(view.runStatus).toBe('running');
      expect(view.nodes).toHaveLength(2);

      const research = view.nodes.find((n) => n.id === 'research')!;
      expect(research.status).toBe('done');
      expect(research.depends).toEqual([]);
      expect(research.goal).toBe('调研 X/Y/Z');
      // 节点成功 → hasManifest=true，但绝不暴露绝对 manifestPath（同 hasPtyLog 口径）
      expect(research.hasManifest).toBe(true);
      expect((research as Record<string, unknown>).manifestPath).toBeUndefined();
      // 终态后 webTerminal 应为 closed（回放走 pty-log endpoint）
      expect(research.webTerminal!.status).toBe('closed');
      expect(research.webTerminal!.webPort).toBe(5101);
      expect(research.hasPtyLog).toBe(true);
      // 安全：read-only DTO 不暴露 token，也不直出绝对 ptyLogPath
      expect((research.webTerminal as Record<string, unknown>).token).toBeUndefined();
      expect((research.webTerminal as Record<string, unknown>).viewToken).toBeUndefined();
      expect((research as Record<string, unknown>).ptyLogPath).toBeUndefined();
      // 安全铁律：整个 RunView 序列化后不得含 runDir 绝对路径（codex review）
      expect(JSON.stringify(view)).not.toContain(runDir);

      const report = view.nodes.find((n) => n.id === 'report')!;
      expect(report.status).toBe('running');
      expect(report.depends).toEqual(['research']); // 边来自 dag
      // 运行中 → live
      expect(report.webTerminal!.status).toBe('live');
      expect(report.webTerminal!.webPort).toBe(5102);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('未 dispatch 的节点 status=pending、无 webTerminal', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-proj-'));
    try {
      const runDir = buildRun(base, 'r-260602-0001', { reportRunning: false });
      const view = projectRun('r-260602-0001', runDir);
      const report = view.nodes.find((n) => n.id === 'report')!;
      expect(report.status).toBe('pending');
      expect(report.webTerminal).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('dag.json 缺失时不抛、退化成 journal 见过的节点', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-proj-'));
    try {
      const runDir = join(base, 'nodag-260602-0001');
      mkdirSync(runDir, { recursive: true });
      const jp = join(runDir, 'journal.ndjson');
      appendEvent(jp, { type: 'runStarted', runId: 'nodag-260602-0001' });
      appendEvent(jp, { type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' });
      const view = projectRun('nodag-260602-0001', runDir);
      expect(view.nodes.find((n) => n.id === 'a')!.status).toBe('running');
      expect(view.nodes.find((n) => n.id === 'a')!.depends).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('v3 ops-projection — projectRunById 安全 + listRuns', () => {
  it('合法 runId → 投影；非法/穿越 → undefined', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-proj-'));
    try {
      buildRun(base, 'ok-260602-0907');
      expect(projectRunById(base, 'ok-260602-0907')!.runId).toBe('ok-260602-0907');
      expect(projectRunById(base, '../etc')).toBeUndefined();
      expect(projectRunById(base, 'has/slash')).toBeUndefined();
      expect(projectRunById(base, 'missing-260602-0000')).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('isValidRunId：接受 <slug>-<yymmdd-hhmm>，拒穿越/空', () => {
    expect(isValidRunId('run-260602-0907')).toBe(true);
    expect(isValidRunId('deepsea-001')).toBe(true);
    expect(isValidRunId('../x')).toBe(false);
    expect(isValidRunId('a/b')).toBe(false);
    expect(isValidRunId('')).toBe(false);
  });

  it('listRuns 列出带 journal 的 run，名字倒序', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-proj-'));
    try {
      buildRun(base, 'a-260602-0800');
      buildRun(base, 'b-260602-0900');
      mkdirSync(join(base, 'no-journal-260602-0000'), { recursive: true }); // 无 journal，应忽略
      const runs = listRuns(base);
      expect(runs.map((r) => r.runId)).toEqual(['b-260602-0900', 'a-260602-0800']);
      expect(runs[0].nodeCount).toBe(2);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('v3 live terminal resolver', () => {
  it('只解析当前运行 attempt，并在节点终态后立即撤销中央 /s 路由', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-terminal-resolver-'));
    try {
      const runDir = buildRun(base, 'route-260602-0907', { reportRunning: true });
      expect(liveV3TerminalPortForSession(base, 'sess-p')).toBe(5102);
      expect(liveV3TerminalPortForSession(base, 'sess-r')).toBeUndefined();
      expect(liveV3TerminalPortForSession(base, 'missing')).toBeUndefined();

      appendEvent(join(runDir, 'journal.ndjson'), {
        type: 'nodeSucceeded',
        nodeId: 'report',
        attemptId: 'report/attempts/001',
        manifestPath: join(runDir, 'report/attempts/001/manifest.json'),
      });
      expect(liveV3TerminalPortForSession(base, 'sess-p')).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('忽略重试期间旧 attempt 迟到的 ready，只接通新 attempt', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-terminal-resolver-'));
    try {
      const runId = 'retry-260602-0908';
      const runDir = join(base, runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'dag.json'), JSON.stringify({
        runId,
        nodes: [{ id: 'research', type: 'goal', goal: 'research', depends: [], inputs: [] }],
      }));
      const journal = join(runDir, 'journal.ndjson');
      appendEvent(journal, { type: 'runStarted', runId });
      appendEvent(journal, { type: 'nodeDispatched', nodeId: 'research', attemptId: '001' });
      appendEvent(journal, {
        type: 'nodeSessionReady', nodeId: 'research', attemptId: '001',
        sessionInfo: { sessionId: 'sess-old', webPort: 5201, viewToken: 'view-old' },
      });
      appendEvent(journal, {
        type: 'nodeBlocked', nodeId: 'research', attemptId: '001', errorClass: 'workerError',
      });
      appendEvent(journal, { type: 'runBlocked', blockedNodeId: 'research' });
      appendEvent(journal, {
        type: 'nodeRetryRequested', nodeId: 'research', previousAttemptId: '001',
        nextAttemptId: '002', reason: 'blockedRetry',
      });
      appendEvent(journal, { type: 'nodeDispatched', nodeId: 'research', attemptId: '002' });
      appendEvent(journal, {
        type: 'nodeSessionReady', nodeId: 'research', attemptId: '001',
        sessionInfo: { sessionId: 'sess-stale', webPort: 5202, viewToken: 'view-stale' },
      });

      expect(liveV3TerminalPortForSession(base, 'sess-old')).toBeUndefined();
      expect(liveV3TerminalPortForSession(base, 'sess-stale')).toBeUndefined();

      appendEvent(journal, {
        type: 'nodeSessionReady', nodeId: 'research', attemptId: '002',
        sessionInfo: { sessionId: 'sess-current', webPort: 5203, viewToken: 'view-current' },
      });
      expect(liveV3TerminalPortForSession(base, 'sess-current')).toBe(5203);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('dashboard 的中央终端代理同时查询普通会话和 v3 临时会话', () => {
    const dashboardSource = readFileSync(join(process.cwd(), 'src/dashboard.ts'), 'utf8');
    expect(dashboardSource).toContain(
      'aggregator.terminalProxyPortOf(sessionId) ?? liveV3TerminalPortForSession(v3RunsDir(), sessionId)',
    );
  });
});

describe('v3 ops-projection — ptyLogPathFor（服务端定位，不直出前端）', () => {
  it('真有 pty.log 时返回校验后的绝对路径；无/非法/穿越 → undefined', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-proj-'));
    try {
      const runDir = buildRun(base, 'pty-260602-0907');
      // 真写出 research 的 pty.log
      const ptyDir = join(runDir, 'research/attempts/001');
      mkdirSync(ptyDir, { recursive: true });
      writeFileSync(join(ptyDir, 'pty.log'), 'raw pty bytes\n');

      expect(ptyLogPathFor(base, 'pty-260602-0907', 'research')).toBe(join(ptyDir, 'pty.log'));
      // report 没 session → undefined
      expect(ptyLogPathFor(base, 'pty-260602-0907', 'report')).toBeUndefined();
      // 非法/穿越 runId
      expect(ptyLogPathFor(base, '../etc', 'research')).toBeUndefined();
      // 文件还没写出来的 run（事件里有路径但文件不存在）→ undefined
      const runDir2 = buildRun(base, 'nofile-260602-0001');
      expect(runDir2).toContain('nofile');
      expect(ptyLogPathFor(base, 'nofile-260602-0001', 'research')).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('read-only projection tolerates a corrupt journal (hardening #11 carve-out)', () => {
  it('projectRun/projectRunById/listRuns degrade instead of throwing on mid-file corruption', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-ops-corrupt-'));
    try {
      const runDir = buildRun(base, 'corrupt-260602-0001');
      // Inject a corrupt line that is NOT the last line (a torn FINAL line is
      // tolerated by readJournal; a mid-file one makes it fail-loud). Then append
      // a valid event after it so the corrupt line sits in the middle.
      const jp = join(runDir, 'journal.ndjson');
      appendFileSync(jp, '{ this is not json\n');
      appendEvent(jp, { type: 'runSucceeded', runId: 'corrupt-260602-0001' });

      // Read-only dashboard paths must NOT throw — they degrade to a sparse view
      // so one corrupt run can't 500 the whole list or its own detail page.
      expect(() => projectRun('corrupt-260602-0001', runDir)).not.toThrow();
      expect(() => projectRunById(base, 'corrupt-260602-0001')).not.toThrow();
      expect(() => listRuns(base)).not.toThrow();

      const view = projectRunById(base, 'corrupt-260602-0001');
      expect(view?.runId).toBe('corrupt-260602-0001');
      // A second, healthy run still shows up in the list alongside the bad one.
      buildRun(base, 'healthy-260602-0002');
      const ids = listRuns(base).map((r) => r.runId);
      expect(ids).toContain('healthy-260602-0002');
      expect(ids).toContain('corrupt-260602-0001');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
