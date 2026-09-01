import { describe, expect, it } from 'vitest';
import { evidenceHtml } from '../src/dashboard/web/goals.js';

describe('goal dashboard evidence links', () => {
  it('links only http(s) evidence URLs', () => {
    expect(evidenceHtml({ kind: 'url', label: 'https://ci.example.com/run/1' })).toContain('href="https://ci.example.com/run/1"');
    expect(evidenceHtml({ kind: 'url', label: 'javascript:alert(1)' })).not.toContain('href=');
  });
});
