/**
 * A bot-executed run on disk, as the main bot's daemon leaves it: a real
 * runtime drove it (node card + handoff sent), the executing bot reported it
 * blocked with a free-text reason, and run.json pins `nodeExecutor: "bot"`
 * (or not, for the ephemeral-worker comparison).
 */

import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce } from '../../src/workflows/v3/run-envelope.js';
import { reportExternalBlocked } from '../../src/workflows/v3/external-control.js';
import { validateDag } from '../../src/workflows/v3/dag.js';
import { BotRun, reportDag } from './v3-external-harness.js';
import { CHAT, MAIN, handoffWorld } from './workflow-handoff-harness.js';

export const SIDEBAR_CHAT = CHAT;
export const SIDEBAR_MAIN = MAIN;
/** Free text that must never reach a member: it is the node's error detail. */
export const SECRET_REASON = 'cannot read /srv/private/token.txt';
export const NODE_GOAL = 'write the report';
/** Goal of a node that was never handed off (nobody in the chat has seen it). */
export const PENDING_GOAL = 'review the report before it ships';

export async function sidebarRun(
  runId: string,
  opts: { nodeExecutor?: 'bot'; chatId?: string; withPendingNode?: boolean } = { nodeExecutor: 'bot' },
) {
  const base = reportDag(runId);
  const dag = opts.withPendingNode
    ? validateDag({
      ...base,
      nodes: [...base.nodes, {
        ...base.nodes[0]!, id: 'review', goal: PENDING_GOAL,
        depends: [{ from: 'write' }],
        outputs: { review: { path: 'review.md', kind: 'markdown' } },
      }],
    })
    : base;
  const run = new BotRun(dag);
  const world = handoffWorld();
  const chatId = opts.chatId ?? CHAT;
  await run.drive(world.executor, { opts: { chatBinding: { larkAppId: MAIN, chatId, chatType: 'group', rootMessageId: 'om_main' } } });
  const attempt = run.openAttempt('write');
  run.accept(attempt.attemptId, 'sess-a');
  reportExternalBlocked(run.runDir, { attemptId: attempt.attemptId, sessionId: 'sess-a', reason: SECRET_REASON });
  writeFileSync(join(run.runDir, 'spec.json'), `${JSON.stringify({ schemaVersion: 1, runId, title: 'Risk report', requirement: 'r', nodes: [] })}\n`);
  publishRunEnvelopeOnce(run.runDir, makeAdHocRunEnvelope({
    runId,
    createdAt: '2026-11-03T00:00:00.000Z',
    authorizedAt: '2026-11-03T00:00:01.000Z',
    chatBinding: { larkAppId: MAIN, chatId, chatType: 'group', rootMessageId: 'om_main' },
    artifacts: {
      dag: artifactRef(run.runDir, 'dag.json'),
      spec: artifactRef(run.runDir, 'spec.json'),
      botSnapshots: artifactRef(run.runDir, 'bots.snapshot.json'),
    },
    ...(opts.nodeExecutor ? { nodeExecutor: opts.nodeExecutor } : {}),
  }));
  return { run, runsDir: run.base, runId };
}

/** Copy a fixture run into another runs dir (e.g. an isolated HOME). */
export function copyRunInto(run: BotRun, runsDir: string): void {
  cpSync(run.runDir, join(runsDir, run.dag.runId), { recursive: true });
}
