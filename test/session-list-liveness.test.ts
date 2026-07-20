import { describe, expect, it } from 'vitest';
import { isColdResumeDormant, sessionListDisposition } from '../src/cli/session-list-liveness.js';

describe('botmux list session liveness', () => {
  it('keeps a deliberate cold-resume suspension without a pid or backing session', () => {
    const session = { suspendedColdResume: true, cliId: 'codex', lastCliInput: 'hello' };

    expect(sessionListDisposition(session, { hasPid: false, hasBackingSession: false })).toBe('keep');
    expect(isColdResumeDormant(session)).toBe(true);
  });

  it('still prunes a real zombie when no suspension marker exists', () => {
    expect(sessionListDisposition(
      { cliId: 'codex', lastCliInput: 'hello' },
      { hasPid: false, hasBackingSession: false },
    )).toBe('prune_real');
  });

  it('never auto-prunes an unsettled Codex App owner with no process markers', () => {
    expect(sessionListDisposition(
      { codexAppDispatchLedger: [{ state: 'prepared' }] },
      { hasPid: false, hasBackingSession: false },
    )).toBe('keep');
  });

  it('keeps live/backed sessions and distinguishes never-started scratch rows', () => {
    expect(sessionListDisposition({}, { hasPid: true, hasBackingSession: false })).toBe('keep');
    expect(sessionListDisposition({}, { hasPid: false, hasBackingSession: true })).toBe('keep');
    expect(sessionListDisposition({}, { hasPid: false, hasBackingSession: false })).toBe('prune_scratch');
  });
});
