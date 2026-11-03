import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareMidscenePages } from '../scripts/prepare-midscene-pages.mjs';

describe('Midscene Pages report', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('lists real Dashboard results and every skipped Feishu case', async () => {
    root = await mkdtemp(join(tmpdir(), 'botmux-midscene-pages-'));
    const reportRoot = join(root, 'report', 'run-1');
    const resultsRoot = join(root, 'results', 'run-1');
    const casesRoot = join(root, 'cases');
    const output = join(root, 'site');
    await Promise.all([
      mkdir(reportRoot, { recursive: true }),
      mkdir(resultsRoot, { recursive: true }),
      mkdir(casesRoot, { recursive: true }),
    ]);
    await writeFile(join(reportRoot, 'index.html'), `
      <title>Native report</title>
      <script type="midscene_test_run_dump">${JSON.stringify({
        projects: [{
          name: 'dashboard-smoke',
          documents: [{
            cases: [{
              caseId: 'dashboard-case',
              name: 'Navigate the core read-only Dashboard pages',
              status: 'success',
              attempts: [{
                status: 'success',
                durationMs: 1250,
                steps: [{
                  id: 'attempt:steps:0',
                  status: 'success',
                  agentDetails: [{ executionId: 'execution-1' }],
                }],
              }],
            }],
          }],
        }],
      })}</script>
      <script type="midscene_web_dump">${JSON.stringify({
        executions: [{
          id: 'execution-1',
          tasks: [{ uiContext: { screenshot: { id: 'screenshot-1' } } }],
        }],
      })}</script>
      <script type="midscene-image" data-id="screenshot-1">data:image/png;base64,iVBORw0KGgo=</script>
    `);
    await writeFile(
      join(resultsRoot, 'summary.json'),
      JSON.stringify({
        projects: [
          {
            cases: [
              {
                name: 'Navigate the core read-only Dashboard pages',
                status: 'success',
              },
            ],
          },
        ],
      }),
    );
    await writeFile(
      join(casesRoot, 'feishu.yaml'),
      'cases:\n  - name: Aiden basic bot flow\n  - name: Streaming card lifecycle\n',
    );

    await prepareMidscenePages({
      'report-root': reportRoot,
      'results-root': join(root, 'results'),
      'skipped-cases-dir': casesRoot,
      output,
    });

    const landing = await readFile(join(output, 'index.html'), 'utf8');
    expect(landing).toContain('1/3 cases passed');
    expect(landing).toContain('2 skipped');
    expect(landing).toContain('Aiden basic bot flow');
    expect(landing).toContain('Streaming card lifecycle');
    expect(landing).toContain('Node screenshot');
    expect(landing).toContain('previews/case-preview-dashboard-smoke-dashboard-case.png');
    expect(landing).toContain('href="dashboard/index.html#runner-step=');
    await expect(readFile(join(output, 'dashboard', 'index.html'), 'utf8')).resolves.toContain(
      'Native report',
    );
  });

  it('publishes partial per-case reports and marks unfinished cases as not run', async () => {
    root = await mkdtemp(join(tmpdir(), 'botmux-midscene-partial-'));
    const dashboardRoot = join(root, 'dashboard');
    const feishuRoot = join(root, 'feishu', 'runs', 'attempt-1', 'report');
    const casesRoot = join(root, 'cases');
    const output = join(root, 'site');
    await Promise.all([
      mkdir(dashboardRoot, { recursive: true }),
      mkdir(feishuRoot, { recursive: true }),
      mkdir(casesRoot, { recursive: true }),
    ]);
    const report = (project: string, name: string) => `
      <script type="midscene_test_run_dump">${JSON.stringify({
        projects: [{
          name: project,
          documents: [{ cases: [{
            caseId: name.toLowerCase().replaceAll(' ', '-'),
            name,
            status: 'failed',
            attempts: [{ status: 'failed', durationMs: 100, steps: [] }],
          }] }],
        }],
      })}</script>`;
    await writeFile(join(dashboardRoot, 'index.html'), report('dashboard-smoke', 'Dashboard smoke'));
    await writeFile(
      join(feishuRoot, 'midscene-e2e-20260923035539.html'),
      report('feishu-browser', 'Case one'),
    );
    await writeFile(join(casesRoot, 'feishu.yaml'), 'cases:\n  - name: Case one\n  - name: Case two\n');

    const manifest = await prepareMidscenePages({
      'dashboard-report-root': dashboardRoot,
      'feishu-report-root': join(root, 'feishu'),
      'feishu-outcome': 'failure',
      'skipped-cases-dir': casesRoot,
      output,
    });

    expect(manifest.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Case one', status: 'failed' }),
      expect.objectContaining({ name: 'Case two', status: 'not-run' }),
    ]));
    await expect(readFile(join(output, 'feishu', 'midscene-e2e-20260923035539.html'), 'utf8')).resolves.toContain(
      'Case one',
    );
  });

  it('recovers finished cases from attempt files when a run was killed before its report', async () => {
    root = await mkdtemp(join(tmpdir(), 'botmux-midscene-killed-'));
    const dashboardRoot = join(root, 'dashboard');
    const casesRoot = join(root, 'cases');
    const caseDir = (caseId: string) => join(root, 'runs', 'r1', 'project-1', 'documents', 'd1', 'cases', caseId);
    await Promise.all([
      mkdir(dashboardRoot, { recursive: true }),
      mkdir(join(root, 'reports'), { recursive: true }),
      mkdir(casesRoot, { recursive: true }),
      mkdir(caseDir('c1'), { recursive: true }),
      mkdir(caseDir('c2'), { recursive: true }),
    ]);
    const attempt = (caseId: string, name: string, attemptIndex: number, status: string, error?: string) =>
      JSON.stringify({
        caseId, name, attemptIndex, status, attemptId: `${caseId}-${attemptIndex}`,
        projectName: 'feishu-core-x', durationMs: 1000,
        beforeEach: [], afterEach: [],
        steps: [{ status, ...(error ? { error: { message: `Node "feishu.runScenario" failed: ${error}` } } : {}) }],
      });
    await writeFile(join(caseDir('c1'), 'a0.json'), attempt('c1', 'Case one', 0, 'failed', 'first try'));
    await writeFile(join(caseDir('c1'), 'a1.json'), attempt('c1', 'Case one', 1, 'success'));
    await writeFile(join(caseDir('c2'), 'a0.json'), attempt('c2', 'Case two', 0, 'failed', 'no reply'));
    await writeFile(
      join(casesRoot, 'core-x.yaml'),
      'cases:\n  - name: Case one\n  - name: Case two\n  - name: Case three\n',
    );

    const manifest = await prepareMidscenePages({
      'dashboard-report-root': dashboardRoot,
      'feishu-report-root': join(root, 'reports'),
      'feishu-results-root': join(root, 'runs'),
      'feishu-outcome': 'failure',
      'feishu-cases': 'all',
      'skipped-cases-dir': casesRoot,
      output: join(root, 'site'),
    });

    expect(manifest.cases.map((testCase: { name: string; status: string; attempts: number; failure?: string | null }) =>
      [testCase.name, testCase.status, testCase.attempts, testCase.failure ?? null])).toEqual([
      ['Case one', 'success', 2, null],
      ['Case two', 'failed', 1, 'no reply'],
      ['Case three', 'not-run', 0, null],
    ]);
  });

  it('embeds a Playwright replay from the video manifest', async () => {
    root = await mkdtemp(join(tmpdir(), 'botmux-midscene-video-'));
    const reportRoot = join(root, 'report');
    const casesRoot = join(root, 'cases');
    const videos = join(root, 'videos');
    const output = join(root, 'site');
    await Promise.all([
      mkdir(reportRoot, { recursive: true }),
      mkdir(casesRoot, { recursive: true }),
      mkdir(videos, { recursive: true }),
    ]);
    await writeFile(join(reportRoot, 'index.html'), `
      <script type="midscene_test_run_dump">${JSON.stringify({
        projects: [{
          name: 'dashboard-smoke',
          documents: [{
            cases: [{
              caseId: 'dashboard-case',
              name: 'Navigate the core read-only Dashboard pages',
              status: 'success',
              attempts: [{ status: 'success', durationMs: 1000, steps: [] }],
            }],
          }],
        }],
      })}</script>
    `);
    await writeFile(join(casesRoot, 'feishu.yaml'), 'cases:\n  - name: Claude basic bot flow\n');
    await writeFile(join(videos, 'dashboard-smoke.webm'), 'webm-bytes');
    await writeFile(join(videos, 'secret.webm'), 'do-not-copy');
    await writeFile(join(videos, 'manifest.json'), JSON.stringify({
      'Navigate the core read-only Dashboard pages': 'dashboard-smoke.webm',
      'Claude basic bot flow': '../secret.webm',
    }));

    await prepareMidscenePages({
      'report-root': reportRoot,
      'results-root': join(root, 'missing-results'),
      'skipped-cases-dir': casesRoot,
      output,
      'videos-dir': videos,
    });

    const landing = await readFile(join(output, 'index.html'), 'utf8');
    expect(landing).toContain('Replay');
    // A passed case's recording stays in the artifact; the site says so.
    expect(landing).not.toContain('src="videos/dashboard-smoke.webm"');
    expect(landing).toContain('Passed — recording kept in the run artifact');
    expect(landing).not.toContain('secret.webm');
    await expect(readFile(join(output, 'videos', 'dashboard-smoke.webm'), 'utf8')).rejects.toThrow();
  });

  it('publishes the recording of a failed case', async () => {
    root = await mkdtemp(join(tmpdir(), 'botmux-midscene-failed-video-'));
    const reportRoot = join(root, 'report');
    const casesRoot = join(root, 'cases');
    const videos = join(root, 'videos');
    const output = join(root, 'site');
    await Promise.all([
      mkdir(reportRoot, { recursive: true }),
      mkdir(casesRoot, { recursive: true }),
      mkdir(videos, { recursive: true }),
    ]);
    await writeFile(join(reportRoot, 'index.html'), `
      <script type="midscene_test_run_dump">${JSON.stringify({
        projects: [{
          name: 'dashboard-smoke',
          documents: [{ cases: [{
            caseId: 'dashboard-case',
            name: 'Navigate the core read-only Dashboard pages',
            status: 'failed',
            attempts: [{ status: 'failed', durationMs: 1000, steps: [] }],
          }] }],
        }],
      })}</script>
    `);
    await writeFile(join(casesRoot, 'feishu.yaml'), 'cases:\n  - name: Claude basic bot flow\n');
    await writeFile(join(videos, 'dashboard-smoke.webm'), 'webm-bytes');
    await writeFile(join(videos, 'manifest.json'), JSON.stringify({
      'Navigate the core read-only Dashboard pages': 'dashboard-smoke.webm',
    }));

    await prepareMidscenePages({
      'report-root': reportRoot,
      'skipped-cases-dir': casesRoot,
      output,
      'videos-dir': videos,
    });

    const landing = await readFile(join(output, 'index.html'), 'utf8');
    expect(landing).toContain('<video controls preload="metadata" src="videos/dashboard-smoke.webm">');
    await expect(readFile(join(output, 'videos', 'dashboard-smoke.webm'), 'utf8')).resolves.toBe('webm-bytes');
  });
});
