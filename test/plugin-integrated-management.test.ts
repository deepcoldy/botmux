import { describe, expect, it } from 'vitest';
import { frontendManagesPrerequisiteGate, integratedManagementExport } from '../src/dashboard/web/plugin-page.js';

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

describe('frontend prerequisite readiness gate', () => {
  it('does not gate ordinary plugins regardless of dashboard entries', () => {
    expect(frontendManagesPrerequisiteGate(false, undefined)).toBe(false);
    expect(frontendManagesPrerequisiteGate(false, '/plugins/x/dash.js')).toBe(false);
  });

  it('gates only prerequisites plugins that expose a mountable management entry', () => {
    expect(frontendManagesPrerequisiteGate(true, '/plugins/x/dash.js')).toBe(true);
  });

  it('leaves toggles enabled when no management entry can report readiness', () => {
    // Without a surface the frontend cannot observe readiness; the server-side
    // check is the sole gate, so the dialog must not dead-lock the switches.
    expect(frontendManagesPrerequisiteGate(true, undefined)).toBe(false);
    expect(frontendManagesPrerequisiteGate(true, '')).toBe(false);
  });
});
