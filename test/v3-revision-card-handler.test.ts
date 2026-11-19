/**
 * App/group scoping on the runtime-revision cards (design §13.1): an open_id
 * equality with the run initiator alone is app-scoped — the click must ALSO
 * pass the owning app/group gate (canOperate), exactly like the gate,
 * blocked, loop-grant and revisit-grant cards. Both the revision decision
 * (同意/拒绝) and the rerun-budget grant enforce it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  artifactRef,
  makeAdHocRunEnvelope,
  publishRunEnvelopeOnce,
} from '../src/workflows/v3/run-envelope.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { applyV3RunEdit, readV3RevisionWait } from '../src/workflows/v3/run-edit.js';
import { handleV3RevisionAction } from '../src/im/lark/v3-revision-card-handler.js';
import {
  V3_REVISION_APPROVE_ACTION,
  V3_REVISION_RERUN_GRANT_ACTION,
  v3RerunGrantCardNonce,
  v3RevisionCardNonce,
} from '../src/im/lark/v3-revision-card.js';
import type { RunChatBinding } from '../src/workflows/v3/grill-state.js';

const INITIATOR = 'ou_initiator';
const BINDING: RunChatBinding = {
  larkAppId: 'cli_owner',
  chatId: 'oc_chat',
  rootMessageId: 'om_root',
  ownerOpenId: INITIATOR,
};

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function seedRunWithProposal(): { base: string; runId: string } {
  const base = mkdtempSync(join(tmpdir(), 'v3-revision-card-handler-'));
  dirs.push(base);
  const runId = 'run-rev-card';
  const runDir = join(base, runId);
  mkdirSync(runDir, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(join(runDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write('dag.json', {
    schemaVersion: 2, runId,
    nodes: [{ id: 'a', type: 'goal', goal: 'orig', bot: 'cli_worker', depends: [], inputs: [] }],
  });
  write('spec.json', {
    schemaVersion: 1, runId, title: 't', requirement: 'r',
    nodes: [{ sketchId: 'a', goal: 'a', input_needs: [], expected_outputs: ['o'], acceptance: 'x', risk_gate: false, unknowns: [] }],
  });
  write('bots.snapshot.json', { cli_worker: { larkAppId: 'cli_worker', cliId: 'claude-code', workingDir: '/w' } });
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId,
    createdAt: '2026-11-03T08:00:00.000Z',
    authorizedAt: '2026-11-03T08:01:00.000Z',
    authorizedByOpenId: INITIATOR,
    chatBinding: BINDING,
    artifacts: {
      dag: artifactRef(runDir, 'dag.json'),
      spec: artifactRef(runDir, 'spec.json'),
      botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
    },
  }));
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId });
  // A non-initiator files the proposal (always waits for the card).
  const outcome = applyV3RunEdit({
    baseDir: base, runId, baseRevision: 1,
    patch: [{ op: 'updateNode', nodeId: 'a', set: { goal: 'changed by member' } }],
    caller: { openId: 'ou_member', origin: 'human' },
    resolveNewBotSnapshot: () => { throw new Error('no new bots'); },
  });
  expect(outcome).toMatchObject({ kind: 'proposed', revision: 2 });
  return { base, runId };
}

describe('流程修改确认卡：点击先过发卡应用/群的 canOperate', () => {
  it('canResolve=false 时，即使操作人字符串等于发起人也不能确认；提案保持 pending', async () => {
    const { base, runId } = seedRunWithProposal();
    const reply = await handleV3RevisionAction(
      {
        action: V3_REVISION_APPROVE_ACTION,
        runId,
        revision: 2,
        nonce: v3RevisionCardNonce(runId, 2),
      },
      INITIATOR,
      {
        baseDir: base,
        driveRun: () => { throw new Error('a refused click must not drive'); },
        // E.g. the click reached a daemon of a different app (the ids are
        // app-scoped and would collide by string only).
        canResolve: () => false,
      },
    ) as { toast?: { content: string } };
    expect(reply.toast?.content).toContain('没有权限');
    expect(readV3RevisionWait(join(base, runId), 2)?.status).toBe('pending');
    expect(readJournal(join(base, runId, 'journal.ndjson')).some((e) => e.type === 'dagRevised')).toBe(false);
  });

  it('canResolve=true 且操作人是发起人：确认生效', async () => {
    const { base, runId } = seedRunWithProposal();
    let driven = false;
    const reply = await handleV3RevisionAction(
      {
        action: V3_REVISION_APPROVE_ACTION,
        runId,
        revision: 2,
        nonce: v3RevisionCardNonce(runId, 2),
      },
      INITIATOR,
      {
        baseDir: base,
        driveRun: () => { driven = true; },
        canResolve: (binding, openId) => binding?.larkAppId === BINDING.larkAppId
          && binding.chatId === BINDING.chatId && openId === INITIATOR,
      },
    );
    expect(reply).not.toHaveProperty('toast');
    expect(readV3RevisionWait(join(base, runId), 2)?.status).toBe('approved');
    expect(driven).toBe(true);
  });

  it('追加重做额度卡同样先过 canResolve，不通过则不授予', async () => {
    const { base, runId } = seedRunWithProposal();
    const reply = await handleV3RevisionAction(
      {
        action: V3_REVISION_RERUN_GRANT_ACTION,
        runId,
        nodeId: 'a',
        tier: 'pair',
        epoch: 0,
        nonce: v3RerunGrantCardNonce(runId, 'a', 'pair', 0),
      },
      INITIATOR,
      { baseDir: base, driveRun: () => {}, canResolve: () => false },
    ) as { toast?: { content: string } };
    expect(reply.toast?.content).toContain('没有权限');
    expect(readJournal(join(base, runId, 'journal.ndjson')).some((e) => e.type === 'revisitBudgetGranted')).toBe(false);
    // And the binding handed to canResolve is the run's own app/group.
    let seen: RunChatBinding | undefined;
    await handleV3RevisionAction(
      {
        action: V3_REVISION_RERUN_GRANT_ACTION,
        runId, nodeId: 'a', tier: 'pair', epoch: 0,
        nonce: v3RerunGrantCardNonce(runId, 'a', 'pair', 0),
      },
      INITIATOR,
      { baseDir: base, driveRun: () => {}, canResolve: (binding) => { seen = binding; return false; } },
    );
    expect(seen).toMatchObject({ larkAppId: BINDING.larkAppId, chatId: BINDING.chatId });
  });
});
