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
});
