import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _resetOrdinaryTurnLedgerCacheForTest,
  planOrdinaryTurnRecovery,
} from '../src/services/ordinary-turn-ledger.js';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

const APP = 'cli_fault_injection';
const FIXTURE = resolve('test/fixtures/ordinary-turn-fault-child.ts');
let dataDir: string;

function crashAt(phase: 'received' | 'committed' | 'output'): void {
  const child = spawnSyncTsScript(FIXTURE, [phase, dataDir], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(child.status, `${child.stdout ?? ''}\n${child.stderr ?? ''}`).toBe(73);
  _resetOrdinaryTurnLedgerCacheForTest();
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-ordinary-turn-process-'));
  _resetOrdinaryTurnLedgerCacheForTest();
});

afterEach(() => {
  _resetOrdinaryTurnLedgerCacheForTest();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('ordinary turn hard-crash recovery boundaries', () => {
  it('replays a claim persisted before async routing even though seen was also persisted', () => {
    crashAt('received');
    const plan = planOrdinaryTurnRecovery(dataDir, APP);
    expect(plan.replays.map(record => record.messageId)).toEqual(['om_fault_received']);
    expect(plan.attentions).toEqual([]);
  });

  it('fails closed instead of replaying after the worker commit boundary', () => {
    crashAt('committed');
    const plan = planOrdinaryTurnRecovery(dataDir, APP);
    expect(plan.replays).toEqual([]);
    expect(plan.attentions.map(record => record.messageId)).toEqual(['om_fault_committed']);
    expect(plan.attentions[0].worker).toMatchObject({ generation: 7, committedAt: expect.any(String) });
  });

  it('retains the exact provider UUID when the daemon dies before output ACK', () => {
    crashAt('output');
    const plan = planOrdinaryTurnRecovery(dataDir, APP);
    expect(plan.pendingOutputs).toHaveLength(1);
    expect(plan.pendingOutputs[0].output?.delivery.options?.uuid).toBe('bf_fault_injection_uuid');
    expect(plan.replays).toEqual([]);
  });
});
