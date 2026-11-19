/**
 * 基于历史创建（design 2026-11-03 §6, D6）的交叠与半写入：两个标签页同时
 * 「确认需求」、改目标与确认需求交叠、复制中途失败不留半个草稿、预填流程落盘
 * 一半（dag.json 写了、grill 没动）后重来。真实草稿服务与真实目录。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowDraftError } from '../src/workflows/v3/draft-service.js';
import { mintV3RunId, readGrillState, writeGrillState } from '../src/workflows/v3/grill-state.js';
import { BOTS, DOC, MAIN, OWNER, PI, SKETCHES, STEWARD, makeService, specMarkdown } from './helpers/workflow-draft-fakes.js';
import { REVIEW, seedRun } from './helpers/workflow-copy-fakes.js';

const FLEET = [...BOTS, { larkAppId: REVIEW, larkAppSecret: 's-rv', name: 'review', cliId: 'claude-code' }] as any[];
const RUN = 'src-261101-080000-000-aaaa0001';

let root: string;
let base: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wf-copy-faults-'));
  base = join(root, 'v3-runs');
  mkdirSync(base);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function settle(promise: Promise<unknown>): Promise<string> {
  try { await promise; return 'ok'; } catch (error) { if (error instanceof WorkflowDraftError) return error.code; throw error; }
}

function setup() {
  const h = makeService(base, { loadBots: () => FLEET, libraryDataDir: root });
  h.setOnline([MAIN, DOC, REVIEW, STEWARD, PI]);
  seedRun(base, RUN, { revised: true });
  return h;
}

describe('复制的交叠与半写入', () => {
  it('two tabs confirming the requirement at once: one wins, the flow is put in place once', async () => {
    const h = setup();
    const draft = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: RUN } });
    const outcomes = await Promise.all([1, 2].map(() => settle(h.service.approveSpec(draft.runId, OWNER, { baseVersion: draft.version }))));
    expect(outcomes.sort()).toEqual(['ok', 'version_conflict']);
    const view = await h.service.view(draft.runId);
    expect(view.phase).toBe('dag_ready');
    expect(view.flowRevision).toBe(1);
    expect(h.architect.calls).toHaveLength(0);
  });

  it('改目标 racing 确认需求 on the version the page showed: one of them, never a mix', async () => {
    const h = setup();
    const draft = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: RUN } });
    const [goal, approve] = await Promise.all([
      settle(h.service.editCopyGoal(draft.runId, OWNER, { goal: '新目标', mode: 'rearchitect', baseVersion: draft.version })),
      settle(h.service.approveSpec(draft.runId, OWNER, { baseVersion: draft.version })),
    ]);
    expect([goal, approve].sort()).toEqual(['ok', 'version_conflict']);
    const view = await h.service.view(draft.runId);
    if (goal === 'ok') {
      expect(view).toMatchObject({ phase: 'spec_ready', copy: { prefilled: false } });
    } else {
      expect(view.phase).toBe('dag_ready');
      expect((view.spec!.json as any).requirement).toBe('出报告');
    }
  });

  it('a copy failing at its last write leaves nothing behind, and the source is still copyable', async () => {
    const h = setup();
    // The next draft id is known (fixed clock, counter suffix): its draft.json
    // cannot be written (a directory is in the way).
    const runId = mintV3RunId('代码风险报告', new Date('2026-11-05T10:00:00.000Z'), '00000001');
    mkdirSync(join(base, runId, 'draft.json'), { recursive: true });
    expect(await settle(h.service.createFromSource(OWNER, { source: { kind: 'run', runId: RUN } }))).toBe('dag_invalid');
    expect(readdirSync(base)).toEqual([RUN]);
    expect((await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: RUN } })).phase).toBe('spec_ready');
  });

  it('确认需求 interrupted after the flow file was written but before the grill moved: the retry finishes it', async () => {
    const h = setup();
    const draft = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: RUN } });
    const runDir = join(base, draft.runId);
    // As if the previous attempt died between the dag.json write and the grill write.
    writeFileSync(join(runDir, 'dag.json'), '{"half": true}\n');
    expect(readGrillState(runDir)!.status).toBe('spec_ready');
    const view = await h.service.approveSpec(draft.runId, OWNER);
    expect(view.phase).toBe('dag_ready');
    expect(view.flow!.dag.nodes.map((node) => node.id)).toEqual(['inspect', 'write', 'review']);
  });

  it('a grill that moved while the record still says prefilled (crash between): a spec written in clarifying drops it, 确认需求 then orchestrates', async () => {
    const h = setup();
    const draft = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: RUN } });
    const runDir = join(base, draft.runId);
    // The grill went back to clarifying, the draft record kept `prefill`.
    const grill = readGrillState(runDir)!;
    writeGrillState(runDir, { ...grill, status: 'grilling' });
    const view = await h.service.view(draft.runId);
    expect(view.copy!.prefilled).toBe(false);
    expect(existsSync(join(runDir, 'copy.dag.json'))).toBe(true);
    // Even the very spec it was copied with, written again in clarifying, is
    // a requirement of its own: orchestrated anew.
    const copiedSpec = readFileSync(join(runDir, 'spec.md'), 'utf-8');
    await h.service.continueClarify(draft.runId, OWNER);
    expect((await h.service.finalizeSpec(draft.runId, OWNER, { specMarkdown: copiedSpec })).ok).toBe(true);
    expect((await h.service.approveSpec(draft.runId, OWNER)).phase).toBe('awaiting_architect');
  });
});
