import { describe, expect, it, vi } from 'vitest';
import { assertIncludePm2RestartAdmission } from '../src/cli/pm2-god-admission.js';

describe('restart --include-pm2 admission', () => {
  it('admits only an initially zero-God state', () => {
    expect(() => assertIncludePm2RestartAdmission([])).not.toThrow();
  });

  it('rejects a live God before any caller mutation', () => {
    const mutate = vi.fn();
    expect(() => {
      assertIncludePm2RestartAdmission([101]);
      mutate();
    }).toThrow(/cannot be signalled with generation-bound authority.*does not signal or restart.*no process or breadcrumb was changed/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('rejects duplicate Gods without selecting either generation', () => {
    expect(() => assertIncludePm2RestartAdmission([101, 202]))
      .toThrow(/multiple PM2 God daemons.*no process or breadcrumb was changed/);
  });
});
