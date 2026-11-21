/**
 * Flow version history in the workflow sidebar (design 2026-11-03 §11.3,
 * §13.7), projected from a real run edited at runtime (#2763):
 *
 *   - a member gets only the versions that took effect, each with exactly
 *     version, time, role, generated summary and whether it was confirmed —
 *     never an open_id and never the edit's free-text note (it may carry
 *     parameter values); a pending proposal is not a version yet;
 *   - the admin payload is the full RunView as before (pending entries,
 *     states and all);
 *   - the page renders the panel for both.
 */

import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { decideV3RevisionProposal, applyV3RunEdit } from '../src/workflows/v3/run-edit.js';
import {
  projectWorkflowSidebarAdmin,
  projectWorkflowSidebarMember,
  readWorkflowSidebarRun,
  type WorkflowSidebarMemberPayload,
} from '../src/dashboard/workflow-sidebar-view.js';
import { WorkflowSidebarPage, sidebarModel } from '../src/dashboard/web/workflow-sidebar-page.js';
import { cleanupBotRuns } from './helpers/v3-external-harness.js';
import { REVISABLE_INITIATOR, seedRevisableRun } from './helpers/workflow-revisable-run.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => cleanupBotRuns());

const MEMBER = 'ou_member_editor';
const NOTE = 'switch region=cn-north-1 and token=PARAM-VALUE-1234';
const noNewBots = () => { throw new Error('no new bots'); };

/** v2: the initiator's own edit (direct, with a note); v3: a member's edit the
 *  initiator confirmed; v4: a member's edit still waiting. */
function editedRun() {
  const run = seedRevisableRun('wfs-revisions', { nodeExecutor: 'bot', nodes: ['a', 'b'] });
  const edit = (baseRevision: number, openId: string, goal: string, note?: string) => applyV3RunEdit({
    baseDir: run.base, runId: run.runId, baseRevision,
    patch: { ops: [{ op: 'updateNode', nodeId: 'b', set: { goal } }], ...(note ? { note } : {}) },
    caller: { openId, origin: 'human' }, resolveNewBotSnapshot: noNewBots,
  });
  expect(edit(1, REVISABLE_INITIATOR, 'initiator goal', NOTE)).toMatchObject({ kind: 'applied', revision: 2 });
  expect(edit(2, MEMBER, 'member goal', NOTE)).toMatchObject({ kind: 'proposed', revision: 3 });
  expect(decideV3RevisionProposal({ baseDir: run.base, runId: run.runId, revision: 3, decision: 'approve', by: REVISABLE_INITIATOR }))
    .toMatchObject({ kind: 'approved' });
  expect(edit(3, MEMBER, 'another member goal', NOTE)).toMatchObject({ kind: 'proposed', revision: 4 });
  const read = readWorkflowSidebarRun(run.base, run.runId);
  if (read.kind !== 'ok') throw new Error(read.kind);
  return read.run;
}

describe('flow version history in the sidebar projection', () => {
  it('a member gets the versions that took effect, five fields each, no open_id and no note', () => {
    const run = editedRun();
    const member = projectWorkflowSidebarMember(run, { brand: 'feishu', now: () => 1 });
    const revisions = member.view.revisions!;
    expect(revisions.current).toBe(3);
    expect(revisions.history.map(({ revision, by, confirmed }) => ({ revision, by, confirmed }))).toEqual([
      { revision: 2, by: 'initiator', confirmed: false },
      { revision: 3, by: 'other', confirmed: true },
    ]);
    for (const entry of revisions.history) {
      expect(Object.keys(entry).sort()).toEqual(['at', 'by', 'confirmed', 'revision', 'summary']);
      expect(entry.summary).toBe('改 1 节点');
      expect(entry.at).toBeGreaterThan(0);
    }
    const text = JSON.stringify(member);
    for (const leaked of [REVISABLE_INITIATOR, MEMBER, 'ou_', NOTE, 'PARAM-VALUE', 'member goal']) {
      expect(text).not.toContain(leaked);
    }
    // The waiting proposal (v4) is not a version yet.
    expect(JSON.stringify(revisions)).not.toMatch(/pending|"revision":4/);
  });

  it('the admin payload keeps the full history (pending proposal included), as before', () => {
    const run = editedRun();
    const admin = projectWorkflowSidebarAdmin(run, { brand: 'feishu', now: () => 1 });
    expect(admin.view.revision).toMatchObject({ current: 3, pending: { revision: 4 } });
    expect(admin.view.revision!.history.map((entry) => [entry.revision, entry.state])).toEqual([[2, 'applied'], [3, 'applied'], [4, 'pending']]);
  });

  it('a run never edited has no history block for members', () => {
    const run = seedRevisableRun('wfs-no-revisions', { nodeExecutor: 'bot' });
    const read = readWorkflowSidebarRun(run.base, run.runId);
    if (read.kind !== 'ok') throw new Error(read.kind);
    expect(projectWorkflowSidebarMember(read.run, { brand: 'feishu' }).view).not.toHaveProperty('revisions');
  });
});

describe('the sidebar page shows the version panel', () => {
  async function render(payload: Parameters<typeof sidebarModel>[0]) {
    let renderer: TestRenderer.ReactTestRenderer;
    const fetcher = async () => new Response(JSON.stringify(payload), { status: 200 });
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(WorkflowSidebarPage, { target: { appId: 'cli_main_app', runId: 'wfs-revisions' }, fetcher }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const panel = renderer!.root.findAll((el) => el.props.className === 'wfs-revisions');
    const text = (el: TestRenderer.ReactTestInstance): string => el.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
    const result = panel.length ? text(panel[0]!) : undefined;
    act(() => renderer!.unmount());
    return result;
  }

  it('for a member: the versions that took effect, with role and confirmation', async () => {
    const run = editedRun();
    const panel = await render(projectWorkflowSidebarMember(run, { brand: 'feishu', now: () => 1 }) as WorkflowSidebarMemberPayload);
    expect(panel).toContain('流程版本：第 3 版');
    expect(panel).toContain('第 2 版');
    expect(panel).toContain('发起人');
    expect(panel).toContain('其他成员');
    expect(panel).toContain('已确认');
    expect(panel).not.toContain('第 4 版');
  });

  it('for an admin: the same panel as the Dashboard, the pending proposal included', async () => {
    const run = editedRun();
    const panel = await render(projectWorkflowSidebarAdmin(run, { brand: 'feishu', now: () => 1 }));
    expect(panel).toContain('第 4 版待发起人确认');
  });

  it('no panel for a run that was never edited', async () => {
    const run = seedRevisableRun('wfs-plain-page', { nodeExecutor: 'bot' });
    const read = readWorkflowSidebarRun(run.base, run.runId);
    if (read.kind !== 'ok') throw new Error(read.kind);
    expect(await render(projectWorkflowSidebarMember(read.run, { brand: 'feishu' }))).toBeUndefined();
  });
});
