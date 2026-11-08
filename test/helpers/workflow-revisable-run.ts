/**
 * A real authorized run whose flow can be edited at runtime (design §13):
 * run.json names the initiator, the journal has started, nothing ran yet.
 * Bot-executed (`nodeExecutor: "bot"`) or not.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce } from '../../src/workflows/v3/run-envelope.js';
import { appendEvent } from '../../src/workflows/v3/journal.js';
import { trackTempDir } from './v3-external-harness.js';

export const REVISABLE_INITIATOR = 'ou_initiator';
export const REVISABLE_BINDING = {
  larkAppId: 'cli_main_app', chatId: 'oc_chat', chatType: 'group' as const, rootMessageId: 'om_root', ownerOpenId: REVISABLE_INITIATOR,
};

export function seedRevisableRun(
  runId: string,
  opts: { nodeExecutor?: 'bot'; nodes?: string[] } = {},
): { base: string; runId: string; runDir: string } {
  const base = trackTempDir(mkdtempSync(join(tmpdir(), 'wf-revisable-')));
  const runDir = join(base, runId);
  mkdirSync(runDir, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(join(runDir, name), `${JSON.stringify(value, null, 2)}\n`);
  const ids = opts.nodes ?? ['a'];
  write('dag.json', {
    schemaVersion: 2, runId,
    nodes: ids.map((id) => ({ id, type: 'goal', goal: `do ${id}`, bot: 'cli_worker', depends: [], inputs: [] })),
  });
  write('spec.json', {
    schemaVersion: 1, runId, title: 't', requirement: 'r',
    nodes: ids.map((id) => ({ sketchId: id, goal: id, input_needs: [], expected_outputs: ['o'], acceptance: 'x', risk_gate: false, unknowns: [] })),
  });
  write('bots.snapshot.json', { cli_worker: { larkAppId: 'cli_worker', cliId: 'claude-code', workingDir: '/w' } });
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId,
    createdAt: '2026-11-03T08:00:00.000Z',
    authorizedAt: '2026-11-03T08:01:00.000Z',
    authorizedByOpenId: REVISABLE_INITIATOR,
    chatBinding: REVISABLE_BINDING,
    ...(opts.nodeExecutor ? { nodeExecutor: opts.nodeExecutor } : {}),
    artifacts: {
      dag: artifactRef(runDir, 'dag.json'),
      spec: artifactRef(runDir, 'spec.json'),
      botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
    },
  }));
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId, ...(opts.nodeExecutor ? { nodeExecutor: opts.nodeExecutor } : {}) });
  return { base, runId, runDir };
}
