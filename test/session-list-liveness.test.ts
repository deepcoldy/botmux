import { describe, expect, it } from 'vitest';
import { isColdResumeDormant, isRealManagedSession, sessionListDisposition } from '../src/cli/session-list-liveness.js';

describe('botmux list session liveness', () => {
  it('keeps a deliberate cold-resume suspension without a pid or backing session', () => {
    const session = { suspendedColdResume: true, cliId: 'codex', lastCliInput: 'hello' };

    expect(sessionListDisposition(session, { hasPid: false, hasBackingSession: false })).toBe('keep');
    expect(isColdResumeDormant(session)).toBe(true);
  });

  it('keeps a real managed session with no pid and no backing (host reboot) — dormant, never pruned', () => {
    // The reboot fix: restoreActiveSessions keeps these rows worker-less, and a
    // subsequent `botmux list` (a READ command) must not re-close them. Whether
    // the CLI merely exited or a host reboot wiped the backing pane, the on-disk
    // transcript still cold-resumes on the next message.
    expect(sessionListDisposition(
      { cliId: 'codex', lastCliInput: 'hello' },
      { hasPid: false, hasBackingSession: false },
    )).toBe('keep');
    expect(sessionListDisposition(
      { cliId: 'codex' },
      { hasPid: false, hasBackingSession: false },
    )).toBe('keep');
  });

  it('still prunes a never-started scratch row (no real-CLI markers, no pid/backing) silently', () => {
    expect(sessionListDisposition({}, { hasPid: false, hasBackingSession: false })).toBe('prune_scratch');
  });

  it('keeps live/backed sessions regardless of the real-vs-scratch markers', () => {
    expect(sessionListDisposition({}, { hasPid: true, hasBackingSession: false })).toBe('keep');
    expect(sessionListDisposition({}, { hasPid: false, hasBackingSession: true })).toBe('keep');
    // A real managed session with a surviving backing pane is kept too.
    expect(sessionListDisposition({ cliId: 'codex' }, { hasPid: false, hasBackingSession: true })).toBe('keep');
  });

  it('isRealManagedSession distinguishes transcript-backed rows from disposable scratch', () => {
    expect(isRealManagedSession({ cliId: 'codex' })).toBe(true);
    expect(isRealManagedSession({ lastCliInput: 'hi' })).toBe(true);
    expect(isRealManagedSession({ adoptedFrom: { source: 'tmux' } })).toBe(true);
    expect(isRealManagedSession({})).toBe(false);
  });
});
