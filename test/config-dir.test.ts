import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BOTMUX_CONFIG_DIR_ENV, resolveBotmuxConfigDir } from '../src/core/config-dir.js';
import { BOTMUX_INJECTED_ENV_KEYS } from '../src/utils/child-env.js';
import { isReservedPerBotEnvKey, sanitizePerBotEnv } from '../src/core/per-bot-env.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'botmux-config-dir-'));
  roots.push(value);
  return value;
}

describe('resolveBotmuxConfigDir', () => {
  it('uses BOTMUX_CONFIG_DIR -> $HOME/.botmux precedence', () => {
    const home = root();
    const explicit = join(root(), 'fleet');

    expect(resolveBotmuxConfigDir({ env: { HOME: home, [BOTMUX_CONFIG_DIR_ENV]: explicit } }))
      .toBe(explicit);
    expect(resolveBotmuxConfigDir({ env: { HOME: home } })).toBe(join(home, '.botmux'));
  });

  it('ignores a relative override, which would resolve per-process cwd', () => {
    const home = root();
    // daemon, forked worker and pane child do not share one cwd, so a relative
    // value must not be honoured — it would silently split the registry.
    expect(resolveBotmuxConfigDir({ env: { HOME: home, [BOTMUX_CONFIG_DIR_ENV]: '.botmux-alt' } }))
      .toBe(join(home, '.botmux'));
    expect(resolveBotmuxConfigDir({ env: { HOME: home, [BOTMUX_CONFIG_DIR_ENV]: '  ' } }))
      .toBe(join(home, '.botmux'));
  });

  it('falls back to USERPROFILE when HOME is absent (Windows)', () => {
    const home = root();
    expect(resolveBotmuxConfigDir({ env: { USERPROFILE: home } })).toBe(join(home, '.botmux'));
  });

  it('prefers the explicit homeDir test seam over env HOME', () => {
    const seam = root();
    expect(resolveBotmuxConfigDir({ env: { HOME: '/nonexistent' }, homeDir: seam }))
      .toBe(join(seam, '.botmux'));
  });

  it('regression: a daemon under a non-default HOME and its child agree', () => {
    // The bug this fixes. A second fleet started with `HOME=<fleet> botmux start`
    // loads <fleet>/.botmux/bots.json, but children inherit BOTMUX_* and NOT HOME.
    const fleetHome = root();
    const defaultHome = root();
    const fleetConfig = resolveBotmuxConfigDir({ env: { HOME: fleetHome } });

    // Before: the child re-derived the root from its own (default) HOME.
    expect(resolveBotmuxConfigDir({ env: { HOME: defaultHome } })).not.toBe(fleetConfig);

    // After: the daemon pins BOTMUX_CONFIG_DIR, so the child agrees even though
    // its HOME still points at the default home.
    expect(resolveBotmuxConfigDir({
      env: { HOME: defaultHome, [BOTMUX_CONFIG_DIR_ENV]: fleetConfig },
    })).toBe(fleetConfig);
  });
});

describe('BOTMUX_CONFIG_DIR plumbing', () => {
  it('is injected into panes so the tmux path matches the direct-spawn path', () => {
    // buildBotmuxEnvAssignments iterates this list; omitting the key would fix
    // only the pty backend and leave tmux sessions failing.
    expect(BOTMUX_INJECTED_ENV_KEYS).toContain(BOTMUX_CONFIG_DIR_ENV);
  });

  it('is reserved from per-bot env: a bot cannot redirect its own registry', () => {
    expect(isReservedPerBotEnvKey(BOTMUX_CONFIG_DIR_ENV)).toBe(true);
    expect(sanitizePerBotEnv({ [BOTMUX_CONFIG_DIR_ENV]: '/tmp/evil', KEEP: 'yes' }))
      .toEqual({ KEEP: 'yes' });
  });
});
