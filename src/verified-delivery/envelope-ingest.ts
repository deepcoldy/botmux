import type { LedgerHandle } from './ledger.js';
import type { EnvelopeEvidence, ParsedEnvelope } from './envelope.js';
import type { Evidence } from './types.js';

export type DeliveryEnvelopeIngestResult =
  | { outcome: 'unknown_task'; taskId: string }
  | {
      outcome: 'unauthorized';
      taskId: string;
      allowedOpenIds: string[];
      allowedUnionIds: string[];
    }
  | { outcome: 'report_without_evidence'; taskId: string }
  | { outcome: 'report'; taskId: string; reportId: string; deduped: boolean }
  | { outcome: 'help'; taskId: string; deduped: boolean };

function toLedgerEvidence(evidence: EnvelopeEvidence, ledger: LedgerHandle): Evidence {
  if (evidence.kind === 'inline') return ledger.writeInlineEvidence(evidence.text, evidence.name);
  if (evidence.kind === 'path') return { kind: 'path', path: evidence.path };
  return { kind: 'url', url: evidence.url };
}

/**
 * Authorize and append one already-parsed delivery envelope.
 *
 * Goal-supervisor ownership and transport routing stay in the daemon. This
 * function owns the device-independent part of the protocol: task lookup,
 * union_id/open_id authorization, evidence materialization, and idempotent
 * ledger writes. Keeping that seam explicit lets the dual-deployment regression
 * exercise the exact production ingestion path without a second parser.
 */
export function ingestParsedDeliveryEnvelope(input: {
  envelope: ParsedEnvelope;
  ledger: LedgerHandle;
  goalChatId: string;
  senderOpenId: string;
  senderUnionId?: string;
  messageId: string;
  now: number;
}): DeliveryEnvelopeIngestResult {
  const { envelope, ledger, goalChatId, senderOpenId, messageId } = input;
  const task = ledger.task(envelope.taskId);
  if (!task || task.chatId !== goalChatId) {
    return { outcome: 'unknown_task', taskId: envelope.taskId };
  }

  const senderUnionId = input.senderUnionId?.trim();
  const allowedUnionIds = (task.workerBotUnionIds ?? []).map((id) => id?.trim()).filter(Boolean);
  const allowedOpenIds = task.workerOpenIds ?? [];
  const authorized = (!!senderUnionId && allowedUnionIds.includes(senderUnionId))
    || allowedOpenIds.includes(senderOpenId);
  if (!authorized) {
    return { outcome: 'unauthorized', taskId: envelope.taskId, allowedOpenIds, allowedUnionIds };
  }

  if (envelope.kind === 'report') {
    if (envelope.evidence.length === 0) {
      return { outcome: 'report_without_evidence', taskId: envelope.taskId };
    }
    const reportId = envelope.reportId?.trim() || `msg:${messageId}`;
    const evidence = envelope.evidence.map((item) => toLedgerEvidence(item, ledger));
    const appended = ledger.append({
      type: 'TaskReported',
      actor: 'worker',
      taskId: envelope.taskId,
      chatId: goalChatId,
      ts: input.now,
      idempotencyKey: envelope.reportId?.trim() ? `reported:${reportId}` : `reported:msg:${messageId}`,
      payload: {
        taskId: envelope.taskId,
        reportId,
        workerOpenId: senderOpenId,
        evidence,
        summary: envelope.summary,
        source: { via: 'envelope', messageId, senderOpenId },
      },
    });
    return { outcome: 'report', taskId: envelope.taskId, reportId, deduped: appended.deduped };
  }

  const appended = ledger.append({
    type: 'TaskHelpRequested',
    actor: 'worker',
    taskId: envelope.taskId,
    chatId: goalChatId,
    ts: input.now,
    idempotencyKey: `help:${envelope.taskId}:msg:${messageId}`,
    payload: {
      taskId: envelope.taskId,
      workerOpenId: senderOpenId,
      blocker: envelope.blocker,
      kind: envelope.helpKind,
      source: { via: 'envelope', messageId, senderOpenId },
    },
  });
  return { outcome: 'help', taskId: envelope.taskId, deduped: appended.deduped };
}
