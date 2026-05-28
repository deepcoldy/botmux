/**
 * Workflow thin layer for the shared `/api/trigger` boundary.
 *
 * When an external trigger targets `kind=workflow`, map its untrusted event
 * envelope to a workflow run via the existing `triggerWorkflowRun`. The whole
 * event is passed as a single **string** param named `event` (a JSON string),
 * so a webhook-triggerable workflow just declares an `event: string` param and
 * its first subagent reads `${params.event}` as untrusted event data — same
 * pass-through philosophy as turns (the model understands the payload; we don't
 * pre-map per-platform fields here).
 *
 * Pure + deps-injected: the daemon wires `runWorkflow` (the already-configured
 * `triggerWorkflowRun` closure) so this stays unit-testable without the daemon.
 */
import { randomUUID } from 'node:crypto';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';
import type { TriggerInput, TriggerResult } from './trigger-run.js';

export interface EnvelopeWorkflowDeps {
  larkAppId: string;
  /** The daemon-wired triggerWorkflowRun closure (all heavy deps already bound). */
  runWorkflow: (input: TriggerInput) => Promise<TriggerResult>;
  /** Test seam. */
  makeTriggerId?: () => string;
}

/** The well-known param name a webhook-triggerable workflow must declare (type string). */
export const EVENT_PARAM_NAME = 'event';

export async function triggerWorkflowFromEnvelope(
  req: TriggerRequest,
  deps: EnvelopeWorkflowDeps,
): Promise<TriggerResponse> {
  const triggerId = (deps.makeTriggerId ?? (() => `trg_${randomUUID().slice(0, 12)}`))();
  const workflowId = req.target.workflowId;
  const chatId = req.target.chatId;

  if (!workflowId) {
    return { ok: false, triggerId, errorCode: 'target_required', error: 'workflow target requires workflowId' };
  }
  // chatBinding needs a chat to post the workflow's messages into.
  if (!chatId) {
    return { ok: false, triggerId, errorCode: 'target_required', error: 'workflow target requires chatId for chat binding' };
  }

  // The untrusted external event, serialized as a string param. Workflow nodes
  // must treat it as event data, never as instructions.
  const eventJson = JSON.stringify({
    triggerId,
    source: req.source,
    envelope: req.envelope,
    options: req.options ?? {},
  });

  if (req.options?.dryRun) {
    return {
      ok: true,
      triggerId,
      action: 'dry_run',
      target: { kind: 'workflow', chatId },
      message: `dry run: would start workflow "${workflowId}" with param "${EVENT_PARAM_NAME}" (${eventJson.length} bytes)`,
    };
  }

  const result = await deps.runWorkflow({
    workflowId,
    rawParams: { [EVENT_PARAM_NAME]: { kind: 'string', value: eventJson } },
    chatBinding: { chatId, larkAppId: deps.larkAppId },
    initiator: req.source.connectorId ? `webhook:${req.source.connectorId}` : `external:${req.source.type}`,
  });

  if (result.ok) {
    return {
      ok: true,
      triggerId,
      action: 'queued',
      target: { kind: 'workflow', workflowRunId: result.runId, chatId },
      message: `workflow "${workflowId}" run ${result.runId} started`,
    };
  }

  // Map workflow failure → stable trigger errorCode for the UI.
  const errorCode: TriggerResponse['errorCode'] =
    result.error === 'unknown_workflow' || result.error === 'invalid_params'
      ? 'bad_request'
      : 'trigger_failed';
  return { ok: false, triggerId, errorCode, error: result.message };
}
