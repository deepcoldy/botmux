/**
 * Dashboard workflow drafts: interleavings and partial failures (design
 * 2026-11-03 workflow-dashboard-orchestration §4.2, §4.4, §9; the
 * adversarial review of D2). Real draft service over a real run dir; the
 * clarify session, Architect worker and timers are fakes, with gates to
 * hold an operation half way while another one runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowDraftError, WorkflowDraftService, type DraftClarifier } from '../src/workflows/v3/draft-service.js';
import { listWorkflowDrafts, readWorkflowDraft, workflowDraftOwner, writeWorkflowDraft } from '../src/workflows/v3/draft-store.js';
import { createProductionDraftClarifier } from '../src/core/workflow-draft-daemon.js';
import { OWNER, SKETCHES, architectSettled, makeService, specMarkdown } from './helpers/workflow-draft-fakes.js';

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'wf-drafts-races-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkflowDraftError) return error.code;
    throw error;
  }
  return 'ok';
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const onlyRunId = () => readdirSync(base).find((name) => !name.startsWith('.'))!;
const specBlock = () => `够了\n<botmux-spec>\n${specMarkdown(SKETCHES)}\n</botmux-spec>`;
const sessionStates = (h: ReturnType<typeof makeService>) => [...h.clarify.sessions.values()].map((session) => session.closed);

async function specApproved(h: ReturnType<typeof makeService>, service: WorkflowDraftService = h.service) {
  const view = await service.create(OWNER, { goal: '帮我出一份代码风险报告' });
  h.clarify.reply(specBlock());
  expect((await service.finalizeSpec(view.runId, OWNER, {})).ok).toBe(true);
  await service.approveSpec(view.runId, OWNER);
  return view.runId;
}

describe('Architect outcome that cannot be recorded', () => {
  it('a failure reason longer than the record allows is cut to fit, and the draft goes back to 待编排', async () => {
    const h = makeService(base, { runArchitect: async () => { throw new Error('E'.repeat(5000)); } });
    const runId = await specApproved(h);
    await h.service.startArchitect(runId, OWNER);
    await architectSettled(h.service, runId);
    const view = await h.service.view(runId);
    expect(view).toMatchObject({ phase: 'awaiting_architect', architect: { state: 'failed' } });
    expect(view.architect!.problems![0]!.length).toBeLessThanOrEqual(4000);
    expect(view.architect!.problems![0]!.endsWith('…')).toBe(true);
  });

  it('a draft left 编排中 with nothing running heals to 编排中断 on the next read, write or cancel', async () => {
    const h = makeService(base);
    const runId = await specApproved(h);
    const runDir = join(base, runId);
    const stuck = () => {
      const draft = readWorkflowDraft(runDir)!;
      writeWorkflowDraft(runDir, { ...draft, architect: { state: 'running', attempt: 1, startedAt: draft.updatedAt } });
    };
    stuck();
    expect(await h.service.view(runId)).toMatchObject({ phase: 'awaiting_architect', architect: { state: 'interrupted' } });
    stuck();
    expect(await code(h.service.cancelArchitect(runId, OWNER))).toBe('ok');
    expect(readWorkflowDraft(runDir)!.architect!.state).toBe('interrupted');
    stuck();
    expect(await code(h.service.startArchitect(runId, OWNER))).toBe('ok');
    await architectSettled(h.service, runId);
    expect((await h.service.view(runId)).phase).toBe('dag_ready');
  });

  it('a live run in this process is never healed away', async () => {
    const h = makeService(base);
    h.architect.mode = 'hang';
    const runId = await specApproved(h);
    await h.service.startArchitect(runId, OWNER);
    expect((await h.service.view(runId)).architect!.state).toBe('running');
    expect(await code(h.service.reviseSpec(runId, OWNER))).toBe('architect_running');
    await h.service.cancelArchitect(runId, OWNER);
    await architectSettled(h.service, runId);
  });
});

describe('clarify session start', () => {
  it('another tab cannot start a second session while create is still starting the first', async () => {
    const h = makeService(base);
    const gate = deferred();
    const inner = h.clarify.clarifier;
    let first = true;
    const clarifier: DraftClarifier = { ...inner, create: async (input) => { if (first) { first = false; await gate.promise; } return inner.create(input); } };
    const service = new WorkflowDraftService({ ...h.deps, clarifier });
    const creating = service.create(OWNER, { goal: 'g' });
    await tick();
    const runId = onlyRunId();
    expect(await code(service.continueClarify(runId, OWNER))).toBe('clarify_turn_running');
    expect(await code(service.sendMessage(runId, OWNER, { text: 'hi' }))).toBe('clarify_turn_running');
    gate.resolve();
    await creating;
    expect(h.clarify.sessions.size).toBe(1);
    expect(sessionStates(h)).toEqual([false]);
    expect(readWorkflowDraft(join(base, runId))!.clarify.sessionId).toBe('sess-1');
  });

  it('abandoned and deleted while the session is being created: the new session is closed, not orphaned', async () => {
    const h = makeService(base);
    const gate = deferred();
    const inner = h.clarify.clarifier;
    const clarifier: DraftClarifier = { ...inner, create: async (input) => { await gate.promise; return inner.create(input); } };
    const service = new WorkflowDraftService({ ...h.deps, clarifier });
    const creating = code(service.create(OWNER, { goal: 'g' }));
    await tick();
    const runId = onlyRunId();
    await service.abandon(runId, OWNER);
    await service.delete(runId, OWNER);
    gate.resolve();
    expect(await creating).toBe('unknown_draft');
    expect(sessionStates(h)).toEqual([true]);
  });

  it('abandoned (not deleted) while the session is being created: closed as well', async () => {
    const h = makeService(base);
    const gate = deferred();
    const inner = h.clarify.clarifier;
    const service = new WorkflowDraftService({ ...h.deps, clarifier: { ...inner, create: async (input) => { await gate.promise; return inner.create(input); } } });
    const creating = service.create(OWNER, { goal: 'g' });
    await tick();
    await service.abandon(onlyRunId(), OWNER);
    gate.resolve();
    expect((await creating).phase).toBe('abandoned');
    expect(sessionStates(h)).toEqual([true]);
  });

  it('a session started by a process whose reservation was dropped meanwhile is closed, not recorded', async () => {
    const h = makeService(base);
    const gate = deferred();
    const inner = h.clarify.clarifier;
    let first = true;
    const slowCreate: DraftClarifier = { ...inner, create: async (input) => { if (first) { first = false; await gate.promise; } return inner.create(input); } };
    const old = new WorkflowDraftService({ ...h.deps, clarifier: slowCreate });
    const creating = old.create(OWNER, { goal: 'g' });
    await tick();
    const runId = onlyRunId();
    // Another process (a restarted daemon; the holder of that reservation is
    // gone) drops it and starts its own session.
    const fresh = new WorkflowDraftService({ ...h.deps, isHolderAlive: () => false });
    expect((await fresh.view(runId)).clarify.pending).toBe(false);
    await fresh.continueClarify(runId, OWNER);
    gate.resolve();
    await creating;
    const draft = readWorkflowDraft(join(base, runId))!;
    const kept = draft.clarify.sessionId!;
    expect(h.clarify.sessions.get(kept)!.closed).toBe(false);
    expect([...h.clarify.sessions.entries()].filter(([id]) => id !== kept).map(([, session]) => session.closed)).toEqual([true]);
  });

  it('a reservation left by a previous process is dropped; one held by this process is not timed out', async () => {
    const h = makeService(base);
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    h.clarify.reply('q?');
    await h.service.view(runId);
    const runDir = join(base, runId);
    const draft = readWorkflowDraft(runDir)!;
    writeWorkflowDraft(runDir, { ...draft, clarify: { ...draft.clarify, pending: { triggerId: 'reserve:from-a-dead-process', sentAt: draft.updatedAt } } });
    expect((await h.service.view(runId)).clarify.pending).toBe(false);
  });
});

describe('reservation holders and call timeouts', () => {
  it('a reservation held by another live process is not dropped; the other process gets clarify_turn_running', async () => {
    const h = makeService(base);
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    h.clarify.reply('q?');
    await h.service.view(runId);
    const gate = deferred();
    const inner = h.clarify.clarifier;
    let slow = true;
    const a = new WorkflowDraftService({ ...h.deps, clarifier: { ...inner, send: async (input) => { if (slow) { slow = false; await gate.promise; } return inner.send(input); } } });
    const b = new WorkflowDraftService(h.deps);
    const tabA = code(a.sendMessage(runId, OWNER, { text: 'A' }));
    await tick();
    expect((await b.view(runId)).clarify.pending).toBe(true);
    expect(await code(b.sendMessage(runId, OWNER, { text: 'B' }))).toBe('clarify_turn_running');
    gate.resolve();
    expect(await tabA).toBe('ok');
    expect(h.clarify.sessions.get('sess-1')!.prompts.slice(1)).toEqual(['A']);
  });

  it('a reservation of this very instance that is no longer in flight is dropped, even though its process is alive', async () => {
    const h = makeService(base);
    const gate = deferred();
    const inner = h.clarify.clarifier;
    const service = new WorkflowDraftService({ ...h.deps, clarifier: { ...inner, create: async (input) => { await gate.promise; return inner.create(input); } } });
    const creating = service.create(OWNER, { goal: 'g' });
    await tick();
    const runId = onlyRunId();
    const runDir = join(base, runId);
    const ownHolder = readWorkflowDraft(runDir)!.clarify.pending!.holder!;
    gate.resolve();
    await creating;
    h.clarify.reply('q?');
    await service.view(runId);
    // e.g. a send whose second step could not be written
    const draft = readWorkflowDraft(runDir)!;
    writeWorkflowDraft(runDir, { ...draft, clarify: { ...draft.clarify, pending: { triggerId: 'reserve:lost-second-step', sentAt: draft.updatedAt, holder: ownHolder } } });
    expect((await service.view(runId)).clarify.pending).toBe(false);
  });

  it('a send that never returns gives up after the call timeout: reservation released, a system turn says so', async () => {
    const h = makeService(base);
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    h.clarify.reply('q?');
    await h.service.view(runId);
    const inner = h.clarify.clarifier;
    const service = new WorkflowDraftService({ ...h.deps, clarifier: { ...inner, send: () => new Promise(() => {}) } });
    const stuck = code(service.sendMessage(runId, OWNER, { text: 'A' }));
    await tick();
    expect(await code(service.sendMessage(runId, OWNER, { text: 'x' }))).toBe('clarify_turn_running');
    h.timers.fire();
    expect(await stuck).toBe('clarify_unavailable');
    const view = await service.view(runId);
    expect(view.clarify.pending).toBe(false);
    expect(view.clarify.turns.at(-1)).toMatchObject({ role: 'system', text: expect.stringContaining('A') });
    const fine = new WorkflowDraftService(h.deps);
    expect(await code(fine.sendMessage(runId, OWNER, { text: 'again' }))).toBe('ok');
  });

  it('a session create that answers after the timeout is closed when it lands', async () => {
    const h = makeService(base);
    const gate = deferred();
    const inner = h.clarify.clarifier;
    const service = new WorkflowDraftService({ ...h.deps, clarifier: { ...inner, create: async (input) => { await gate.promise; return inner.create(input); } } });
    const creating = service.create(OWNER, { goal: 'g' });
    await tick();
    h.timers.fire();
    const view = await creating;
    expect(view.clarify).toMatchObject({ state: 'disconnected', pending: false });
    gate.resolve();
    await vi.waitFor(() => expect(sessionStates(h)).toEqual([true]));
  });

  it('a session restarting / being retired answers busy; nothing is recorded as sent', async () => {
    const h = makeService(base);
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    h.clarify.reply('q?');
    await h.service.view(runId);
    const service = new WorkflowDraftService({ ...h.deps, clarifier: { ...h.clarify.clarifier, send: async () => ({ ok: false, error: 'lifecycle', disconnected: false, busy: true }) } });
    const before = (await service.view(runId)).clarify.turns.length;
    expect(await code(service.sendMessage(runId, OWNER, { text: 'x' }))).toBe('busy');
    const view = await service.view(runId);
    expect(view.clarify).toMatchObject({ state: 'active', pending: false });
    expect(view.clarify.error).toBeUndefined();
    expect(view.clarify.turns.length).toBe(before);
  });
});

describe('a lost outcome that did succeed', () => {
  it('healing a draft whose grill reached 待确认流程 records success and a new flow revision, not an interruption', async () => {
    const h = makeService(base);
    const runId = await specApproved(h);
    await h.service.startArchitect(runId, OWNER);
    await architectSettled(h.service, runId);
    const runDir = join(base, runId);
    const draft = readWorkflowDraft(runDir)!;
    // The success record was lost: the draft still says 编排中.
    writeWorkflowDraft(runDir, { ...draft, architect: { ...draft.architect!, state: 'running' }, flowRevision: 0 });
    const view = await h.service.view(runId);
    expect(view).toMatchObject({ phase: 'dag_ready', architect: { state: 'succeeded' } });
    expect(view.architect!.problems).toBeUndefined();
    expect(view.flowRevision).toBe(1);
    expect(await code(h.service.approveFlow(runId, OWNER, { flowSummarySha256: view.flow!.flowSummarySha256 }))).toBe('ok');
  });
});

describe('a slow send', () => {
  it('is not overtaken: no second send, no suspension in the middle, and its reply is kept', async () => {
    const h = makeService(base);
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    h.clarify.reply('q?');
    await h.service.view(runId);
    h.advance(40 * 60_000);
    const gate = deferred();
    const inner = h.clarify.clarifier;
    let slow = true;
    const suspend = vi.fn((sessionId: string) => inner.suspend(sessionId));
    const service = new WorkflowDraftService({ ...h.deps, clarifier: {
      ...inner,
      send: async (input) => { if (slow) { slow = false; await gate.promise; } return inner.send(input); },
      suspend,
    } });
    const tab1 = service.sendMessage(runId, OWNER, { text: 'A' });
    await tick();
    h.advance(3 * 60_000);
    expect(await service.sweepIdleClarify()).toEqual([]);
    expect(suspend).not.toHaveBeenCalled();
    expect(await code(service.sendMessage(runId, OWNER, { text: 'B' }))).toBe('clarify_turn_running');
    gate.resolve();
    expect(await code(tab1)).toBe('ok');
    h.clarify.reply('回复 A');
    const turns = (await service.view(runId)).clarify.turns.map((turn) => `${turn.role}:${turn.text}`);
    expect(turns.slice(-2)).toEqual(['user:A', 'assistant:回复 A']);
  });

  it('displaced meanwhile (the draft was abandoned): reported as a conflict, not as sent', async () => {
    const h = makeService(base);
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    h.clarify.reply('q?');
    await h.service.view(runId);
    const gate = deferred();
    const inner = h.clarify.clarifier;
    const service = new WorkflowDraftService({ ...h.deps, clarifier: { ...inner, send: async (input) => { await gate.promise; return inner.send(input); } } });
    const tab1 = code(service.sendMessage(runId, OWNER, { text: 'A' }));
    await tick();
    await service.abandon(runId, OWNER);
    gate.resolve();
    expect(await tab1).toBe('state_conflict');
  });
});

describe('closing sessions and deleting drafts', () => {
  it('a close that fails on abandon is remembered on the draft and retried by the sweep', async () => {
    const h = makeService(base);
    const inner = h.clarify.clarifier;
    let refuse = true;
    const service = new WorkflowDraftService({ ...h.deps, clarifier: { ...inner, close: async (input) => { if (refuse) throw new Error('close refused'); return inner.close(input); } } });
    const { runId } = await service.create(OWNER, { goal: 'g' });
    await service.abandon(runId, OWNER);
    expect(readWorkflowDraft(join(base, runId))!.orphanSessions).toEqual([{ sessionId: 'sess-1', headlessId: expect.any(String) }]);
    expect(sessionStates(h)).toEqual([false]);
    refuse = false;
    // A fresh process (in-memory list gone) still finds it on the draft.
    const fresh = new WorkflowDraftService({ ...h.deps, clarifier: inner });
    await fresh.sweepIdleClarify();
    await fresh.sweepIdleClarify();
    expect(sessionStates(h)).toEqual([true]);
    expect(readWorkflowDraft(join(base, runId))!.orphanSessions).toBeUndefined();
  });

  it('the run dir stays until its sessions are closed (a process dying in between leaves a marked dir, never a leaked session)', async () => {
    const h = makeService(base);
    const hang = deferred();
    const inner = h.clarify.clarifier;
    let holdClose = false;
    const service = new WorkflowDraftService({ ...h.deps, clarifier: { ...inner, close: async (input) => { if (holdClose) await hang.promise; return inner.close(input); } } });
    const { runId } = await service.create(OWNER, { goal: 'g' });
    h.advance(31 * 24 * 60 * 60_000);
    holdClose = true;
    void service.delete(runId, OWNER);
    await tick();
    // The process "dies" here: the session is still open, the dir is still there.
    expect(existsSync(join(base, runId))).toBe(true);
    expect(sessionStates(h)).toEqual([false]);
    const next = new WorkflowDraftService({ ...h.deps, clarifier: inner });
    await next.sweepIdleClarify();
    expect(sessionStates(h)).toEqual([true]);
    expect(existsSync(join(base, runId))).toBe(false);
    hang.resolve();
  });

  it('a delete whose session close is refused keeps the marked dir and the failed id on disk until a later sweep closes it', async () => {
    const h = makeService(base);
    const inner = h.clarify.clarifier;
    const refusing = new WorkflowDraftService({ ...h.deps, clarifier: { ...inner, close: async () => { throw new Error('close refused'); } } });
    const { runId } = await refusing.create(OWNER, { goal: 'g' });
    h.advance(31 * 24 * 60 * 60_000);
    await refusing.delete(runId, OWNER);
    const runDir = join(base, runId);
    expect(existsSync(runDir)).toBe(true);
    expect(readWorkflowDraft(runDir)).toMatchObject({ deletedAt: expect.any(String), orphanSessions: [{ sessionId: 'sess-1' }] });
    expect(listWorkflowDrafts(base)).toEqual([]);
    // After a restart (nothing in memory) the next boot finishes it.
    const next = new WorkflowDraftService({ ...h.deps, clarifier: inner });
    next.recoverInterrupted();
    await vi.waitFor(() => expect(existsSync(runDir)).toBe(false));
    expect(sessionStates(h)).toEqual([true]);
  });

  it('a delete interrupted after its mark is finished by a repeated delete, the boot recovery or the sweep', async () => {
    for (const finish of ['delete', 'recover', 'sweep'] as const) {
      rmSync(base, { recursive: true, force: true });
      base = mkdtempSync(join(tmpdir(), 'wf-drafts-races-'));
      const h = makeService(base);
      const { runId } = await h.service.create(OWNER, { goal: 'g' });
      const runDir = join(base, runId);
      const draft = readWorkflowDraft(runDir)!;
      // The process died right after writing the mark.
      writeWorkflowDraft(runDir, { ...draft, deletedAt: draft.updatedAt, clarify: { ...draft.clarify, pending: undefined } });
      expect(listWorkflowDrafts(base)).toEqual([]);
      expect(workflowDraftOwner(base, runId)).toBe(draft.orchestratorAppId);
      const fresh = new WorkflowDraftService(h.deps);
      if (finish === 'delete') await fresh.delete(runId, OWNER);
      else if (finish === 'recover') { fresh.recoverInterrupted(); await vi.waitFor(() => expect(existsSync(runDir)).toBe(false)); }
      else await fresh.sweepIdleClarify();
      expect(existsSync(runDir), finish).toBe(false);
      expect(sessionStates(h), finish).toEqual([true]);
    }
  });
});

describe('idle sweep', () => {
  it('idle time counts from the reply, not from the message', async () => {
    const h = makeService(base);
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    h.advance(31 * 60_000);
    h.clarify.reply('第一个问题？');
    expect(await h.service.sweepIdleClarify()).toEqual([]);
    expect(readWorkflowDraft(join(base, runId))!.clarify.state).toBe('active');
    h.advance(31 * 60_000);
    expect(await h.service.sweepIdleClarify()).toEqual([runId]);
  });

  it('a process that cannot be released is tried once per idle period, not every sweep', async () => {
    const h = makeService(base);
    const suspend = vi.fn(() => false);
    const service = new WorkflowDraftService({ ...h.deps, clarifier: { ...h.clarify.clarifier, suspend } });
    const { runId } = await service.create(OWNER, { goal: 'g' });
    h.clarify.reply('q?');
    await service.view(runId);
    for (let i = 0; i < 6; i++) { h.advance(31 * 60_000); await service.sweepIdleClarify(); }
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(readWorkflowDraft(join(base, runId))!.clarify).toMatchObject({ state: 'active', suspendRefusedAt: expect.any(String) });
    await service.sendMessage(runId, OWNER, { text: 'x' });
    h.clarify.reply('y');
    await service.view(runId);
    h.advance(31 * 60_000);
    await service.sweepIdleClarify();
    expect(suspend).toHaveBeenCalledTimes(2);
  });

  it('the release runs outside the lock; a message meanwhile is refused as busy, not lost', async () => {
    const h = makeService(base);
    const gate = deferred<boolean>();
    const service = new WorkflowDraftService({ ...h.deps, clarifier: { ...h.clarify.clarifier, suspend: () => gate.promise } });
    const { runId } = await service.create(OWNER, { goal: 'g' });
    h.clarify.reply('q?');
    await service.view(runId);
    h.advance(31 * 60_000);
    const sweeping = service.sweepIdleClarify();
    await tick();
    expect(await code(service.sendMessage(runId, OWNER, { text: 'x' }))).toBe('busy');
    expect((await service.view(runId)).version).toBeGreaterThan(0); // reads are not blocked
    gate.resolve(true);
    expect(await sweeping).toEqual([runId]);
    expect(await code(service.sendMessage(runId, OWNER, { text: 'x' }))).toBe('ok');
  });
});

describe('production clarifier: releasing a process', () => {
  function harness(ds: Record<string, unknown>) {
    const calls: string[] = [];
    const clarifier = createProductionDraftClarifier({
      activeSessions: () => new Map([['k', ds as any]]),
      createHeadlessSession: async () => ({ ok: false, error: 'unused' }),
      triggerSessionTurn: async () => ({ ok: false }),
      lookupTriggerResult: () => ({ ok: true }),
      sessionStatus: () => 'active',
      suspendWorker: () => { calls.push('suspend'); return true; },
      isSuspendable: (session) => (session as any).backend === 'tmux',
      canRetireWorker: (session) => (session as any).backend !== 'riff',
      killWorker: () => { calls.push('kill'); },
      lifecycleInFlight: (session) => (session as any).retiring === true,
      closeSession: async () => ({ ok: false, error: 'refused' }),
      deleteHeadlessRecord: () => { calls.push('delete-record'); },
    });
    return { clarifier, calls };
  }
  const live = (backend: string) => ({ session: { sessionId: 's1' }, worker: { killed: false }, backend, hasHistory: false });

  it('a suspendable backend is suspended; a pty backend is retired for a cold resume; a remote one is left alone', async () => {
    const tmux = harness(live('tmux'));
    expect(await tmux.clarifier.suspend('s1')).toBe(true);
    expect(tmux.calls).toEqual(['suspend']);
    const ptyDs = live('pty');
    const pty = harness(ptyDs);
    expect(await pty.clarifier.suspend('s1')).toBe(true);
    expect(pty.calls).toEqual(['kill']);
    expect(ptyDs.hasHistory).toBe(true);
    const riff = harness(live('riff'));
    expect(await riff.clarifier.suspend('s1')).toBe(false);
    expect(riff.calls).toEqual([]);
  });

  it('a turn sent while the session\'s worker is being retired is refused as busy, not raced into the dying process', async () => {
    const ds = { ...live('pty'), retiring: true };
    const { clarifier } = harness(ds);
    expect(await clarifier.send({ larkAppId: 'app', sessionId: 's1', headlessId: 'hl_x', prompt: 'p', requestId: 'r' }))
      .toMatchObject({ ok: false, busy: true, disconnected: false });
  });

  it('a refused close is an error (so the draft keeps the id) and the record is not deleted', async () => {
    const { clarifier, calls } = harness(live('tmux'));
    await expect(clarifier.close({ sessionId: 's1', headlessId: 'hl_x' })).rejects.toThrow(/close refused/);
    expect(calls).toEqual([]);
  });
});
