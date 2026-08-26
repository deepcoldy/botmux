/**
 * session-launch-model.test.ts
 *
 * The model botmux hands the CLI is resolved at EVERY spawn (resume included)
 * from the live bot config — unlike cliId/cliRuntime/wrapperCli, which are
 * frozen onto the session at creation. Freezing the model too meant a
 * long-running session kept whatever default it inherited when it was created,
 * so the model configured in the dashboard silently never took effect on it.
 *
 * These tests lock the precedence: explicit per-trigger override > live bot
 * config > the session's own historical record (only when the session is pinned
 * to a CLI the bot no longer runs, where the live model belongs to another CLI).
 */
import { describe, expect, it } from 'vitest';
import { resolveSessionLaunchModel } from '../src/core/session-model.js';

const ds = (session: { cliId?: any; model?: string }, spawnModelOverride?: string) =>
  ({ session, spawnModelOverride }) as any;

describe('resolveSessionLaunchModel', () => {
  it('uses the live bot model for a session frozen on the same CLI', () => {
    expect(resolveSessionLaunchModel(
      ds({ cliId: 'claude-code' }),
      { cliId: 'claude-code', model: 'opus' },
    )).toBe('opus');
  });

  // THE regression: an old row still carries the model it froze at creation.
  // The live bot config must win, or a dashboard change stays ineffective on
  // exactly the long sessions it was meant to move.
  it('ignores a historical session.model when the live config applies', () => {
    expect(resolveSessionLaunchModel(
      ds({ cliId: 'claude-code', model: 'sonnet-frozen-in-2026' }),
      { cliId: 'claude-code', model: 'opus' },
    )).toBe('opus');
  });

  it('passes no model when the bot configures none (CLI resolves its own default)', () => {
    expect(resolveSessionLaunchModel(
      ds({ cliId: 'claude-code', model: 'sonnet-frozen-in-2026' }),
      { cliId: 'claude-code' },
    )).toBeUndefined();
  });

  it('keeps the session record when the bot has since switched to another CLI', () => {
    // A codex session must not be handed the claude model the bot now configures.
    expect(resolveSessionLaunchModel(
      ds({ cliId: 'codex', model: 'gpt-5.6' }),
      { cliId: 'claude-code', model: 'opus' },
    )).toBe('gpt-5.6');
  });

  it('passes no model for a CLI-mismatched session with no record of its own', () => {
    // e.g. a Codex App thread takeover: cliId is pinned to codex-app and the
    // legacy record is cleared, so nothing foreign leaks in.
    expect(resolveSessionLaunchModel(
      ds({ cliId: 'codex-app' }),
      { cliId: 'claude-code', model: 'opus' },
    )).toBeUndefined();
  });

  it('lets an explicit per-trigger override outrank the bot config', () => {
    expect(resolveSessionLaunchModel(
      ds({ cliId: 'codex', model: 'gpt-5.6' }, 'gpt-5.6-terra'),
      { cliId: 'codex', model: 'gpt-5.5' },
    )).toBe('gpt-5.6-terra');
  });

  it('treats a session with no stamped cliId as inheriting the bot', () => {
    expect(resolveSessionLaunchModel(ds({}), { cliId: 'codex', model: 'gpt-5.5' })).toBe('gpt-5.5');
  });

  it('survives a missing bot config (deregistered bot / tests)', () => {
    expect(resolveSessionLaunchModel(ds({ cliId: 'codex', model: 'gpt-5.6' }))).toBe('gpt-5.6');
    expect(resolveSessionLaunchModel(ds({ cliId: 'codex' }))).toBeUndefined();
  });
});

/**
 * A `/cli <cliId>`-selected session (cliLaunchSnapshot) resolves its model
 * through THIS function too — sessionAgentConfig's snapshot branch calls it
 * AFTER stamping ds.session.cliId = selected.cliId, so the CLI-match test runs
 * against the selected CLI, and the model stays consistent with the in-place
 * respawn paths (/restart, cli-crash, crash-diagnostic repark) which never pass
 * through the snapshot branch but resolve the model the same way.
 */
describe('resolveSessionLaunchModel — /cli session selection', () => {
  it('leaks no bot model across a cross-CLI selection (/cli codex on a claude bot)', () => {
    // The whole point of /cli: a fresh session carries no model of its own, the
    // selected CLI differs from the bot's, so the claude model is NOT handed to codex.
    expect(resolveSessionLaunchModel(
      ds({ cliId: 'codex', model: undefined }),
      { cliId: 'claude-code', model: 'opus' },
    )).toBeUndefined();
  });

  it('keeps the bot model for a same-CLI selection (/cli codex on a codex bot)', () => {
    // Same CLI → the bot model applies, identical to what /restart would resolve,
    // so first spawn and later in-place respawns agree.
    expect(resolveSessionLaunchModel(
      ds({ cliId: 'codex', model: undefined }),
      { cliId: 'codex', model: 'gpt-5.6' },
    )).toBe('gpt-5.6');
  });

  it('honors a per-trigger override on a /cli session regardless of CLI match', () => {
    expect(resolveSessionLaunchModel(
      ds({ cliId: 'codex', model: undefined }, 'gpt-5.6-terra'),
      { cliId: 'claude-code', model: 'opus' },
    )).toBe('gpt-5.6-terra');
  });
});
