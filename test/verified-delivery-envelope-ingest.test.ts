import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestParsedDeliveryEnvelope } from '../src/verified-delivery/envelope-ingest.js';
import { openLedger } from '../src/verified-delivery/ledger.js';

describe('delivery envelope ingestion', () => {
  let baseDir: string;
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'vd-envelope-ingest-')); });
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

  it('rejects report/help envelopes until a planned task is actually dispatched', () => {
    const ledger = openLedger({ baseDir });
    ledger.append({
      type: 'TaskDispatched', actor: 'orchestrator', taskId: 'upstream', chatId: 'oc_goal', ts: 1,
      idempotencyKey: 'dispatched:upstream', payload: { taskId: 'upstream' },
    });
    ledger.append({
      type: 'TaskPlanned', actor: 'orchestrator', taskId: 'downstream', chatId: 'oc_goal', ts: 2,
      idempotencyKey: 'planned:downstream',
      payload: {
        taskId: 'downstream', chatId: 'oc_goal', title: 'Downstream', dependsOnTaskIds: ['upstream'],
        planGeneration: 1, plannedBy: 'supervisor',
        dispatchSpec: {
          title: 'Downstream', briefBase: 'wait for upstream', senderLarkAppId: 'cli_sup',
          workers: [{ openId: 'ou_worker', unionId: 'on_worker' }],
        },
      },
    });

    const base = {
      ledger, goalChatId: 'oc_goal', senderOpenId: 'ou_worker', senderUnionId: 'on_worker', now: 3,
    };
    expect(ingestParsedDeliveryEnvelope({
      ...base, messageId: 'om_report',
      envelope: { kind: 'report', taskId: 'downstream', summary: 'too early', evidence: [{ kind: 'inline', text: 'done' }] },
    })).toEqual({ outcome: 'task_not_dispatched', taskId: 'downstream' });
    expect(ingestParsedDeliveryEnvelope({
      ...base, messageId: 'om_help',
      envelope: { kind: 'help', taskId: 'downstream', blocker: 'too early' },
    })).toEqual({ outcome: 'task_not_dispatched', taskId: 'downstream' });
    expect(ledger.read().map((event) => event.type)).toEqual(['TaskDispatched', 'TaskPlanned']);
  });
});
