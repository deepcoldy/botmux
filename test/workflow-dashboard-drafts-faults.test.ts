/**
 * Dashboard workflow drafts: a draft.json write that fails (design 2026-11-03
 * workflow-dashboard-orchestration §4.4, §9). The store's writer is wrapped
 * to refuse chosen records; everything else is the real service.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fault = vi.hoisted(() => ({ refuse: (_record: any) => false }));
vi.mock('../src/workflows/v3/draft-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workflows/v3/draft-store.js')>();
  return {
    ...actual,
    writeWorkflowDraft: (runDir: string, record: any) => {
      if (fault.refuse(record)) throw new Error('injected draft.json write failure');
      return actual.writeWorkflowDraft(runDir, record);
    },
  };
});

import { readWorkflowDraft } from '../src/workflows/v3/draft-store.js';
import { OWNER, SKETCHES, architectSettled, makeService, specMarkdown } from './helpers/workflow-draft-fakes.js';

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'wf-drafts-faults-')); });
afterEach(() => {
  fault.refuse = () => false;
  rmSync(base, { recursive: true, force: true });
});

it('an Architect outcome whose details cannot be recorded is recorded without them', async () => {
  const h = makeService(base, { runArchitect: async () => { throw new Error('BOOM details'); } });
  const view = await h.service.create(OWNER, { goal: 'g' });
  h.clarify.reply(`够了\n<botmux-spec>\n${specMarkdown(SKETCHES)}\n</botmux-spec>`);
  await h.service.finalizeSpec(view.runId, OWNER, {});
  await h.service.approveSpec(view.runId, OWNER);
  fault.refuse = (record) => (record.architect?.problems ?? []).some((problem: string) => problem.includes('BOOM'));
  await h.service.startArchitect(view.runId, OWNER);
  await architectSettled(h.service, view.runId);
  const architect = readWorkflowDraft(join(base, view.runId))!.architect!;
  expect(architect.state).toBe('failed');
  expect(architect.problems).toEqual(['编排失败，详细原因没能记录']);
  expect((await h.service.view(view.runId)).phase).toBe('awaiting_architect');
});
