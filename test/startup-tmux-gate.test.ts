/**
 * shouldHardFailStartupForMissingTmux — PR#289 Option A startup hard-gate.
 *
 * The daemon-start hard-fail must fire ONLY when tmux is genuinely absent (a
 * deterministic, no-surviving-sessions condition) and a bot actually wants the
 * tmux backend and no PTY opt-in. A present-but-broken tmux (functional probe
 * flaked) must NOT block startup — it degrades via the per-session worker gate,
 * so a transient flake can't refuse to reattach live sessions (PR#249).
 *
 * Run:  pnpm vitest run test/startup-tmux-gate.test.ts
 */
import { describe, it, expect } from 'vitest';
import { shouldHardFailStartupForMissingTmux } from '../src/setup/index.js';

const base = {
  tmuxInstalled: false,
  tmuxBinaryPresent: false,
  anyBotWantsTmux: true,
  ptyOptIn: false,
};

describe('shouldHardFailStartupForMissingTmux', () => {
  it('HARD-FAILS when tmux is genuinely absent and a bot wants tmux (the ops case)', () => {
    expect(shouldHardFailStartupForMissingTmux(base)).toBe(true);
  });

  it('does NOT hard-fail when tmux is functional', () => {
    expect(shouldHardFailStartupForMissingTmux({ ...base, tmuxInstalled: true })).toBe(false);
  });

  it('does NOT hard-fail when the binary is present but the probe flaked (graceful per-session gate, PR#249)', () => {
    expect(shouldHardFailStartupForMissingTmux({ ...base, tmuxBinaryPresent: true })).toBe(false);
  });

  it('does NOT hard-fail when no bot wants tmux (all pty/herdr/zellij)', () => {
    expect(shouldHardFailStartupForMissingTmux({ ...base, anyBotWantsTmux: false })).toBe(false);
  });

  it('does NOT hard-fail when the operator opted into the PTY escape hatch (BACKEND_TYPE=pty)', () => {
    expect(shouldHardFailStartupForMissingTmux({ ...base, ptyOptIn: true })).toBe(false);
  });

  it('PTY opt-in wins even with everything else pointing at hard-fail', () => {
    expect(
      shouldHardFailStartupForMissingTmux({
        tmuxInstalled: false,
        tmuxBinaryPresent: false,
        anyBotWantsTmux: true,
        ptyOptIn: true,
      }),
    ).toBe(false);
  });
});
