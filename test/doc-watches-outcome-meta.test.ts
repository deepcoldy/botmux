import { describe, expect, it } from 'vitest';
import { outcomeMeta } from '../src/dashboard/web/doc-watches.js';

describe('doc watches outcomeMeta', () => {
  it('renders poll-circuit-open as an error state (regression: copied union type silently fell through to default)', () => {
    const meta = outcomeMeta('poll-circuit-open');
    expect(meta.kind).toBe('error');
    expect(meta.label).toContain('熔断');
  });

  it('keeps the regular poll failure state red', () => {
    expect(outcomeMeta('poll-failed').kind).toBe('error');
  });
});
