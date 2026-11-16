import { describe, expect, it } from 'vitest';
import { integratedManagementExport } from '../src/dashboard/web/plugin-page.js';

describe('opt-in integrated plugin management', () => {
  it('uses an explicitly opted-in management component without replacing it', () => {
    const Component = () => null;
    expect(integratedManagementExport({ management: { version: 1, placement: 'before-scope-controls', Component } }))
      .toEqual({ Component });
  });

  it.each([
    null, {}, { default: () => null },
    { management: { version: 2, placement: 'before-scope-controls', Component: () => null } },
    { management: { version: 1, ownsScopeControls: true, Component: () => null } },
    { management: { version: 1, placement: 'before-scope-controls', Component: 'not a component' } },
  ])('keeps the existing host controls without a valid explicit opt-in (%j)', mod => {
    expect(integratedManagementExport(mod)).toBeNull();
  });
});
