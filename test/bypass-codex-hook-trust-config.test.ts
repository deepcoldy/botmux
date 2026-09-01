import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { globalConfigPath } from '../src/global-config.js';
import { config } from '../src/config.js';

/**
 * `config.bypassCodexHookTrust` is a live getter over
 * `~/.botmux/config.json` → dashboard.bypassCodexHookTrust with DEFAULT-ON
 * semantics: absent ⇒ ON, and ONLY an explicit stored `false` disables it. This
 * differs from most toggles (which are default-OFF `=== true`) because a headless
 * fleet must not wedge on codex 0.14x's "Press t to trust" gate out of the box.
 * The worker ANDs this with each bot's `!disableCliBypass` before the adapter emits
 * `--dangerously-bypass-hook-trust` (that AND is covered by the adapter matrix in
 * cli-adapters.test.ts).
 */
describe('config.bypassCodexHookTrust (default-ON global toggle)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-hook-trust-'));
    vi.stubEnv('HOME', home);
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('defaults ON when no config file exists', () => {
    expect(config.bypassCodexHookTrust).toBe(true);
  });

  it('defaults ON when the config file has no dashboard block', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({}));
    expect(config.bypassCodexHookTrust).toBe(true);
  });

  it('stays ON when the key is absent from an existing dashboard block', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard: { codexRpcInput: true } }));
    expect(config.bypassCodexHookTrust).toBe(true);
  });

  it('is OFF only when explicitly persisted as false', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard: { bypassCodexHookTrust: false } }));
    expect(config.bypassCodexHookTrust).toBe(false);
  });

  it('is ON when explicitly persisted as true', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard: { bypassCodexHookTrust: true } }));
    expect(config.bypassCodexHookTrust).toBe(true);
  });

  it('a non-boolean value is ignored and falls through to the default ON', () => {
    // readDashboard only keeps a boolean; garbage is dropped, so the getter's
    // `!== false` sees `undefined` → ON.
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard: { bypassCodexHookTrust: 'no' } }));
    expect(config.bypassCodexHookTrust).toBe(true);
  });
});
