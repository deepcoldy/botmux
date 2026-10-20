import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reportCases, testRunDump } from '../scripts/midscene-report-evidence.mjs';

const PNG = (marker: string) => `data:image/png;base64,${Buffer.from(marker).toString('base64')}`;

function reportHtml(status: 'success' | 'failed'): string {
  const run = {
    projects: [{
      name: 'feishu-core-group-modes',
      documents: [{ cases: [{
        caseId: 'case-1',
        name: 'Claude group reply mode topic',
        status,
        attempts: [{
          status,
          durationMs: 1000,
          steps: [{
            id: 'attempt:steps:0',
            status,
            agentDetails: [{ executionId: 'wait' }, { executionId: 'failure' }, { executionId: 'restore' }],
          }],
        }],
      }] }],
    }],
  };
  const dump = {
    executions: [
      { id: 'wait', name: 'WaitFor - reply', tasks: [{ uiContext: { screenshot: { id: 'shot-wait' } } }] },
      // recordToReport keeps its screenshot on the task recorder.
      { id: 'failure', name: 'Log - 失败现场', tasks: [{ type: 'Log', recorder: [{ screenshot: { id: 'shot-failure' } }] }] },
      { id: 'restore', name: 'Act - restore the chat mode', tasks: [{ uiContext: { screenshot: { id: 'shot-restore' } } }] },
    ],
  };
  return `
    <script type="midscene_test_run_dump">${JSON.stringify(run)}</script>
    <script type="midscene_web_dump">${JSON.stringify(dump)}</script>
    <script type="midscene-image" data-id="shot-wait">${PNG('wait')}</script>
    <script type="midscene-image" data-id="shot-failure">${PNG('failure')}</script>
    <script type="midscene-image" data-id="shot-restore">${PNG('restore')}</script>`;
}

describe('Midscene report evidence', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('previews a failed case at its failure state, not the later clean-up', async () => {
    root = await mkdtemp(join(tmpdir(), 'botmux-evidence-'));
    const file = join(root, 'index.html');
    const html = reportHtml('failed');
    await writeFile(file, html);
    const [testCase] = await reportCases(testRunDump(html), 'feishu-core-group-modes', { html, reportFile: file });
    expect(testCase.screenshot?.bytes.toString()).toBe('failure');
  });

  it('previews a passed case at its last action', async () => {
    root = await mkdtemp(join(tmpdir(), 'botmux-evidence-'));
    const file = join(root, 'index.html');
    const html = reportHtml('success');
    await writeFile(file, html);
    const [testCase] = await reportCases(testRunDump(html), 'feishu-core-group-modes', { html, reportFile: file });
    expect(testCase.screenshot?.bytes.toString()).toBe('restore');
  });
});
