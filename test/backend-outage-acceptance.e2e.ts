/**
 * Acceptance: the shared tmux server dies under N live sessions.
 *
 * Real worker processes (src/worker.ts) run a fake Hermes-style CLI in a
 * PRIVATE tmux server (own TMUX_TMPDIR + own socket name, never the fleet's
 * `-L botmux`), wired to the REAL daemon-side worker handlers in this process
 * (crash loop, restart coordinator, backend-outage coordinator). Only the
 * Feishu transport is faked: posted messages and card patches are recorded.
 *
 * The server process is SIGKILLed while one session is in the middle of a
 * turn. Pinned:
 *  - the server is brought back once (one canary restart while it is down,
 *    exactly one new server pid);
 *  - every topic gets at most ONE status message, patched in place to
 *    "recovered";
 *  - no crash-loop / start-failure text is posted;
 *  - after recovery a new message reaches each CLI and completes;
 *  - the turn that was running when the server died has an explicit outcome
 *    on its card;
 *  - the owner gets ONE summary.
 * Then: a CLI that exits non-zero leaves a dead pane behind and the next
 * message is pasted at it — the server must survive (on tmux <= 3.3a an
 * unguarded paste-buffer into a dead pane kills it).
 *
 * Local acceptance only (e2e project): it forks N real workers.
 *   bun scripts/fenced-run.ts -- node_modules/.bin/vitest run --project e2e test/backend-outage-acceptance.e2e.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Short: tmux socket paths are length-limited. Created in beforeAll.
const ROOT = vi.hoisted(() => `/tmp/bo-acc-${process.pid}-${Date.now().toString(36)}`);

vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(orig)) {
    const isClass = typeof value === 'function' && /^class\s/.test(Function.prototype.toString.call(value));
    out[key] = typeof value === 'function' && !isClass ? vi.fn(async () => undefined) : value;
  }
  return out;
});

vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const bot = {
    config: { larkAppId: 'app_lab', larkAppSecret: '', cliId: 'hermes' },
    resolvedAllowedUsers: ['ou_owner'],
    botOpenId: 'ou_bot',
    botName: 'AcceptanceBot',
  };
  return { ...orig, getBot: vi.fn(() => bot), getAllBots: vi.fn(() => [bot]), getOwnerOpenId: vi.fn(() => 'ou_owner') };
});

vi.mock('../src/config.js', async (importOriginal) => {
  const orig = await importOriginal<{ config: any }>();
  return { ...orig, config: { ...orig.config, session: { ...orig.config.session, dataDir: `${ROOT}/daemon-data` } } };
});

vi.mock('../src/services/session-store.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, updateSession: vi.fn(), closeSession: vi.fn() };
});

import {
  labServerPid,
  labTmux,
  prepareOutageLabWorld,
  realTmuxPath,
  startOutageLabSession,
  type OutageLabSession,
} from './helpers/backend-outage-lab.js';
import {
  initWorkerPool,
  __testOnly_setupWorkerHandlers,
  __testOnly_resetRestartCoordinator,
  restartCounts,
  sendWorkerInput,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import { updateMessage } from '../src/im/lark/client.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const realTmux = realTmuxPath();

const N = 4;
const WORLD = { root: ROOT, tmuxTmpDir: join(ROOT, 't'), socket: 'bmxacc' };
const TMUX_TMPDIR = WORLD.tmuxTmpDir;
const posted: Array<{ root: string; content: string; type?: string }> = [];
const ownerMessages: string[] = [];

const tmux = (...args: string[]) => labTmux(WORLD, realTmux!, ...args);
const serverPid = (): number | undefined => labServerPid(WORLD, realTmux!);

interface Lab extends OutageLabSession { ds: DaemonSession }

const labs: Lab[] = [];

/** Evidence for a human reader (BO_ACC_REPORT=<file>): vitest's e2e project
 *  does not show console output. */
function report(label: string, value: unknown): void {
  if (!process.env.BO_ACC_REPORT) return;
  appendFileSync(process.env.BO_ACC_REPORT, `### ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n\n`);
}

/** Visible text of a card JSON (header + markdown blocks). */
function cardText(json: string): string {
  const card = JSON.parse(json);
  const parts = [card.header?.title?.content ?? ''];
  for (const el of card.elements ?? []) {
    if (el.text?.content) parts.push(el.text.content);
    for (const sub of el.elements ?? []) if (sub.content) parts.push(`(${sub.content})`);
  }
  return parts.join('\n');
}

function makeDs(session: OutageLabSession): DaemonSession {
  return {
    session: {
      sessionId: session.sessionId, rootMessageId: session.rootMessageId, chatId: 'oc_lab', title: `topic ${session.rootMessageId}`,
      status: 'active' as any, createdAt: Date.now(), updatedAt: Date.now(), pid: null, chatType: 'group', cliId: 'hermes',
      backendType: 'tmux', workingDir: session.workDir,
    },
    worker: session.worker as any, workerPort: null, workerToken: null, larkAppId: 'app_lab', chatId: 'oc_lab', chatType: 'group',
    spawnedAt: Date.now(), cliVersion: '0.18.0', lastMessageAt: Date.now(), hasHistory: true, displayMode: 'hidden',
    lastScreenContent: '', initConfig: session.init,
  } as unknown as DaemonSession;
}

function startLab(index: number): Lab {
  const session = startOutageLabSession(WORLD, index);
  const ds = makeDs(session);
  // The real daemon handlers drive this worker from here on.
  __testOnly_setupWorkerHandlers(ds, session.worker as any);
  session.sendInit();
  return { ...session, ds };
}

const cliPids = (lab: Lab) => [...new Set(lab.typed().filter(t => t.line === '<start>').map(t => t.pid))];
/** Outage status cards posted into a topic (a turn's own streaming card is
 *  not a status message about the outage). */
const cardsOf = (lab: Lab) => posted.filter(p => p.root === lab.ds.session.rootMessageId && p.type === 'interactive'
  && p.content.includes('同一次终端服务故障'));
const textsOf = (lab: Lab) => posted.filter(p => p.root === lab.ds.session.rootMessageId && p.type !== 'interactive');
const restartIpcCount = () => labs.reduce((n, lab) => n + (lab.ds as any).__restarts, 0);

describe.skipIf(!realTmux)('acceptance: a lost shared tmux server is one backend outage', () => {
  beforeAll(async () => {
    prepareOutageLabWorld(WORLD);
    process.env.TMUX_TMPDIR = TMUX_TMPDIR;
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    restartCounts.clear();
    __testOnly_resetRestartCoordinator();
    initWorkerPool({
      sessionReply: vi.fn(async (root: string, content: string, type?: string) => {
        posted.push({ root, content, type });
        return `om_msg_${posted.length}`;
      }),
      notifyOwner: vi.fn(async (_app: string, content: string) => { ownerMessages.push(content); }),
      getSessionWorkingDir: (ds?: DaemonSession) => ds?.session.workingDir ?? ROOT,
      getActiveCount: () => N,
      closeSession: vi.fn(),
    } as any);
    for (let i = 0; i < N; i++) {
      const lab = startLab(i);
      const send = lab.worker.send.bind(lab.worker);
      (lab.ds as any).__restarts = 0;
      (lab.worker as any).send = (msg: any, ...rest: any[]) => {
        if (msg?.type === 'restart') (lab.ds as any).__restarts += 1;
        return send(msg, ...rest);
      };
      labs.push(lab);
    }
    // The daemon's view of its live sessions (each worker reports its tmux
    // socket itself via persistent_backend_target).
    setActiveSessionsRegistry(new Map(labs.map(lab => [activeSessionKey(lab.ds), lab.ds])));
    await vi.waitFor(() => {
      for (const lab of labs) expect(lab.ds.cliReady, lab.logs()).toBe(true);
    }, { timeout: 60_000, interval: 200 });
  }, 90_000);

  afterAll(async () => {
    setActiveSessionsRegistry(undefined);
    for (const lab of labs) {
      try { lab.worker.kill('SIGKILL'); } catch { /* gone */ }
    }
    tmux('kill-server');
    if (!process.env.BO_ACC_KEEP) rmSync(ROOT, { recursive: true, force: true });
  });

  it('recovers once, one card per topic, no crash-loop text, new messages run, the interrupted turn has an outcome', async () => {
    // One session is in the middle of a turn when the server dies.
    const busy = labs[0]!;
    sendWorkerInput(busy.ds, 'LONG task before the crash', 'om_turn_long');
    await vi.waitFor(() => expect(busy.typed().some(t => t.line.includes('LONG task')), busy.logs()).toBe(true), { timeout: 30_000 });
    await vi.waitFor(() => expect(busy.ds.lastScreenStatus, busy.logs()).toBe('working'), { timeout: 15_000 });

    const firstPid = serverPid();
    expect(firstPid).toBeDefined();
    const before = new Map(labs.map(lab => [lab, cliPids(lab)]));
    const seenServerPids = new Set<number>([firstPid!]);
    const watch = setInterval(() => { const pid = serverPid(); if (pid) seenServerPids.add(pid); }, 100);
    try {
      // The crash: this test's own private server only.
      process.kill(firstPid!, 'SIGKILL');

      // Every topic: one card, ending "recovered", with a fresh CLI process.
      await vi.waitFor(() => {
        for (const lab of labs) {
          const cards = cardsOf(lab);
          expect(cards, cards.map(c => cardText(c.content)).join('\n=====\n')).toHaveLength(1);
          const patches = vi.mocked(updateMessage).mock.calls.filter(c => c[1] === `om_msg_${posted.indexOf(cards[0]!) + 1}`);
          expect(String(patches.at(-1)?.[2] ?? cards[0]!.content), lab.logs()).toContain('已恢复');
          expect(cliPids(lab).length, lab.logs()).toBeGreaterThan(before.get(lab)!.length);
        }
      }, { timeout: 120_000, interval: 250 });
    } finally {
      clearInterval(watch);
    }

    // The server came back exactly once.
    const after = serverPid();
    expect(after).toBeDefined();
    expect(after).not.toBe(firstPid);
    expect([...seenServerPids].sort()).toEqual([firstPid!, after!].sort());
    // One restart per session: one canary first, then the others, no retries.
    expect(restartIpcCount()).toBe(N);
    for (const lab of labs) expect(restartCounts.has(lab.ds.session.sessionId)).toBe(false);

    // No crash-loop / start-failure / interruption texts: the card says it all.
    for (const lab of labs) {
      const texts = textsOf(lab).map(t => t.content);
      expect(texts.filter(t => /崩溃|启动失败|停止自动重启|会话刚刚重启/.test(t)), lab.logs()).toEqual([]);
    }

    // The interrupted turn's card states its outcome.
    const busyCard = cardsOf(busy)[0]!;
    const busyFinal = String(vi.mocked(updateMessage).mock.calls
      .filter(c => c[1] === `om_msg_${posted.indexOf(busyCard) + 1}`).at(-1)?.[2]);
    expect(busyFinal).toMatch(/已重新提交给|中断时这一轮还在执行|重启前的工作被中断/);

    // What happened to the cut turn: handed to the recovered CLI again, or
    // (if not) at least spelled out on the card (asserted above).
    const busyNewest = cliPids(busy).at(-1);
    const rerun = busy.typed().some(t => t.pid === busyNewest && t.line.includes('LONG task'));
    report('cut turn re-delivered to the recovered CLI', String(rerun));

    // New messages run to completion on the recovered CLIs.
    for (const [i, lab] of labs.entries()) sendWorkerInput(lab.ds, `after recovery ${i}`, `om_turn_after_${i}`);
    await vi.waitFor(() => {
      for (const [i, lab] of labs.entries()) {
        const newest = cliPids(lab).at(-1);
        expect(lab.typed().some(t => t.pid === newest && t.line.includes(`after recovery ${i}`)), lab.logs()).toBe(true);
        const screen = String(tmux('capture-pane', '-p', '-t', lab.paneTarget).stdout ?? '');
        expect(screen).toContain(`REPLY: after recovery ${i}`);
      }
    }, { timeout: 60_000, interval: 250 });

    // One owner summary for the whole outage.
    await vi.waitFor(() => expect(ownerMessages).toHaveLength(1), { timeout: 90_000, interval: 500 });
    expect(ownerMessages[0]).toContain(`${N} 个会话受影响`);
    expect(ownerMessages[0]).toContain(`已恢复 ${N} 个`);
    report('tmux', String(execFileSync(realTmux!, ['-V'], { encoding: 'utf8' })).trim());
    report('server pids seen (killed, recovered)', [firstPid, after]);
    report('restart IPCs sent', restartIpcCount());
    for (const lab of labs) {
      const card = cardsOf(lab)[0]!;
      const id = `om_msg_${posted.indexOf(card) + 1}`;
      const patches = vi.mocked(updateMessage).mock.calls.filter(c => c[1] === id).map(c => cardText(String(c[2])));
      report(`topic ${lab.ds.session.rootMessageId}: 1 post + ${patches.length} in-place patches; posted then final`, `${cardText(card.content)}\n---\n${patches.at(-1)}`);
      report(`topic ${lab.ds.session.rootMessageId}: plain texts posted`, textsOf(lab).map(t => t.content));
    }
    report('owner summary', ownerMessages[0]);
  }, 300_000);

  it('a CLI that dies non-zero leaves a dead pane; pasting the next message at it does not take the server down', async () => {
    const victim = labs[1]!;
    const pid = serverPid();
    const pasteBefore = victim.typed().length;
    sendWorkerInput(victim.ds, 'please DIE now', 'om_turn_die');
    await vi.waitFor(() => {
      const r = tmux('display-message', '-p', '-t', victim.paneTarget, '#{pane_dead}');
      expect(String(r.stdout).trim()).toBe('1');
    }, { timeout: 15_000, interval: 50 });
    // Right behind it, before any liveness probe: the next message (Hermes
    // pastes its input) and a paste from an attached client's binding.
    sendWorkerInput(victim.ds, 'message into the corpse', 'om_turn_corpse');
    spawnSync(realTmux!, ['-L', WORLD.socket, 'load-buffer', '-'], { input: 'x\ny', env: { ...process.env, TMUX_TMPDIR } });
    tmux('paste-buffer', '-t', victim.paneTarget, '-p');
    await new Promise(r => setTimeout(r, 2_000));
    expect(serverPid()).toBe(pid);
    for (const lab of labs) {
      if (lab === victim) continue;
      expect(tmux('has-session', '-t', lab.paneTarget).status).toBe(0);
    }
    expect(victim.typed().length).toBeGreaterThan(pasteBefore);
    report('dead pane + paste', `tmux ${String(execFileSync(realTmux!, ['-V'], { encoding: 'utf8' })).trim()}: server pid ${pid} survived a paste into a dead pane (pid now ${serverPid()})`);
  }, 60_000);
});
