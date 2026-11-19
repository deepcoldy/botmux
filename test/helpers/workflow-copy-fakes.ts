/**
 * Source runs for 基于历史创建 tests (design 2026-11-03 §6, D6): a real
 * run.json over real artifacts, a journal, and runtime revisions with their
 * pinned files.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce } from '../../src/workflows/v3/run-envelope.js';
import { appendEvent } from '../../src/workflows/v3/journal.js';
import { v3RevisionDigest, v3RevisionFilePaths } from '../../src/workflows/v3/dag-revision.js';
import { DOC, MAIN, OWNER, SKETCHES, goalNode } from './workflow-draft-fakes.js';

export const REVIEW = 'cli_review';

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Every file under `dir` → its sha256 (the source run's bytes). */
export function treeDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

/**
 * A bot run of MAIN owned by `ownerOpenId`: inspect (MAIN) → write (DOC).
 * `revised`: a runtime revision (2) that took effect adds `review` (REVIEW);
 * `pending`: a further proposal (3) not decided yet (adds `extra`).
 * `reassign`: a blocked-card 改派. `status`: running leaves it unfinished.
 */
export function seedRun(base: string, runId: string, opts: {
  ownerOpenId?: string;
  status?: 'succeeded' | 'running';
  revised?: boolean;
  pending?: boolean;
  reassign?: { nodeId: string; from: string; to: string };
} = {}): string {
  const runDir = join(base, runId);
  mkdirSync(runDir, { recursive: true });
  const nodes = [goalNode('inspect', MAIN), { ...goalNode('write', DOC), depends: ['inspect'] }];
  writeJson(join(runDir, 'dag.json'), { schemaVersion: 2, runId, nodes });
  writeJson(join(runDir, 'spec.json'), {
    schemaVersion: 1, runId, title: '代码风险报告', requirement: '出报告',
    nodes: SKETCHES.map(({ assignee: _a, ...sketch }) => sketch),
  });
  writeJson(join(runDir, 'bots.snapshot.json'), {
    [MAIN]: { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/source' },
    [DOC]: { larkAppId: DOC, cliId: 'claude-code', workingDir: '/source' },
  });
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId,
    createdAt: '2026-11-01T08:00:00.000Z',
    authorizedAt: '2026-11-01T08:01:00.000Z',
    chatBinding: { larkAppId: MAIN, chatId: 'oc_src', chatType: 'group', rootMessageId: 'om_src', ownerOpenId: opts.ownerOpenId ?? OWNER.openId },
    artifacts: {
      dag: artifactRef(runDir, 'dag.json'),
      spec: artifactRef(runDir, 'spec.json'),
      botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
    },
  }));
  const journal = join(runDir, 'journal.ndjson');
  appendEvent(journal, { type: 'runStarted', runId });
  const revise = (revision: number, revisedNodes: unknown[], bots: Record<string, unknown>) => {
    const paths = v3RevisionFilePaths(runDir, revision);
    mkdirSync(join(runDir, 'dag-revisions'), { recursive: true });
    const dag = `${JSON.stringify({ schemaVersion: 2, runId, nodes: revisedNodes }, null, 2)}\n`;
    const patch = `${JSON.stringify({ ops: [] })}\n`;
    const botBytes = `${JSON.stringify(bots, null, 2)}\n`;
    writeFileSync(paths.dag, dag);
    writeFileSync(paths.patch, patch);
    writeFileSync(paths.bots, botBytes);
    return { sha256: v3RevisionDigest(dag), patchSha256: v3RevisionDigest(patch), botsSha256: v3RevisionDigest(botBytes) };
  };
  const revisedNodes = [...nodes, { ...goalNode('review', REVIEW), depends: ['write'] }];
  if (opts.revised) {
    const files = revise(2, revisedNodes, { [REVIEW]: { larkAppId: REVIEW, cliId: 'claude-code', workingDir: '/source' } });
    appendEvent(journal, { type: 'dagRevised', revision: 2, baseRevision: 1, ...files, summary: '加审阅', by: OWNER.openId } as any);
  }
  if (opts.pending) {
    const files = revise(3, [...revisedNodes, goalNode('extra', MAIN)], {});
    appendEvent(journal, { type: 'dagRevisionProposed', revision: 3, baseRevision: 2, ...files, summary: '再加一步', by: 'ou_someone', reasons: ['callerNotInitiator'], touched: [] } as any);
  }
  if (opts.reassign) appendEvent(journal, { type: 'nodeReassigned', ...opts.reassign, by: OWNER.openId });
  if (opts.status !== 'running') appendEvent(journal, { type: 'runSucceeded' });
  return runDir;
}

