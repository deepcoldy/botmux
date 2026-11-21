/**
 * Unit tests for the /adopt picker's live-name enrichment
 * (services/adopt-live-enrich): herdr workspace / tab names, default tab-name
 * detection, the Claude first-prompt head read, the time budget, and how each
 * partial failure renders on the picker card.
 *
 * Never touches the host: herdr queries go through an injected runner (or a
 * throwaway fake `herdr` script), transcripts live in a temp Claude data dir.
 *
 * Run:  bunx vitest run --project unit test/adopt-live-enrich.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  enrichAdoptLiveSessions,
  readClaudeFirstPrompt,
  runHerdrCli,
  type HerdrRunner,
} from '../src/services/adopt-live-enrich.js';
import { buildAdoptSelectCard } from '../src/im/lark/card-builder.js';
import type { AdoptableSession } from '../src/core/session-discovery.js';
import type { OrcaAdoptableSession } from '../src/core/orca-adopt-discovery.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** A live Claude entry in herdr session `default`, workspace w1, tab w1:t1. */
const live = (extra: Partial<AdoptableSession> = {}): AdoptableSession => ({
  source: 'herdr',
  herdrSessionName: 'default',
  herdrTarget: 'w1:p1',
  herdrPaneId: 'w1:p1',
  herdrWorkspaceId: 'w1',
  herdrTabId: 'w1:t1',
  cliId: 'claude-code',
  sessionId: SID,
  cwd: '/work/demo',
  paneCols: 200,
  paneRows: 50,
  ...extra,
});

const workspaceList = (...workspaces: object[]) =>
  JSON.stringify({ id: 'cli:workspace:list', result: { type: 'workspace_list', workspaces } });
const tabList = (...tabs: object[]) =>
  JSON.stringify({ id: 'cli:tab:list', result: { type: 'tab_list', tabs } });

/** Fake herdr. Replies are keyed by `<session> <workspace|tab>`; 'hang' never
 *  answers, a missing key fails. Records every call and the signal it got. */
function fakeHerdr(replies: Record<string, string>) {
  const calls: string[][] = [];
  const signals: AbortSignal[] = [];
  const run: HerdrRunner = (args, { signal }) => {
    calls.push(args);
    signals.push(signal);
    const reply = replies[`${args[1]} ${args[2]}`];
    if (reply === 'hang') return new Promise<string | undefined>(() => {});
    return Promise.resolve(reply);
  };
  return { run, calls, signals };
}

const noFirstPrompt = async () => undefined;

/** Track a promise's settlement for fake-timer assertions. */
function settle<T>(p: Promise<T>) {
  const state: { done: boolean; value?: T } = { done: false };
  void p.then((value) => { state.done = true; state.value = value; });
  return state;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Poll (real timers) until `cond` holds or `ms` pass. */
async function waitUntil(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
}

/** A promise the test releases by hand. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

/** Markdown lines of each session card in a rendered picker. */
function cardLines(sessions: AdoptableSession[], locale: 'zh' | 'en' = 'en'): string[][] {
  const card = JSON.parse(buildAdoptSelectCard(sessions, 'om_root', locale));
  return (card.body?.elements ?? [])
    .filter((e: any) => e.tag === 'interactive_container')
    .map((e: any) => (e.elements ?? []).map((x: any) => x.content ?? '').join('\n').split('\n'));
}

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'adopt-live-enrich-'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

const userRecord = (content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', message: { role: 'user', content }, ...extra });

/** Write `<dataDir>/projects/<dir>/<sid>.jsonl`. */
function writeTranscript(records: unknown[] | string, opts: { dir?: string; sid?: string } = {}): string {
  const projectDir = join(dataDir, 'projects', opts.dir ?? '-work-demo');
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, `${opts.sid ?? SID}.jsonl`);
  writeFileSync(path, typeof records === 'string' ? records : `${records.map(r => JSON.stringify(r)).join('\n')}\n`);
  return path;
}

const readPrompt = (sid = SID, cwd = '/work/demo') =>
  readClaudeFirstPrompt(sid, cwd, new AbortController().signal, dataDir);

// ─── Names from herdr ──────────────────────────────────────────────────────

describe('enrichAdoptLiveSessions: workspace / tab names', () => {
  it('lists workspaces and tabs once per herdr session, all at once, and never mutates its input', async () => {
    const replies: Record<string, string> = {
      'default workspace': workspaceList({ workspace_id: 'w1', label: '示例空间', number: 1 }),
      'default tab': tabList(
        { tab_id: 'w1:t1', workspace_id: 'w1', label: '整理笔记', number: 1 },
        { tab_id: 'w1:t2', workspace_id: 'w1', label: '2', number: 5 },
      ),
      'side workspace': workspaceList({ workspace_id: 'w1', label: 'demo-space', number: 1 }),
      'side tab': tabList({ tab_id: 'w1:t1', workspace_id: 'w1', label: '1', number: 3 }),
    };
    const calls: string[][] = [];
    const answers: Array<() => void> = [];
    const runHerdr: HerdrRunner = args => new Promise((resolve) => {
      calls.push(args);
      answers.push(() => resolve(replies[`${args[1]} ${args[2]}`]));
    });
    const tmux: AdoptableSession = {
      source: 'tmux', tmuxTarget: '0:1.0', cliPid: 1, cliId: 'claude-code', cwd: '/work/a', paneCols: 80, paneRows: 24,
    };
    const input = [
      live({ herdrPaneLabel: 'demo-task', title: 'demo-task' }),
      live({ herdrPaneId: 'w1:p2', herdrTabId: 'w1:t2', herdrPaneLabel: '修复登录页样式', title: '修复登录页样式' }),
      live({ herdrSessionName: 'side', herdrPaneLabel: '整理示例数据', title: '整理示例数据' }),
      tmux,
    ];
    const before = structuredClone(input);

    const pending = enrichAdoptLiveSessions(input, { runHerdr, readFirstPrompt: noFirstPrompt });
    // Every query is already in flight before any of them answers.
    expect(calls).toHaveLength(4);
    answers.forEach(answer => answer());
    const out = await pending;

    expect(calls.map(a => a.join(' ')).sort()).toEqual([
      '--session default tab list',
      '--session default workspace list',
      '--session side tab list',
      '--session side workspace list',
    ]);
    expect(input).toEqual(before);
    expect(out[0]).not.toBe(input[0]);
    expect(out[3]).toBe(tmux);
    expect(out[0]).toMatchObject({ herdrWorkspaceLabel: '示例空间', herdrTabLabel: '整理笔记', herdrTabAutoNamed: false });
    expect(out[1]).toMatchObject({ herdrWorkspaceLabel: '示例空间', herdrTabLabel: '2', herdrTabAutoNamed: true });
    expect(out[2]).toMatchObject({ herdrWorkspaceLabel: 'demo-space', herdrTabLabel: '1', herdrTabAutoNamed: true });
  });

  it('decides a default tab name by its position in the workspace, never by `number`', async () => {
    const tabs = ['w1:tH', 'w1:t3', 'w2:t1', 'w2:t2'];
    const herdr = fakeHerdr({
      'default tab': tabList(
        { tab_id: 'w1:tH', workspace_id: 'w1', label: '1', number: 17 },
        { tab_id: 'w1:t3', workspace_id: 'w1', label: '3', number: 3 },  // numeric but not its position → a given name
        { tab_id: 'w2:t1', workspace_id: 'w2', label: '1', number: 1 },
        { tab_id: 'w2:t2', workspace_id: 'w2', label: '7', number: 2 },
      ),
    });
    const out = await enrichAdoptLiveSessions(
      tabs.map((tabId, i) => live({ herdrPaneId: `w1:p${i}`, herdrTabId: tabId, herdrWorkspaceId: undefined, herdrPaneLabel: 'demo-task' })),
      { runHerdr: herdr.run, readFirstPrompt: noFirstPrompt },
    );
    expect(out.map(s => (s as AdoptableSession).herdrTabAutoNamed)).toEqual([true, false, true, false]);
    // No workspace ids → no workspace query.
    expect(herdr.calls.map(a => a.join(' '))).toEqual(['--session default tab list']);
  });

  it('returns Orca entries untouched and in place, and never queries herdr for them', async () => {
    const orca: OrcaAdoptableSession = {
      source: 'orca',
      orcaInstance: 'server',
      orcaTerminalHandle: 'term_demo',
      orcaWorktreeId: 'repo::/work',
      orcaAgentIdentity: 'claude',
      orcaTerminalTitle: '整理示例数据',
      cliId: 'claude-code',
      sessionId: 'sid-orca',
      cwd: '/work/demo',
      paneCols: 100,
      paneRows: 40,
      paneSizeVerified: true,
    };
    const onlyOrca = fakeHerdr({});
    const alone = [orca];
    expect(await enrichAdoptLiveSessions(alone, { runHerdr: onlyOrca.run })).toBe(alone);
    expect(onlyOrca.calls).toEqual([]);

    const herdr = fakeHerdr({
      'default workspace': workspaceList({ workspace_id: 'w1', label: '示例空间' }),
      'default tab': tabList({ tab_id: 'w1:t1', workspace_id: 'w1', label: '整理笔记' }),
    });
    const readFirstPrompt = vi.fn(noFirstPrompt);
    const before = structuredClone(orca);
    const out = await enrichAdoptLiveSessions([live(), orca, live({ herdrPaneId: 'w1:p2' })], { runHerdr: herdr.run, readFirstPrompt });
    expect(out[1]).toBe(orca);
    expect(orca).toEqual(before);
    expect(out[0]).toMatchObject({ herdrWorkspaceLabel: '示例空间', herdrTabLabel: '整理笔记' });
    expect(out[2]).toMatchObject({ herdrPaneId: 'w1:p2', herdrTabLabel: '整理笔记' });
    expect(herdr.calls.map(a => a.join(' ')).sort()).toEqual([
      '--session default tab list',
      '--session default workspace list',
    ]);
    // Both herdr entries share the tab, so their first prompts are wanted; the Orca session's never is.
    expect(readFirstPrompt.mock.calls.map(c => c[0])).toEqual([SID, SID]);
  });

  it('queries nothing for entries without workspace / tab ids (older herdr) or with too little time left', async () => {
    const herdr = fakeHerdr({});
    const old = [live({ herdrWorkspaceId: undefined, herdrTabId: undefined })];
    expect(await enrichAdoptLiveSessions(old, { runHerdr: herdr.run })).toBe(old);
    const fresh = [live()];
    expect(await enrichAdoptLiveSessions(fresh, { runHerdr: herdr.run, deadlineMs: Date.now() + 99 })).toBe(fresh);
    expect(herdr.calls).toEqual([]);
  });
});

// ─── Which entries get a first prompt ──────────────────────────────────────

describe('enrichAdoptLiveSessions: first prompts', () => {
  it('reads a first prompt only where it could become the title', async () => {
    const herdr = fakeHerdr({
      'default tab': tabList(
        { tab_id: 'w1:t1', workspace_id: 'w1', label: '1' },
        { tab_id: 'w1:t2', workspace_id: 'w1', label: '整理笔记' },
        { tab_id: 'w1:t3', workspace_id: 'w1', label: '3' },
        { tab_id: 'w1:t4', workspace_id: 'w1', label: '4' },
        { tab_id: 'w1:t5', workspace_id: 'w1', label: '5' },
        { tab_id: 'w1:t6', workspace_id: 'w1', label: '示例分组' },
        { tab_id: 'w1:t7', workspace_id: 'w1', label: '7' },
      ),
    });
    const readFirstPrompt = vi.fn(async (sessionId: string) => `第一句 ${sessionId}\n<b>`);
    const entry = (n: string, tabId: string | undefined, extra: Partial<AdoptableSession> = {}) =>
      live({ herdrPaneId: `w1:p${n}`, herdrTabId: tabId, herdrWorkspaceId: undefined, sessionId: `sid-${n}`, ...extra });
    const out = await enrichAdoptLiveSessions([
      entry('a', 'w1:t1'),                                         // alone, default tab name → read
      entry('b', 'w1:t2'),                                         // alone, given tab name wins → skip
      entry('c', 'w1:t3', { herdrPaneLabel: 'demo-task' }),        // pane label wins → skip
      entry('d', 'w1:t4', { herdrNativeTitle: '示例标题' }),        // native title wins → skip
      entry('e', 'w1:t5', { cliId: 'codex' }),                     // not Claude → skip
      entry('f', 'w1:t6'),                                         // shared tab, no label → read
      entry('g', 'w1:t6'),                                         // shared tab, no label → read
      entry('h', 'w1:t6', { herdrPaneLabel: 'demo-task' }),        // shared tab, pane label → skip
      entry('i', 'w1:t7', { sessionId: undefined }),               // no session id → skip
      entry('j', 'w1:t9'),                                         // tab not found → skip
      entry('k', undefined),                                       // no tab id → skip
    ], { runHerdr: herdr.run, readFirstPrompt });

    expect(readFirstPrompt.mock.calls.map(c => c[0]).sort()).toEqual(['sid-a', 'sid-f', 'sid-g']);
    expect(readFirstPrompt.mock.calls[0]![1]).toBe('/work/demo');
    // Cleaned like every live name: one line, no angle brackets.
    expect(out[0]).toMatchObject({ herdrFirstPrompt: '第一句 sid-a b' });
    expect(out.filter(s => 'herdrFirstPrompt' in s).map(s => s.sessionId)).toEqual(['sid-a', 'sid-f', 'sid-g']);
  });

  it('reads at most four transcripts at a time', async () => {
    const herdr = fakeHerdr({ 'default tab': tabList({ tab_id: 'w1:t1', workspace_id: 'w1', label: '整理笔记' }) });
    let inFlight = 0;
    let peak = 0;
    const readFirstPrompt = async (sessionId: string) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, 10));
      inFlight--;
      return `第一句 ${sessionId}`;
    };
    const sessions = Array.from({ length: 9 }, (_, i) => live({ herdrPaneId: `w1:p${i}`, sessionId: `sid-${i}`, herdrWorkspaceId: undefined }));
    const out = await enrichAdoptLiveSessions(sessions, { runHerdr: herdr.run, readFirstPrompt });
    expect(peak).toBe(4);
    expect(out.every(s => (s as AdoptableSession).herdrFirstPrompt === `第一句 ${s.sessionId}`)).toBe(true);
  });
});

// ─── Transcript head read ──────────────────────────────────────────────────

describe('readClaudeFirstPrompt', () => {
  it('applies the history rule: skips sidechain, isMeta, slash-command and tool-result turns', async () => {
    writeTranscript([
      { type: 'summary', summary: 'x' },
      userRecord('侧链里的提问', { isSidechain: true }),
      userRecord('skill body expansion', { isMeta: true }),
      userRecord('<command-name>/clear</command-name>'),
      userRecord('<local-command-stdout></local-command-stdout>'),
      userRecord([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } },
      userRecord([{ type: 'text', text: '  修复登录页样式  ' }]),
      userRecord('第二句'),
    ]);
    expect(await readPrompt()).toBe('修复登录页样式');
  });

  it('finds nothing for a session that has not been prompted yet (no transcript)', async () => {
    expect(await readPrompt()).toBeUndefined();
  });

  it('treats a botmux envelope first as no first prompt', async () => {
    writeTranscript([userRecord('<user_message>你好</user_message>'), userRecord('修复登录页样式')]);
    expect(await readPrompt()).toBeUndefined();
  });

  it('falls back to any projects/<dir>/<id>.jsonl when the cwd slug does not match', async () => {
    writeTranscript([userRecord('整理示例数据')], { dir: 'some-other-project' });
    expect(await readPrompt()).toBe('整理示例数据');
  });

  it('stops at the 1 MiB cap on an oversized first line and closes the file', async () => {
    writeTranscript(`${JSON.stringify(userRecord('x'.repeat(1536 * 1024)))}\n${JSON.stringify(userRecord('修复登录页样式'))}\n`);
    const realOpen = fsPromises.open.bind(fsPromises);
    const opened: Array<{ bytes: number; closed: boolean }> = [];
    vi.spyOn(fsPromises, 'open').mockImplementation((async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await realOpen(...args);
      const seen = { bytes: 0, closed: false };
      opened.push(seen);
      const read = handle.read.bind(handle) as (...a: any[]) => Promise<{ bytesRead: number }>;
      const close = handle.close.bind(handle);
      (handle as any).read = async (...a: any[]) => {
        const result = await read(...a);
        seen.bytes += result.bytesRead;
        return result;
      };
      (handle as any).close = async () => {
        seen.closed = true;
        return close();
      };
      return handle;
    }) as typeof fsPromises.open);

    expect(await readPrompt()).toBeUndefined();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.bytes).toBe(1024 * 1024);
    expect(opened[0]!.closed).toBe(true);
  });

  it('gives up after 5000 lines', async () => {
    const filler = Array.from({ length: 5000 }, () => ({ type: 'assistant', message: { role: 'assistant', content: 'x' } }));
    writeTranscript([...filler, userRecord('修复登录页样式')]);
    expect(await readPrompt()).toBeUndefined();
    writeTranscript([...filler.slice(1), userRecord('修复登录页样式')], { sid: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed' });
    expect(await readPrompt('1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed')).toBe('修复登录页样式');
  });

  it('caches a found first prompt by transcript path, but not a miss', async () => {
    writeTranscript([userRecord('修复登录页样式')]);
    expect(await readPrompt()).toBe('修复登录页样式');
    writeTranscript([userRecord('整理示例数据')]);
    expect(await readPrompt()).toBe('修复登录页样式');

    const other = '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b';
    writeTranscript([userRecord('<command-name>/clear</command-name>')], { sid: other });
    expect(await readPrompt(other)).toBeUndefined();
    writeTranscript([userRecord('<command-name>/clear</command-name>'), userRecord('整理示例数据')], { sid: other });
    expect(await readPrompt(other)).toBe('整理示例数据');
  });

  it('never turns a non-id session value into a path, and does nothing once aborted', async () => {
    writeTranscript([userRecord('修复登录页样式')], { sid: 'x' });
    expect(await readPrompt('../-work-demo/x')).toBeUndefined();
    const aborted = new AbortController();
    aborted.abort();
    expect(await readClaudeFirstPrompt('x', '/work/demo', aborted.signal, dataDir)).toBeUndefined();
  });
});

// ─── Time budget ───────────────────────────────────────────────────────────

describe('enrichAdoptLiveSessions: time budget', () => {
  it('gives up after 800 ms when herdr hangs: every query aborted, entries left as discovered', async () => {
    vi.useFakeTimers();
    const herdr = fakeHerdr({
      'default workspace': 'hang', 'default tab': 'hang', 'side workspace': 'hang', 'side tab': 'hang',
    });
    const input = [live(), live({ herdrSessionName: 'side' })];
    const state = settle(enrichAdoptLiveSessions(input, { runHerdr: herdr.run }));
    await vi.advanceTimersByTimeAsync(799);
    await flush();
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(state.done).toBe(true);
    expect(herdr.calls).toHaveLength(4);
    expect(herdr.signals.every(s => s.aborted)).toBe(true);
    expect(state.value![0]).toBe(input[0]);
    expect(state.value![1]).toBe(input[1]);
  });

  it('shortens the budget to a nearer deadline and keeps whatever answered in time', async () => {
    vi.useFakeTimers();
    const herdr = fakeHerdr({
      'default workspace': workspaceList({ workspace_id: 'w1', label: '示例空间' }),
      'default tab': 'hang',
    });
    const state = settle(enrichAdoptLiveSessions([live()], { runHerdr: herdr.run, deadlineMs: Date.now() + 300 }));
    await vi.advanceTimersByTimeAsync(299);
    await flush();
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(state.done).toBe(true);
    expect(state.value![0]).toMatchObject({ herdrWorkspaceLabel: '示例空间' });
    expect('herdrTabLabel' in state.value![0]!).toBe(false);
  });

  it('stops waiting on first-prompt reads at the budget and aborts them', async () => {
    vi.useFakeTimers();
    const herdr = fakeHerdr({ 'default tab': tabList({ tab_id: 'w1:t1', workspace_id: 'w1', label: '1' }) });
    let readSignal: AbortSignal | undefined;
    const readFirstPrompt = (_sid: string, _cwd: string, signal: AbortSignal) => {
      readSignal = signal;
      return new Promise<string | undefined>(() => {});
    };
    const state = settle(enrichAdoptLiveSessions([live({ herdrWorkspaceId: undefined })], { runHerdr: herdr.run, readFirstPrompt }));
    // Let the tab answer and the read start before the clock moves.
    await flush();
    await vi.advanceTimersByTimeAsync(800);
    await flush();
    expect(state.done).toBe(true);
    expect(readSignal?.aborted).toBe(true);
    // The tab still counts; only the first prompt is missing.
    expect(state.value![0]).toMatchObject({ herdrTabLabel: '1', herdrTabAutoNamed: true });
    expect('herdrFirstPrompt' in state.value![0]!).toBe(false);
  });

  it('counts child start-up time against the budget: the wait ends at entry + 800 ms, not 800 ms after the last launch', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const calls: string[][] = [];
    // Each launch eats 150 ms of clock before it hands back its (immediate) answer.
    const runHerdr: HerdrRunner = (args) => {
      calls.push(args);
      vi.advanceTimersByTime(150);
      return Promise.resolve(args[2] === 'tab'
        ? tabList({ tab_id: 'w1:t1', workspace_id: 'w1', label: '1' })
        : workspaceList({ workspace_id: 'w1', label: '示例空间' }));
    };
    let readSignal: AbortSignal | undefined;
    const readFirstPrompt = vi.fn((_sid: string, _cwd: string, signal: AbortSignal) => {
      readSignal = signal;
      return new Promise<string | undefined>(() => {});
    });

    const state = settle(enrichAdoptLiveSessions([live()], { runHerdr, readFirstPrompt }));
    await flush();
    expect(calls).toHaveLength(2);
    expect(Date.now() - started).toBe(300);
    // Started with 500 ms left; it never answers.
    expect(readFirstPrompt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    await flush();
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(state.done).toBe(true);
    expect(Date.now() - started).toBe(800);
    expect(readSignal?.aborted).toBe(true);
    expect(state.value![0]).toMatchObject({ herdrWorkspaceLabel: '示例空间', herdrTabLabel: '1', herdrTabAutoNamed: true });
  });

  it('launches nothing new once start-up has used the budget, and does not wait past it', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const calls: string[][] = [];
    // 300 ms per launch: the third one starts at 600 ms, the fourth would start at 900 ms.
    const runHerdr: HerdrRunner = (args) => {
      calls.push(args);
      vi.advanceTimersByTime(300);
      return Promise.resolve(args[2] === 'tab'
        ? tabList({ tab_id: 'w1:t1', workspace_id: 'w1', label: '1' })
        : workspaceList({ workspace_id: 'w1', label: '示例空间' }));
    };
    const readFirstPrompt = vi.fn(async () => '修复登录页样式');

    const state = settle(enrichAdoptLiveSessions(
      [live(), live({ herdrSessionName: 'side' })],
      { runHerdr, readFirstPrompt },
    ));
    // Nothing is advanced: with the deadline behind it, it must return without
    // waiting on any timer (and Bun's advanceTimersByTime(0) moves the clock 1 ms).
    await flush();
    expect(state.done).toBe(true);
    expect(calls.map(a => a.join(' '))).toEqual([
      '--session default workspace list',
      '--session default tab list',
      '--session side workspace list',
    ]);
    // The default tab answered, but past the deadline no first-prompt read starts.
    expect(readFirstPrompt).not.toHaveBeenCalled();
    expect(Date.now() - started).toBe(900);
    expect(state.value![0]).toMatchObject({ herdrTabLabel: '1' });
    expect('herdrFirstPrompt' in state.value![0]!).toBe(false);
    expect(state.value![1]).toMatchObject({ herdrWorkspaceLabel: '示例空间' });
    expect('herdrTabLabel' in state.value![1]!).toBe(false);
  });

  describe.skipIf(process.platform === 'win32')('a real herdr child (fake `herdr` script that hangs)', () => {
    let dir: string;
    let pidFile: string;
    let script: string;
    let ignoresTerm: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'adopt-live-herdr-'));
      pidFile = join(dir, 'pids');
      script = join(dir, 'herdr');
      writeFileSync(script, `#!/bin/sh\necho $$ >> '${pidFile}'\nexec sleep 30\n`);
      chmodSync(script, 0o755);
      // SIGTERM is ignored before the pid is published, and stays ignored across exec.
      ignoresTerm = join(dir, 'herdr-ignores-term');
      writeFileSync(ignoresTerm, `#!/bin/sh\ntrap '' TERM\necho $$ >> '${pidFile}'\nexec sleep 30\n`);
      chmodSync(ignoresTerm, 0o755);
    });
    afterEach(() => {
      // Whatever a case left running, pass or fail.
      for (const pid of pids()) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      rmSync(dir, { recursive: true, force: true });
    });
    const alive = (pid: number) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
    const pids = () => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
    async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
      const until = Date.now() + ms;
      while (!cond() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    }

    it('the default runner kills the child as soon as the signal aborts', async () => {
      const controller = new AbortController();
      const result = runHerdrCli(['--session', 'default', 'tab', 'list'], { signal: controller.signal, timeoutMs: 30_000 }, script);
      await waitFor(() => pids().length === 1);
      const [pid] = pids();
      expect(pid && alive(pid)).toBe(true);
      controller.abort();
      expect(await result).toBeUndefined();
      await waitFor(() => !alive(pid!));
      expect(alive(pid!)).toBe(false);
    });

    it('the default runner also ends a child that ignores SIGTERM once the signal aborts', async () => {
      const controller = new AbortController();
      const result = runHerdrCli(['--session', 'default', 'tab', 'list'], { signal: controller.signal, timeoutMs: 30_000 }, ignoresTerm);
      await waitFor(() => pids().length === 1);
      const [pid] = pids();
      expect(pid && alive(pid)).toBe(true);
      controller.abort();
      expect(await result).toBeUndefined();
      await waitFor(() => !alive(pid!));
      expect(alive(pid!)).toBe(false);
    });

    it('enrichment returns at its deadline and leaves no herdr child running', async () => {
      const input = [live()];
      const started = Date.now();
      const out = await enrichAdoptLiveSessions(input, {
        runHerdr: (args, opts) => runHerdrCli(args, opts, script),
        deadlineMs: started + 400,
      });
      // Returns at the deadline (a busy host gets slack), not after the 30 s sleep.
      expect(Date.now() - started).toBeLessThan(400 + 600);
      expect(out[0]).toBe(input[0]);
      await waitFor(() => pids().every(pid => !alive(pid)), 3000);
      expect(pids().filter(alive)).toEqual([]);
    });
  });
});

// ─── Transcript lookup stops with the budget ───────────────────────────────

describe('transcript lookup after the budget runs out', () => {
  const tabOne = () => fakeHerdr({ 'default tab': tabList({ tab_id: 'w1:t1', workspace_id: 'w1', label: '1' }) }).run;
  const entry = () => live({ herdrWorkspaceId: undefined });
  const underDataDir = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(c => String(c[0]).startsWith(dataDir)).length;

  function spyFs() {
    const realRealpath = fsPromises.realpath.bind(fsPromises);
    const realReaddir = fsPromises.readdir.bind(fsPromises);
    const realStat = fsPromises.stat.bind(fsPromises);
    const realOpen = fsPromises.open.bind(fsPromises);
    const holds = { realpath: undefined as Promise<void> | undefined, readdir: undefined as Promise<void> | undefined };
    return {
      holds,
      realpath: vi.spyOn(fsPromises, 'realpath').mockImplementation((async (...args: any[]) => {
        await holds.realpath;
        return (realRealpath as any)(...args);
      }) as any),
      readdir: vi.spyOn(fsPromises, 'readdir').mockImplementation((async (...args: any[]) => {
        await holds.readdir;
        return (realReaddir as any)(...args);
      }) as any),
      stat: vi.spyOn(fsPromises, 'stat').mockImplementation(((...args: any[]) => (realStat as any)(...args)) as any),
      open: vi.spyOn(fsPromises, 'open').mockImplementation(((...args: any[]) => (realOpen as any)(...args)) as any),
    };
  }

  beforeEach(() => {
    for (const dir of ['alpha', 'beta', 'gamma']) mkdirSync(join(dataDir, 'projects', dir), { recursive: true });
  });

  it('a realpath still pending at the deadline leads to no stat, readdir or transcript read', async () => {
    const fs = spyFs();
    const held = gate();
    fs.holds.realpath = held.opened;
    const out = await enrichAdoptLiveSessions([entry()], {
      runHerdr: tabOne(), claudeDataDir: dataDir, deadlineMs: Date.now() + 150,
    });
    expect(fs.realpath).toHaveBeenCalledTimes(1);
    held.open();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(underDataDir(fs.stat)).toBe(0);
    expect(underDataDir(fs.readdir)).toBe(0);
    expect(underDataDir(fs.open)).toBe(0);
    expect('herdrFirstPrompt' in out[0]!).toBe(false);
  });

  it('a readdir still pending at the deadline leads to no directory stat and no transcript read', async () => {
    const fs = spyFs();
    const held = gate();
    fs.holds.readdir = held.opened;
    await enrichAdoptLiveSessions([entry()], {
      runHerdr: tabOne(), claudeDataDir: dataDir, deadlineMs: Date.now() + 150,
    });
    // Only the exact-slug probe ran before the fallback scan was reached.
    expect(underDataDir(fs.stat)).toBe(1);
    expect(underDataDir(fs.readdir)).toBe(1);
    held.open();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(underDataDir(fs.stat)).toBe(1);
    expect(underDataDir(fs.open)).toBe(0);
  });

  it('scans projects/* at most 8 directories at a time and submits no new stat once aborted', async () => {
    for (let i = 0; i < 20; i++) mkdirSync(join(dataDir, 'projects', `dir-${i}`), { recursive: true });
    const realStat = fsPromises.stat.bind(fsPromises);
    const held = gate();
    let fallbackCalls = 0;
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(fsPromises, 'stat').mockImplementation((async (...args: any[]) => {
      if (!String(args[0]).includes(`${join(dataDir, 'projects')}/`) || String(args[0]).includes('-work-demo')) {
        return (realStat as any)(...args);
      }
      fallbackCalls++;
      peak = Math.max(peak, ++inFlight);
      try {
        await held.opened;
        return await (realStat as any)(...args);
      } finally {
        inFlight--;
      }
    }) as any);
    const open = vi.spyOn(fsPromises, 'open');

    const controller = new AbortController();
    const pending = readClaudeFirstPrompt(SID, '/work/demo', controller.signal, dataDir);
    await waitUntil(() => inFlight === 8);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(peak).toBe(8);
    controller.abort();
    held.open();
    expect(await pending).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fallbackCalls).toBe(8);
    expect(open).not.toHaveBeenCalled();
  });
});

// ─── Transcript lookup for a long cwd ──────────────────────────────────────

describe('transcript lookup for a long cwd (cut + hashed directory name)', () => {
  // Over 200 chars as a slug, so Claude names its directory `<first 200>-<hash>`.
  const longCwd = `/work/${'nested/'.repeat(30)}demo`;
  const slug = longCwd.replace(/[^A-Za-z0-9-]/g, '-');
  const cutDir = `${slug.slice(0, 200)}-1a2b3c`;
  const projectDirs = () => readdirSync(join(dataDir, 'projects')).length;

  /** Every path `stat`ed under the temp projects dir, in call order. */
  function spyStat(): string[] {
    const realStat = fsPromises.stat.bind(fsPromises);
    const paths: string[] = [];
    vi.spyOn(fsPromises, 'stat').mockImplementation(((...args: any[]) => {
      if (String(args[0]).startsWith(join(dataDir, 'projects'))) paths.push(String(args[0]));
      return (realStat as any)(...args);
    }) as any);
    return paths;
  }

  it('finds it in the cut directory without probing every directory', async () => {
    for (let i = 0; i < 20; i++) mkdirSync(join(dataDir, 'projects', `dir-${i}`), { recursive: true });
    writeTranscript([userRecord('整理示例数据')], { dir: cutDir });
    const stats = spyStat();
    expect(await readPrompt(SID, longCwd)).toBe('整理示例数据');
    // The exact slug path and the cut directory, none of the 20 others.
    expect(stats.length).toBeLessThanOrEqual(1 + 1);
    expect(stats.length).toBeLessThan(projectDirs());
  });

  it('still finds it elsewhere when no directory carries the cut name', async () => {
    for (const dir of ['alpha', 'beta', 'gamma']) mkdirSync(join(dataDir, 'projects', dir), { recursive: true });
    writeTranscript([userRecord('整理示例数据')], { dir: 'some-other-project' });
    const stats = spyStat();
    expect(await readPrompt(SID, longCwd)).toBe('整理示例数据');
    expect(new Set(stats).size).toBe(stats.length);
    expect(stats.length).toBeLessThanOrEqual(projectDirs() + 1);
  });

  it('still finds it elsewhere when the cut directory does not hold it, and probes that directory once', async () => {
    for (const dir of ['alpha', 'beta', 'gamma']) mkdirSync(join(dataDir, 'projects', dir), { recursive: true });
    writeTranscript([userRecord('另一个会话')], { dir: cutDir, sid: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed' });
    writeTranscript([userRecord('整理示例数据')], { dir: 'some-other-project' });
    const stats = spyStat();
    expect(await readPrompt(SID, longCwd)).toBe('整理示例数据');
    expect(new Set(stats).size).toBe(stats.length);
    expect(stats.length).toBeLessThanOrEqual(projectDirs() + 1);
  });
});

// ─── Rendering after partial failures ──────────────────────────────────────

describe('enrichment failures render like before on the failing side', () => {
  const WORKSPACES = workspaceList({ workspace_id: 'w1', label: '示例空间' });
  const TABS = tabList({ tab_id: 'w1:t1', workspace_id: 'w1', label: '1' });
  const OTHER_TABS = tabList({ tab_id: 'w1:t8', workspace_id: 'w1', label: '1' });
  const entry = live({ herdrPaneId: 'w1:p2', herdrTarget: 'w1:p2' });
  const { herdrTabId: _drop, ...noTabId } = entry;
  let before: string[];
  beforeEach(() => {
    before = cardLines([entry])[0]!;
  });
  const LOCATION_BEFORE = 'Location: `default:w1:p2`';
  const LOCATION_WITH_WORKSPACE = 'Location: 示例空间 (`default:w1:p2`)';

  async function renderWith(replies: Record<string, string>, session: AdoptableSession = entry): Promise<string[]> {
    const herdr = fakeHerdr(replies);
    const out = await enrichAdoptLiveSessions([session], { runHerdr: herdr.run, readFirstPrompt: noFirstPrompt });
    return cardLines(out as AdoptableSession[])[0]!;
  }

  it('baseline: no names → directory title and the bare location', () => {
    expect(before[0]).toBe('**demo**');
    expect(before).toContain(LOCATION_BEFORE);
  });

  it('workspace found, tab lookup failed → new location line, old title', async () => {
    const lines = await renderWith({ 'default workspace': WORKSPACES });
    expect(lines[0]).toBe(before[0]);
    expect(lines).toContain(LOCATION_WITH_WORKSPACE);
    expect(lines.filter(l => l !== LOCATION_WITH_WORKSPACE)).toEqual(before.filter(l => l !== LOCATION_BEFORE));
  });

  it('workspace lookup failed, tab found → new title, old location line', async () => {
    const lines = await renderWith({ 'default tab': TABS });
    expect(lines[0]).toBe('**1**');
    expect(lines.slice(1)).toEqual(before.slice(1));
  });

  it('both lookups failed → the card is exactly as before', async () => {
    expect(await renderWith({})).toEqual(before);
    expect(await renderWith({ 'default workspace': 'not json', 'default tab': '{"result":{}}' })).toEqual(before);
  });

  it('entry without a tab id → old title even though the tab list answered', async () => {
    const lines = await renderWith({ 'default workspace': WORKSPACES, 'default tab': TABS }, noTabId as AdoptableSession);
    expect(lines[0]).toBe(before[0]);
    expect(lines).toContain(LOCATION_WITH_WORKSPACE);
  });

  it('tab id missing from the tab list → old title', async () => {
    const lines = await renderWith({ 'default workspace': WORKSPACES, 'default tab': OTHER_TABS });
    expect(lines[0]).toBe(before[0]);
    expect(lines).toContain(LOCATION_WITH_WORKSPACE);
  });
});

describe('first prompt end to end (generic terminal title, no transcript, botmux envelope)', () => {
  it('titles each entry by first prompt, else by its default tab name, and keeps every entry', async () => {
    const [a, b, c] = [SID, '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b'];
    writeTranscript([userRecord('<command-name>/model</command-name>'), userRecord('修复登录页样式')], { sid: a });
    // b: not prompted yet, no transcript on disk.
    writeTranscript([userRecord('<user_message>你好</user_message>')], { sid: c });
    const herdr = fakeHerdr({
      'default tab': tabList(
        { tab_id: 'w1:t1', workspace_id: 'w1', label: '1' },
        { tab_id: 'w1:t2', workspace_id: 'w1', label: '2' },
        { tab_id: 'w1:t3', workspace_id: 'w1', label: '3' },
      ),
    });
    // Discovery dropped the generic `Claude Code` terminal title, so none of them has a native title.
    const sessions = [a, b, c].map((sessionId, i) => live({
      herdrPaneId: `w1:p${i + 1}`, herdrTabId: `w1:t${i + 1}`, herdrWorkspaceId: undefined, sessionId,
    }));
    const out = await enrichAdoptLiveSessions(sessions, { runHerdr: herdr.run, claudeDataDir: dataDir });
    expect(cardLines(out as AdoptableSession[], 'zh').map(l => l[0])).toEqual(['**修复登录页样式**', '**2**', '**3**']);
  });
});
