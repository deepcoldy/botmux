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

import { atomicWriteFile } from '../utils/atomic-write.js';
import { loadBotConfigs } from '../bot-registry.js';
import { canonicalJsonStringify, computeRevisionId } from './definition.js';
import type { WorkflowDefinition } from './definition.js';
import type { EventLog } from './events/append.js';
import type { BotSnapshot, OutputRef } from './events/payloads.js';
import {
  snapshotWorkflowDefinition,
  writeRunChatBinding,
  type RunChatBinding,
} from './loader.js';
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
  /** Chat target used by fan-out to push approval cards for this run. */
  chatBinding?: RunChatBinding;
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
  await snapshotWorkflowDefinition(log.runId, input.def, { runDir: log.runDir });
  if (input.chatBinding) {
    await writeRunChatBinding(log.runId, input.chatBinding, { runDir: log.runDir });
  }

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
  // 原子写：路径即 sha256，裸写半截会留下「名字对、内容错」的 blob。
  await atomicWriteFile(path, buf);
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
        missingBotMessage(node.bot, def.workflowId, out),
      );
    }
    out[node.bot] = snap;
  }
  return out;
}

function missingBotMessage(
  botRef: string,
  workflowId: string,
  resolvedSnapshots: Record<string, BotSnapshot>,
): string {
  const availableIds = new Set<string>();
  for (const snap of Object.values(resolvedSnapshots)) {
    if (snap.larkAppId) availableIds.add(snap.larkAppId);
  }
  try {
    for (const cfg of loadBotConfigs()) availableIds.add(cfg.larkAppId);
  } catch {
    // Missing/invalid bots.json should not hide the original workflow error.
  }

  const idHint = availableIds.size > 0
    ? ` Available bot larkAppIds: ${Array.from(availableIds).join(', ')}.`
    : '';
  return (
    `Bot '${botRef}' referenced in workflow '${workflowId}' not found in registry. ` +
    `Use 'botmux bots list' and set subagent.bot to the bot's larkAppId, not its display name.` +
    idHint
  );
}
