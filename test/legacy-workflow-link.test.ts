import { describe, it, expect } from 'vitest';
import { legacyWorkflowDetailHash } from '../src/dashboard/web/legacy-workflow-link.js';

// Regression guard for the v3-detail → legacy fallback (v3.ts poll()): when an
// old `#/workflows/<v2-run-id>` link lands on v3 detail and `/api/v3/runs/<id>`
// 404s but the v2 snapshot exists, the page redirects to this hash. The
// regression-prone bits are the id encoding and verbatim query preservation
// (so `?attempt=…` deep links keep working) — covered here without a DOM.
describe('legacyWorkflowDetailHash', () => {
  it('builds the legacy detail hash for a plain run id', () => {
    expect(legacyWorkflowDetailHash('hello-20260520-abcd1234')).toBe(
      '#/legacy-workflow/hello-20260520-abcd1234',
    );
  });

  it('preserves the original query (e.g. ?attempt=...) verbatim — no double-encoding', () => {
    const rawQuery = 'attempt=run-x%3A%3Awork%3A%3An1%3A%3A1';
    expect(legacyWorkflowDetailHash('run-x', rawQuery)).toBe(
      `#/legacy-workflow/run-x?${rawQuery}`,
    );
  });

  it('url-encodes funky run ids', () => {
    expect(legacyWorkflowDetailHash('a/b c')).toBe('#/legacy-workflow/a%2Fb%20c');
  });

  it('omits the query delimiter when there is no query', () => {
    expect(legacyWorkflowDetailHash('run-x')).toBe('#/legacy-workflow/run-x');
    expect(legacyWorkflowDetailHash('run-x', '')).toBe('#/legacy-workflow/run-x');
  });
});
