/**
 * 「流程修改确认」card messages always end up showing the true state of their
 * proposal (design §13.3, carried proposals), however a carry's card move, a
 * later edit's freeze and the initiator's click interleave with the network
 * round trip of each update. Real run-edit engine, waits and card handler; a
 * fake Lark message store whose updates land only when the test says so.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce } from '../src/workflows/v3/run-envelope.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import {
  applyV3RunEdit,
  readV3RevisionWait,
  recordV3RevisionCardMessage,
  type V3CarriedProposal,
  type V3RunEditCaller,
  type V3VoidedProposal,
} from '../src/workflows/v3/run-edit.js';
import { handleV3RevisionAction } from '../src/im/lark/v3-revision-card-handler.js';
import {
  V3_REVISION_APPROVE_ACTION,
  V3_REVISION_REJECT_ACTION,
  buildV3RevisionCard,
  v3RevisionCardNonce,
} from '../src/im/lark/v3-revision-card.js';
import {
  createV3RevisionCardSync,
  freezeV3VoidedRevisionCard,
  moveV3CarriedRevisionCard,
  v3RevisionCardState,
} from '../src/im/lark/v3-revision-card-sync.js';

const INITIATOR = 'ou_initiator';
const OTHER = 'ou_other_member';
const APP = 'cli_owner';
const BINDING = { larkAppId: APP, chatId: 'oc_chat', rootMessageId: 'om_root', ownerOpenId: INITIATOR };
const initiator: V3RunEditCaller = { openId: INITIATOR, origin: 'human' };
const CARD = 'om_card_2';

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
const goal = (id: string) => ({ id, type: 'goal', goal: `do ${id}`, bot: 'cli_worker', depends: [], inputs: [] });

/** A run with a, b, c and a member's pending proposal for `a` (card {@link CARD}). */
function proposedRun(runId: string) {
  const base = mkdtempSync(join(tmpdir(), 'v3-card-sync-'));
  bases.push(base);
  const runDir = join(base, runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, 'dag.json'), { schemaVersion: 2, runId, nodes: [goal('a'), goal('b'), goal('c')] });
  writeJson(join(runDir, 'spec.json'), {
    schemaVersion: 1, runId, title: 't', requirement: 'r',
    nodes: [{ sketchId: 'a', goal: 'do it', input_needs: [], expected_outputs: ['out'], acceptance: 'done', risk_gate: false, unknowns: [] }],
  });
  writeJson(join(runDir, 'bots.snapshot.json'), { cli_worker: { larkAppId: 'cli_worker', cliId: 'claude-code', workingDir: '/w' } });
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId, createdAt: '2026-11-03T08:00:00.000Z', authorizedAt: '2026-11-03T08:01:00.000Z',
    authorizedByOpenId: INITIATOR, chatBinding: BINDING,
    artifacts: { dag: artifactRef(runDir, 'dag.json'), spec: artifactRef(runDir, 'spec.json'), botSnapshots: artifactRef(runDir, 'bots.snapshot.json') },
  }));
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId });
  const edit = (patch: unknown, baseRevision: number, caller: V3RunEditCaller = initiator) => applyV3RunEdit({
    baseDir: base, runId, patch, baseRevision, caller, resolveNewBotSnapshot: () => { throw new Error('no new bots'); },
  });
  expect(edit([{ op: 'updateNode', nodeId: 'a', set: { goal: 'from member' } }], 1, { openId: OTHER, origin: 'human' }))
    .toMatchObject({ kind: 'proposed', revision: 2 });
  recordV3RevisionCardMessage(runDir, 2, CARD);
  return { base, runDir, runId, edit };
}

/** Fake Lark: an update lands (or fails) only when the test releases it. */
function fakeLark(seed: Record<string, string> = {}) {
  const messages = new Map<string, string>(Object.entries(seed));
  const inFlight: Array<{ messageId: string; card: string; land: () => void; fail: () => void }> = [];
  let maxConcurrent = 0;
  const updateMessage = (_app: string, messageId: string, card: string) => new Promise<void>((resolve, reject) => {
    inFlight.push({
      messageId,
      card,
      land: () => { messages.set(messageId, card); resolve(); },
      fail: () => reject(new Error('lark is down')),
    });
    maxConcurrent = Math.max(maxConcurrent, inFlight.filter((item) => item.messageId === messageId).length);
  });
  const ticks = async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return {
    messages,
    inFlight,
    updateMessage,
    maxConcurrent: () => maxConcurrent,
    ticks,
    /** Land the oldest in-flight update. */
    async landNext(): Promise<void> {
      await ticks();
      inFlight.shift()!.land();
      await ticks();
    },
    /** Land everything (including what landing triggers) until quiet. */
    async drain(): Promise<void> {
      for (let guard = 0; guard < 50; guard++) {
        await ticks();
        const next = inFlight.shift();
        if (!next) return;
        next.land();
      }
      throw new Error('updates never settled');
    },
  };
}

type Card = { elements?: Array<{ actions?: Array<{ value?: { action?: string; revision?: number } }> }> };
/** Revisions the card's buttons decide (empty = no buttons). */
const buttonRevisions = (card: string | undefined): number[] => {
  if (!card) return [];
  const parsed = JSON.parse(card) as Card;
  return [...new Set((parsed.elements ?? []).flatMap((element) => element.actions ?? [])
    .filter((action) => action.value?.action === V3_REVISION_APPROVE_ACTION || action.value?.action === V3_REVISION_REJECT_ACTION)
    .map((action) => action.value!.revision!))];
};
const click = (base: string, runId: string, revision: number, approve = true) => handleV3RevisionAction(
  { action: approve ? V3_REVISION_APPROVE_ACTION : V3_REVISION_REJECT_ACTION, runId, revision, nonce: v3RevisionCardNonce(runId, revision) },
  INITIATOR,
  { baseDir: base, driveRun: () => {} },
);

function harness(run: ReturnType<typeof proposedRun>, lark: ReturnType<typeof fakeLark>) {
  const sync = createV3RevisionCardSync({ runDir: (runId) => join(run.base, runId), updateMessage: lark.updateMessage });
  const posted: number[] = [];
  const move = (carried: V3CarriedProposal[]) => Promise.all(carried.map((item) => moveV3CarriedRevisionCard({
    sync, runDir: run.runDir, runId: run.runId, larkAppId: APP, revision: item.revision, cardMessageIds: item.cardMessageIds,
    post: async () => { posted.push(item.revision); },
  })));
  const freeze = (voided: V3VoidedProposal[]) => Promise.all(voided.map((item) => freezeV3VoidedRevisionCard({
    sync, runId: run.runId, larkAppId: APP, revision: item.revision, cardMessageIds: item.cardMessageIds,
  })));
  /** What the card first posted for revision 2 must show now. */
  const truth = () => v3RevisionCardState(run.runDir, run.runId, 2)!.card;
  return { sync, move, freeze, posted, truth };
}

describe('a carried proposal\'s card shows the true state, whatever lands when', () => {
  it('the initiator taps the old card while the move is in flight: the card settles on the decision, without buttons', async () => {
    const run = proposedRun('run-click-race');
    const lark = fakeLark({ [CARD]: buildV3RevisionCard({ runId: run.runId, view: readV3RevisionWait(run.runDir, 2)!.view }) });
    const h = harness(run, lark);
    const direct = run.edit([{ op: 'updateNode', nodeId: 'b', set: { goal: 'b' } }], 1);
    if (direct.kind !== 'applied') throw new Error(direct.kind);
    const moving = h.move(direct.carriedProposals);
    await lark.ticks();
    expect(lark.inFlight).toHaveLength(1);
    // The click's reply renders in place before the move lands.
    lark.messages.set(CARD, JSON.stringify(await click(run.base, run.runId, 2)));
    await lark.drain();
    expect(await moving).toEqual(['moved']);
    expect(readV3RevisionWait(run.runDir, 4)).toMatchObject({ status: 'approved' });
    expect(buttonRevisions(lark.messages.get(CARD))).toEqual([]);
    expect(lark.messages.get(CARD)).toBe(h.truth());
  });

  it('a second direct edit voids the carried proposal while its move is in flight: the card ends frozen, without buttons', async () => {
    const run = proposedRun('run-void-race');
    const lark = fakeLark();
    const h = harness(run, lark);
    const first = run.edit([{ op: 'updateNode', nodeId: 'b', set: { goal: 'b' } }], 1);
    if (first.kind !== 'applied') throw new Error(first.kind);
    const moving = h.move(first.carriedProposals);
    await lark.ticks();
    const second = run.edit([{ op: 'updateNode', nodeId: 'a', set: { goal: 'a by initiator' } }], 3);
    expect(second).toMatchObject({ kind: 'applied', voidedProposals: [{ revision: 4, cardMessageIds: [CARD] }] });
    if (second.kind !== 'applied') throw new Error(second.kind);
    const freezing = h.freeze(second.voidedProposals);
    await lark.drain();
    expect(await freezing).toEqual(['frozen']);
    await moving;
    expect(readV3RevisionWait(run.runDir, 4)).toMatchObject({ status: 'voided' });
    expect(buttonRevisions(lark.messages.get(CARD))).toEqual([]);
    expect(lark.messages.get(CARD)).toBe(h.truth());
    expect(lark.maxConcurrent()).toBe(1);
  });

  it('two carries in a row: one update in flight per message, and the card ends on the latest version', async () => {
    const run = proposedRun('run-two-carries');
    const lark = fakeLark();
    const h = harness(run, lark);
    const first = run.edit([{ op: 'updateNode', nodeId: 'b', set: { goal: 'b' } }], 1);
    if (first.kind !== 'applied') throw new Error(first.kind);
    const m1 = h.move(first.carriedProposals);
    await lark.ticks();
    const second = run.edit([{ op: 'updateNode', nodeId: 'c', set: { goal: 'c' } }], 3);
    expect(second).toMatchObject({ kind: 'applied', carriedProposals: [{ fromRevision: 4, revision: 6, cardMessageIds: [CARD] }] });
    if (second.kind !== 'applied') throw new Error(second.kind);
    const m2 = h.move(second.carriedProposals);
    await lark.ticks();
    // The later move waits for the earlier one instead of racing it.
    expect(lark.inFlight).toHaveLength(1);
    await lark.drain();
    expect([await m1, await m2]).toEqual([['moved'], ['moved']]);
    expect(lark.maxConcurrent()).toBe(1);
    expect(buttonRevisions(lark.messages.get(CARD))).toEqual([6]);
    expect(lark.messages.get(CARD)).toBe(h.truth());
  });

  it('a click that decided the carried version before the card moved: the move keeps the decision', async () => {
    const run = proposedRun('run-decided-first');
    const lark = fakeLark();
    const h = harness(run, lark);
    const direct = run.edit([{ op: 'updateNode', nodeId: 'b', set: { goal: 'b' } }], 1);
    if (direct.kind !== 'applied') throw new Error(direct.kind);
    lark.messages.set(CARD, JSON.stringify(await click(run.base, run.runId, 2)));
    const moving = h.move(direct.carriedProposals);
    await lark.drain();
    await moving;
    expect(readV3RevisionWait(run.runDir, 4)).toMatchObject({ status: 'approved' });
    expect(buttonRevisions(lark.messages.get(CARD))).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  it('no message to move, or every update failing: a still-pending carried version gets a card of its own', async () => {
    const run = proposedRun('run-no-card');
    const lark = fakeLark();
    const h = harness(run, lark);
    const direct = run.edit([{ op: 'updateNode', nodeId: 'b', set: { goal: 'b' } }], 1);
    if (direct.kind !== 'applied') throw new Error(direct.kind);
    const failing = h.move(direct.carriedProposals);
    await lark.ticks();
    lark.inFlight.shift()!.fail();
    expect(await failing).toEqual(['posted']);
    expect(await h.move([{ ...direct.carriedProposals[0]!, cardMessageIds: [] }])).toEqual(['posted']);
    expect(h.posted).toEqual([4, 4]);
    expect(await h.freeze([{ revision: 4, reason: 'stale', cardMessageIds: [] }])).toEqual(['none']);
    expect(readJournal(join(run.runDir, 'journal.ndjson')).filter((event) => event.type === 'dagRevised')).toHaveLength(1);
  });
});
