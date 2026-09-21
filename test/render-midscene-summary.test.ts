import { describe, expect, it } from 'vitest';
import { renderSummary } from '../scripts/render-midscene-summary.mjs';

describe('Midscene CI summary', () => {
  it('renders native case results and the report artifact link', () => {
    const markdown = renderSummary({
      artifactName: 'midscene-feishu-report',
      testOutcome: 'failure',
      runUrl: 'https://github.com/quanru/botmux/actions/runs/42',
      summary: {
        status: 'failed',
        durationMs: 1500,
        summary: { total: 2, passed: 1, failed: 1, notRun: 0 },
        projects: [
          {
            name: 'feishu-browser',
            cases: [
              { name: 'Aiden basic bot flow', status: 'success', attempts: [{}] },
              { name: 'Streaming card lifecycle', status: 'failed', attempts: [{}, {}] },
            ],
          },
        ],
      },
    });

    expect(markdown).toContain('Botmux × Midscene · failed');
    expect(markdown).toContain('1/2 cases passed');
    expect(markdown).toContain('Aiden basic bot flow');
    expect(markdown).toContain('Streaming card lifecycle');
    expect(markdown).toContain(
      'https://github.com/quanru/botmux/actions/runs/42#artifacts',
    );
  });

  it('labels unavailable live credentials as skipped without a report link', () => {
    const markdown = renderSummary({
      artifactName: 'midscene-feishu-report',
      testOutcome: 'skipped',
      runUrl: 'https://github.com/quanru/botmux/actions/runs/43',
      summary: null,
    });

    expect(markdown).toContain('Botmux × Midscene · live cases skipped');
    expect(markdown).toContain('Static Midscene validation passed');
    expect(markdown).not.toContain('#artifacts');
  });

  it('keeps every unavailable Feishu case visible next to real results', () => {
    const markdown = renderSummary({
      artifactName: 'botmux-midscene-report',
      testOutcome: 'success',
      feishuOutcome: 'skipped',
      skippedCases: ['Aiden basic bot flow', 'Streaming card lifecycle'],
      summary: {
        status: 'success',
        durationMs: 2500,
        summary: { total: 1, passed: 1, failed: 0, notRun: 0 },
        projects: [
          {
            name: 'dashboard-smoke',
            cases: [
              {
                name: 'Navigate the core read-only Dashboard pages',
                status: 'success',
                attempts: [{}],
              },
            ],
          },
        ],
      },
    });

    expect(markdown).toContain('Botmux × Midscene · passed with skips');
    expect(markdown).toContain('1/3 cases passed · 0 failed · 2 skipped');
    expect(markdown).toContain(
      '| ⏭️ Aiden basic bot flow | feishu-browser | skipped | 0 |',
    );
    expect(markdown).toContain(
      '| ⏭️ Streaming card lifecycle | feishu-browser | skipped | 0 |',
    );
  });
});
