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
    await writeFile(join(reportRoot, 'index.html'), '<title>Native report</title>');
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
    expect(landing).toContain('href="dashboard/"');
    await expect(readFile(join(output, 'dashboard', 'index.html'), 'utf8')).resolves.toContain(
      'Native report',
    );
  });
});
