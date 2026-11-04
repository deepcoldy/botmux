/**
 * The「工作流 ›」sidebar entry on the flow-revision confirmation card and the
 * rerun-grant card (design 2026-11-03 §11.1), the two main-topic cards of
 * runtime flow edits (#2763):
 *
 *   1. without an entry — every run not pinned to `nodeExecutor: "bot"` —
 *      each card is byte-for-byte what the builder produced before this
 *      change (the fixture holds that output, generated from the previous
 *      builders for the same inputs);
 *   2. with an entry the card is its old self with the「Web 详情（需登录）」
 *      button replaced by the entry, exactly like the progress card;
 *   3. which runs get one is read from run.json, and the posted card, the
 *      click reply and the in-place re-render all ask for it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  buildV3RerunGrantCard,
  buildV3RevisionCard,
  V3_REVISION_APPROVE_ACTION,
  V3_REVISION_RERUN_GRANT_ACTION,
  v3RerunGrantCardNonce,
  v3RevisionCardNonce,
} from '../src/im/lark/v3-revision-card.js';
import { handleV3RevisionAction } from '../src/im/lark/v3-revision-card-handler.js';
import { createV3RevisionCardSync } from '../src/im/lark/v3-revision-card-sync.js';
import { v3RunWorkflowEntry } from '../src/im/lark/v3-progress-card.js';
import { workflowSidebarEntryLink, type WorkflowSidebarEntryLink } from '../src/im/lark/workflow-sidebar-entry.js';
import { appendEvent } from '../src/workflows/v3/journal.js';
import { applyV3RunEdit } from '../src/workflows/v3/run-edit.js';
import type { V3RevisionCardView } from '../src/workflows/v3/run-edit.js';
import { cleanupBotRuns } from './helpers/v3-external-harness.js';
import { REVISABLE_INITIATOR, seedRevisableRun } from './helpers/workflow-revisable-run.js';

/** Builder output before this change, for the inputs below. */
const BEFORE = JSON.parse(readFileSync(resolve('test/fixtures/workflow-sidebar-cards-before.json'), 'utf-8')) as Record<string, string>;

const RUN = 'risk-261103-1010';
const WEB = 'http://127.0.0.1:7891/#/v3/risk-261103-1010';
const ORIGIN = 'https://dash.example.test';
const VIEW: V3RevisionCardView = {
  revision: 3, baseRevision: 2, summary: '+1 节点、改派 1', note: '加一个复核节点',
  reasons: ['newBot', 'callerNotInitiator'],
  changes: {
    added: ['review-wording'], removed: [], changed: [], dependsChanged: [],
    reassigned: [{ nodeId: 'write-report', from: 'cli_doc', to: 'cli_review' }],
    rerun: [], newBots: ['cli_review'], hostNodes: [], gateChanges: [],
  },
  proposedBy: 'ou_member',
};

const CARDS: Array<[string, (entry?: WorkflowSidebarEntryLink) => string]> = [
  ['revisionPending', (e) => buildV3RevisionCard({ runId: RUN, view: VIEW, webDetailUrl: WEB, ...(e ? { workflowEntry: e } : {}) })],
  ['revisionApproved', (e) => buildV3RevisionCard({ runId: RUN, view: VIEW, webDetailUrl: WEB, resolution: { kind: 'approved', by: 'ou_owner' }, ...(e ? { workflowEntry: e } : {}) })],
  ['revisionVoid', (e) => buildV3RevisionCard({ runId: RUN, view: VIEW, webDetailUrl: WEB, resolution: { kind: 'void', detail: '已被新的修改替代' }, ...(e ? { workflowEntry: e } : {}) })],
  ['rerunGrant', (e) => buildV3RerunGrantCard({ runId: RUN, nodeId: 'write-report', tier: 'pair', epoch: 1, webDetailUrl: WEB, ...(e ? { workflowEntry: e } : {}) })],
  ['rerunGrantGranted', (e) => buildV3RerunGrantCard({ runId: RUN, nodeId: 'write-report', tier: 'run', epoch: 2, webDetailUrl: WEB, resolution: { kind: 'granted', by: 'ou_owner' }, ...(e ? { workflowEntry: e } : {}) })],
];

const entryFor = (sidebar: boolean) => (app: string, runId: string) =>
  workflowSidebarEntryLink({ dashboardOrigin: ORIGIN, mainLarkAppId: app, runId, brand: 'feishu', sidebar });

function entryButton(card: string): Record<string, any> | undefined {
  const parsed = JSON.parse(card) as { elements: Array<{ tag: string; actions?: Array<Record<string, any>> }> };
  return parsed.elements.flatMap((el) => el.actions ?? []).find((button) => /工作流 ›/.test(button.text?.content ?? ''));
}

describe('without an entry the revision and rerun-grant cards are byte-identical to before', () => {
  it.each(CARDS)('%s', (name, build) => {
    expect(BEFORE[name]).toBeTypeOf('string');
    expect(build()).toBe(BEFORE[name]);
  });
});

describe('with an entry the「Web 详情」button becomes the entry, byte for byte', () => {
  const SIDEBAR_URL = `${ORIGIN}/workflow/cli_main_app/${RUN}`;
  const SIDEBAR_APPLINK = 'https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&min_width=350&width=800&max_width=1200&reload=false'
    + `&url=https%3A%2F%2Fdash.example.test%2Fworkflow%2Fcli_main_app%2F${RUN}`;
  const BROWSER_URL = `${ORIGIN}/#/workflows/${RUN}`;
  const MULTI_URL = {
    sidebar: { url: SIDEBAR_APPLINK, pc_url: SIDEBAR_APPLINK, android_url: SIDEBAR_URL, ios_url: SIDEBAR_URL },
    browser: { url: BROWSER_URL, pc_url: BROWSER_URL, android_url: BROWSER_URL, ios_url: BROWSER_URL },
  } as const;

  for (const mode of ['sidebar', 'browser'] as const) {
    it.each(CARDS)(`${mode}: %s`, (name, build) => {
      const card = JSON.parse(BEFORE[name]!);
      const actions = card.elements.at(-1).actions;
      expect(actions[0].text.content).toBe('Web 详情（需登录）');
      actions[0] = { tag: 'button', text: { tag: 'plain_text', content: '工作流 ›' }, type: 'default', multi_url: MULTI_URL[mode] };
      expect(build(entryFor(mode === 'sidebar')('cli_main_app', RUN)!)).toBe(JSON.stringify(card));
    });
  }
});

// ─── Which runs get the entry, and that every renderer asks for it ─────────

const INITIATOR = REVISABLE_INITIATOR;

afterEach(() => cleanupBotRuns());

/** A real authorized run; by default with one pending flow-revision
 *  proposal (rev 2) a member filed. */
function seedRun(
  nodeExecutor: 'bot' | undefined,
  opts: { proposal?: boolean; nodes?: string[] } = {},
): { base: string; runId: string; runDir: string } {
  const run = seedRevisableRun(nodeExecutor ? 'rev-card-bot' : 'rev-card-plain', {
    ...(nodeExecutor ? { nodeExecutor } : {}),
    ...(opts.nodes ? { nodes: opts.nodes } : {}),
  });
  if (opts.proposal === false) return run;
  const outcome = applyV3RunEdit({
    baseDir: run.base, runId: run.runId, baseRevision: 1,
    patch: [{ op: 'updateNode', nodeId: 'a', set: { goal: 'changed by member' } }],
    caller: { openId: 'ou_member', origin: 'human' },
    resolveNewBotSnapshot: () => { throw new Error('no new bots'); },
  });
  expect(outcome).toMatchObject({ kind: 'proposed', revision: 2 });
  return run;
}

describe('which runs get the entry on these cards', () => {
  it('only a run whose run.json pins nodeExecutor "bot"; no run.json → none', () => {
    const bot = seedRun('bot');
    const plain = seedRun(undefined);
    expect(v3RunWorkflowEntry(bot.runDir, bot.runId, entryFor(true))?.url).toBe(`${ORIGIN}/workflow/cli_main_app/${bot.runId}`);
    expect(v3RunWorkflowEntry(plain.runDir, plain.runId, entryFor(true))).toBeUndefined();
    expect(v3RunWorkflowEntry(join(plain.base, 'nope'), 'nope', entryFor(true))).toBeUndefined();
  });

  it('the click reply renders the card with the entry for a bot run, and without it otherwise', async () => {
    for (const nodeExecutor of ['bot', undefined] as const) {
      const run = seedRun(nodeExecutor);
      const reply = await handleV3RevisionAction(
        { action: V3_REVISION_APPROVE_ACTION, runId: run.runId, revision: 2, nonce: v3RevisionCardNonce(run.runId, 2) },
        INITIATOR,
        {
          baseDir: run.base,
          driveRun: () => {},
          canResolve: () => true,
          workflowEntry: (runId) => v3RunWorkflowEntry(join(run.base, runId), runId, entryFor(true)),
        },
      );
      const card = JSON.stringify(reply);
      if (nodeExecutor) {
        expect(entryButton(card)?.multi_url.android_url).toBe(`${ORIGIN}/workflow/cli_main_app/${run.runId}`);
        expect(card).not.toContain('Web 详情（需登录）');
      } else {
        expect(entryButton(card)).toBeUndefined();
        expect(card).toContain('Web 详情（需登录）');
      }
    }
  });

  it('the rerun-grant click reply carries the entry on a bot run', async () => {
    const run = seedRun('bot', { proposal: false, nodes: ['a', 'b'] });
    const journalPath = join(run.runDir, 'journal.ndjson');
    const finish = (instanceId: string) => {
      const attemptId = `${instanceId}/attempts/001`;
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'a', instanceId, attemptId });
      appendEvent(journalPath, { type: 'nodeSucceeded', nodeId: 'a', instanceId, attemptId, manifestPath: join(run.runDir, 'm.json') });
    };
    const edit = (baseRevision: number, origin: 'human' | 'runEvent') => applyV3RunEdit({
      baseDir: run.base, runId: run.runId, baseRevision, patch: [{ op: 'rerunNode', nodeId: 'a' }],
      caller: { openId: INITIATOR, origin }, resolveNewBotSnapshot: () => { throw new Error('no new bots'); },
    });
    finish('a#001');
    appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'b', instanceId: 'b#001', attemptId: 'b#001/attempts/001' });
    expect(edit(1, 'human')).toMatchObject({ kind: 'applied', revision: 2 });
    finish('a#002');
    const refused = edit(2, 'runEvent');
    if (refused.kind !== 'invalid' || !refused.rerunBudget) throw new Error(JSON.stringify(refused));
    const { tier, epoch } = refused.rerunBudget;
    const reply = await handleV3RevisionAction(
      { action: V3_REVISION_RERUN_GRANT_ACTION, runId: run.runId, nodeId: 'a', tier, epoch, nonce: v3RerunGrantCardNonce(run.runId, 'a', tier, epoch) },
      INITIATOR,
      {
        baseDir: run.base, driveRun: () => {}, canResolve: () => true,
        workflowEntry: (runId) => v3RunWorkflowEntry(join(run.base, runId), runId, entryFor(true)),
      },
    );
    expect(reply).toMatchObject({ header: { title: { content: '已追加重做额度' } } });
    expect(entryButton(JSON.stringify(reply))?.multi_url.android_url).toBe(`${ORIGIN}/workflow/cli_main_app/${run.runId}`);
  });

  it('the in-place re-render of a posted card keeps the entry', async () => {
    const run = seedRun('bot');
    const updates: string[] = [];
    const sync = createV3RevisionCardSync({
      runDir: (runId) => join(run.base, runId),
      updateMessage: async (_app, _id, card) => { updates.push(card); },
      workflowEntry: (runId) => v3RunWorkflowEntry(join(run.base, runId), runId, entryFor(true)),
    });
    expect(await sync.sync({ runId: run.runId, larkAppId: 'cli_main_app', messageId: 'om_card', revision: 2 })).toMatchObject({ kind: 'shown' });
    expect(entryButton(updates[0]!)?.multi_url.android_url).toBe(`${ORIGIN}/workflow/cli_main_app/${run.runId}`);
  });
});
