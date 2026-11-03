/**
 * P3-2: a gate click racing a runtime flow edit. The click wins the wait's
 * compare-and-set, the edit lands before the click's journal append (and
 * supersedes the gated node). The decision must not count: the wait reads
 * voided, the card freezes as void, and the node re-gates under its new
 * definition.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooks = vi.hoisted(() => ({ afterCas: undefined as undefined | (() => void) }));

vi.mock('../src/workflows/v3/human-gate.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/workflows/v3/human-gate.js')>();
  return {
    ...original,
    resolveWaitOnce: (...args: Parameters<typeof original.resolveWaitOnce>) => {
      const result = original.resolveWaitOnce(...args);
      const hook = hooks.afterCas;
      hooks.afterCas = undefined;
      hook?.();
      return result;
    },
  };
});

import { artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce } from '../src/workflows/v3/run-envelope.js';
import { createV3GateRunner } from '../src/workflows/v3/daemon-run.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { readWait } from '../src/workflows/v3/human-gate.js';
import { applyV3RunEdit, decideV3RevisionProposal } from '../src/workflows/v3/run-edit.js';
import { handleV3GateAction } from '../src/im/lark/v3-gate-card-handler.js';
import { V3_GATE_APPROVE_ACTION, v3GateCardNonce } from '../src/im/lark/v3-gate-card.js';
import type { RunNode } from '../src/workflows/v3/contract.js';

const INITIATOR = 'ou_initiator';
const BINDING = { larkAppId: 'cli_owner', chatId: 'oc_chat', rootMessageId: 'om_root', ownerOpenId: INITIATOR };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function seed(base: string, runId: string): string {
  const runDir = join(base, runId);
  mkdirSync(runDir, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(join(runDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write('dag.json', {
    schemaVersion: 2, runId,
    nodes: [
      { id: 'g', type: 'goal', goal: 'ship', bot: 'cli_w', depends: [], inputs: [], humanGate: { prompt: 'ship?' } },
      { id: 'z', type: 'goal', goal: 'other work', bot: 'cli_w', depends: ['g'], inputs: [] },
    ],
  });
  write('spec.json', {
    schemaVersion: 1, runId, title: 't', requirement: 'r',
    nodes: [{ sketchId: 'g', goal: 'g', input_needs: [], expected_outputs: ['o'], acceptance: 'x', risk_gate: true, unknowns: [] }],
  });
  write('bots.snapshot.json', { cli_w: { larkAppId: 'cli_w', cliId: 'claude-code', workingDir: '/w' } });
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId, createdAt: '2026-11-03T08:00:00.000Z', authorizedAt: '2026-11-03T08:01:00.000Z',
    authorizedByOpenId: INITIATOR, chatBinding: BINDING,
    artifacts: { dag: artifactRef(runDir, 'dag.json'), spec: artifactRef(runDir, 'spec.json'), botSnapshots: artifactRef(runDir, 'bots.snapshot.json') },
  }));
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId });
  return runDir;
}

describe('gate click racing a flow edit', () => {
  it('the click that lost the race to the journal is voided, not approved', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-gate-race-'));
    dirs.push(base);
    const runDir = seed(base, 'run-race');
    const posted: string[] = [];
    const runNode: RunNode = async () => { throw new Error('the gated work must not run'); };
    const runner = createV3GateRunner({
      baseDir: base, loadBots: () => [], makeRunNode: () => runNode,
      postCard: async (_binding, gate) => { posted.push(gate.waitId); },
    });
    await runner.drive('run-race');
    expect(posted).toEqual(['g#001-gate']);

    hooks.afterCas = () => {
      expect(applyV3RunEdit({
        baseDir: base, runId: 'run-race', baseRevision: 1,
        patch: [{ op: 'updateNode', nodeId: 'g', set: { goal: 'ship the hotfix instead' } }],
        caller: { openId: INITIATOR, origin: 'human' },
        resolveNewBotSnapshot: () => { throw new Error('no new bots'); },
      })).toMatchObject({ kind: 'applied' });
    };
    const card = await handleV3GateAction({
      action: V3_GATE_APPROVE_ACTION, runId: 'run-race', waitId: 'g#001-gate', nodeId: 'g',
      nonce: v3GateCardNonce('run-race', 'g#001-gate'),
    }, INITIATOR, { baseDir: base, driveRun: () => {} }) as { elements?: Array<{ actions?: Array<{ value?: unknown }> }> };
    expect(hooks.afterCas).toBeUndefined();
    expect(card.elements?.some((element) => element.actions?.some((action) => action.value !== undefined))).toBe(false);
    expect(readWait(runDir, 'g#001-gate')?.status).toBe('voided');
    expect(readJournal(join(runDir, 'journal.ndjson')).some((event) => event.type === 'gateResolved')).toBe(false);

    await runner.drive('run-race');
    expect(posted).toEqual(['g#001-gate', 'g#002-gate']);
  });
});

describe('gate click racing the removal of its node', () => {
  it('the click CAS wins, then a confirmed removal of the gated node lands: the click is voided', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-gate-race-rm-'));
    dirs.push(base);
    const runDir = seed(base, 'run-race-rm');
    const posted: string[] = [];
    const runner = createV3GateRunner({
      baseDir: base, loadBots: () => [], makeRunNode: () => async () => { throw new Error('must not run'); },
      postCard: async (_binding, gate) => { posted.push(gate.waitId); },
    });
    await runner.drive('run-race-rm');
    expect(posted).toEqual(['g#001-gate']);
    // Removing a node whose gate has not been passed needs the initiator.
    expect(applyV3RunEdit({
      baseDir: base, runId: 'run-race-rm', baseRevision: 1,
      patch: [{ op: 'removeNode', nodeId: 'g' }, { op: 'setDepends', nodeId: 'z', depends: [] }],
      // The main bot's own turn: deleting an unpassed gate still needs the card.
      caller: { openId: INITIATOR, origin: 'runEvent' },
      resolveNewBotSnapshot: () => { throw new Error('no new bots'); },
    })).toMatchObject({ kind: 'proposed' });
    hooks.afterCas = () => {
      expect(decideV3RevisionProposal({ baseDir: base, runId: 'run-race-rm', revision: 2, decision: 'approve', by: INITIATOR }))
        .toMatchObject({ kind: 'approved' });
    };
    const card = await handleV3GateAction({
      action: V3_GATE_APPROVE_ACTION, runId: 'run-race-rm', waitId: 'g#001-gate', nodeId: 'g',
      nonce: v3GateCardNonce('run-race-rm', 'g#001-gate'),
    }, INITIATOR, { baseDir: base, driveRun: () => {} }) as { elements?: Array<{ actions?: Array<{ value?: unknown }> }> };
    expect(hooks.afterCas).toBeUndefined();
    expect(card.elements?.some((element) => element.actions?.some((action) => action.value !== undefined))).toBe(false);
    expect(readWait(runDir, 'g#001-gate')?.status).toBe('voided');
    expect(readJournal(join(runDir, 'journal.ndjson')).some((event) => event.type === 'gateResolved')).toBe(false);
  });
});
