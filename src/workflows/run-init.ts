/**
 * Bootstrap a workflow run.
 *
 * Responsibilities (UI doc §3.4 / §7 landing #1):
 *   1. write the params blob to `runs/<runId>/blobs/<inputHash>`
 *   2. resolve every subagent's `bot` field through the supplied
 *      `botResolver` and freeze the result into `runCreated.botSnapshots`
 *      so future rename in bots.json doesn't drift the historical view
 *   3. append `runCreated` followed by `runStarted`
 *
 * The caller owns the EventLog (it already wrote the workflow.json
 * snapshot to `runs/<runId>/workflow.json` before calling) and drives
 * the orchestrator after `createRun` returns.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { canonicalJsonStringify, computeRevisionId } from './definition.js';
import type { WorkflowDefinition } from './definition.js';
import type { EventLog } from './events/append.js';
import type { BotSnapshot, OutputRef } from './events/payloads.js';
import type {
  RunCreatedEvent,
  RunStartedEvent,
} from './events/types.js';

export type { BotSnapshot };

/**
 * Resolves a `bot` reference (the workflow JSON `bot` field, matching
 * bots.json `name`) into the immutable snapshot to embed in `runCreated`.
 * Return `undefined` if the bot doesn't exist — `createRun` will throw.
 */
export type BotResolver = (botName: string) => BotSnapshot | undefined;

export type CreateRunInput = {
  def: WorkflowDefinition;
  /** Params object passed to the run; written verbatim as the input blob. */
  params: Record<string, unknown>;
  /** open_id / user identifier / 'system' for whoever triggered the run. */
  initiator: string;
  botResolver: BotResolver;
  /**
   * Override computed revisionId.  Useful if caller already hashed the
   * spec (e.g. from a registry cache).  Defaults to `computeRevisionId(def)`.
   */
  revisionId?: string;
};

export type CreateRunResult = {
  runCreatedEvent: RunCreatedEvent;
  runStartedEvent: RunStartedEvent;
  inputRef: OutputRef;
};

export async function createRun(
  log: EventLog,
  input: CreateRunInput,
): Promise<CreateRunResult> {
  const inputRef = await writeRunInputBlob(log, input.params);
  const revisionId = input.revisionId ?? computeRevisionId(input.def);
  const botSnapshots = collectBotSnapshots(input.def, input.botResolver);

  const runCreatedEvent = (await log.append({
    runId: log.runId,
    type: 'runCreated',
    actor: 'system',
    payload: {
      workflowId: input.def.workflowId,
      revisionId,
      inputRef,
      initiator: input.initiator,
      ...(Object.keys(botSnapshots).length > 0 ? { botSnapshots } : {}),
    },
  })) as RunCreatedEvent;

  const runStartedEvent = (await log.append({
    runId: log.runId,
    type: 'runStarted',
    actor: 'scheduler',
    payload: {},
  })) as RunStartedEvent;

  return { runCreatedEvent, runStartedEvent, inputRef };
}

async function writeRunInputBlob(
  log: EventLog,
  params: Record<string, unknown>,
): Promise<OutputRef> {
  const canonical = canonicalJsonStringify(params);
  const buf = Buffer.from(canonical, 'utf-8');
  const hash = createHash('sha256').update(buf).digest('hex');
  const path = join(log.blobDir, hash);
  // Content-addressed: same input ⇒ same path; re-writes are harmless.
  await fs.writeFile(path, buf);
  return {
    outputHash: `sha256:${hash}`,
    outputPath: path,
    outputBytes: buf.length,
    outputSchemaVersion: 1,
    contentType: 'application/json',
  };
}

function collectBotSnapshots(
  def: WorkflowDefinition,
  resolver: BotResolver,
): Record<string, BotSnapshot> {
  const out: Record<string, BotSnapshot> = {};
  for (const node of Object.values(def.nodes)) {
    if (node.type !== 'subagent') continue;
    if (out[node.bot]) continue;
    const snap = resolver(node.bot);
    if (!snap) {
      throw new Error(
        `Bot '${node.bot}' referenced in workflow '${def.workflowId}' not found in registry`,
      );
    }
    out[node.bot] = snap;
  }
  return out;
}
