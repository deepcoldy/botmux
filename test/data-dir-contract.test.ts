import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBotmuxDataDir } from '../src/core/data-dir.js';
import { resolveFleetDaemonEnv, resolveDashboardSpec, resolveFleetMembers } from '../src/core/fleet-runtime.js';

/**
 * Regression guard for the data-dir contract, which the pm2→supervisor migration
 * silently broke in two independent layers.
 *
 * BACKGROUND: pm2's ecosystem config baked `SESSION_DATA_DIR` into every managed
 * app's env block (bot daemons AND the dashboard). That made two latent defects
 * invisible in production, and removing pm2 exposed both:
 *
 *   Layer B (config.ts fallback): `config.session.dataDir` fell back to
 *     `new URL('../data', import.meta.url)` — the INSTALL directory's sibling,
 *     which does not exist and is not shipped. ~389 readers of
 *     config.session.dataDir would silently use a different store than the CLI's
 *     own resolveBotmuxDataDir(); inside a compiled binary that path is the
 *     read-only `/$bunfs`, so writers got EACCES.
 *
 *   Layer A (the env itself): several call sites deliberately read
 *     `process.env.SESSION_DATA_DIR` INSTEAD of config.session.dataDir and
 *     DEGRADE when it is missing (session-manager's effectivePromptHookConfigPath
 *     falls back to the global hook config, losing per-bot isolation). A
 *     config.ts-level fix cannot reach those, so the supervisor must pin the env.
 *
 * Fixing only one layer leaves the other hole open, so both are pinned here.
 */

const dirs: string[] = [];
const savedEnv = { ...process.env };
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'botmux-datadir-contract-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  // Restore the exact env: these tests mutate SESSION_DATA_DIR / HOME.
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe('layer B — config.session.dataDir falls back to the canonical resolver', () => {
  it('agrees with resolveBotmuxDataDir() when SESSION_DATA_DIR is unset', async () => {
    delete process.env.SESSION_DATA_DIR;
    const { config } = await import('../src/config.js');
    // The whole point: no install-relative '../data' divergence. Both sides must
    // name the SAME directory, so all ~389 config.session.dataDir readers and the
    // CLI's own resolution can never land on different stores.
    expect(config.session.dataDir).toBe(resolveBotmuxDataDir());
  });

  it('never resolves to an install-relative ../data path', async () => {
    delete process.env.SESSION_DATA_DIR;
    const { config } = await import('../src/config.js');
    const dir = config.session.dataDir;
    // The old fallback was `new URL('../data', import.meta.url)` → it sat next to
    // the installed dist/ (and inside a compiled binary, under /$bunfs).
    expect(dir).not.toMatch(/\/dist\/\.\.\/data$/);
    expect(dir.startsWith('/$bunfs')).toBe(false);
    // Canonical shape is HOME-based.
    expect(dir.endsWith('/.botmux/data') || dir === resolveBotmuxDataDir()).toBe(true);
  });

  it('still honors an explicit SESSION_DATA_DIR set after import (lazy getter)', async () => {
    const { config } = await import('../src/config.js');
    process.env.SESSION_DATA_DIR = '/explicit/after/import';
    // Must stay a getter, not a value frozen at module-eval time — cli.ts
    // subcommands set this env after config.ts is already loaded.
    expect(config.session.dataDir).toBe('/explicit/after/import');
  });
});

describe('layer A — the supervisor pins SESSION_DATA_DIR for every member', () => {
  it('injects the canonical data dir when the operator has not pinned one', () => {
    delete process.env.SESSION_DATA_DIR;
    const env = resolveFleetDaemonEnv();
    // Readers that check the raw env (and degrade without it) must find it set.
    expect(env.SESSION_DATA_DIR).toBeTruthy();
    expect(env.SESSION_DATA_DIR).toBe(resolveBotmuxDataDir());
  });

  it('never overrides an explicit operator SESSION_DATA_DIR', () => {
    process.env.SESSION_DATA_DIR = '/operator/pinned/dir';
    expect(resolveFleetDaemonEnv().SESSION_DATA_DIR).toBe('/operator/pinned/dir');
  });

  it('treats a blank SESSION_DATA_DIR as unset rather than propagating it', () => {
    process.env.SESSION_DATA_DIR = '   ';
    const env = resolveFleetDaemonEnv();
    // A whitespace value would make every reader resolve('') → cwd. Fail safe.
    expect(env.SESSION_DATA_DIR?.trim()).toBeTruthy();
    expect(env.SESSION_DATA_DIR).toBe(resolveBotmuxDataDir());
  });

  it('resolves against a HOME-scoped breadcrumb when one exists', () => {
    const home = tmp();
    const dataDir = join(home, 'custom-store');
    mkdirSync(join(home, '.botmux'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(home, '.botmux', '.data-dir'), dataDir);
    delete process.env.SESSION_DATA_DIR;
    process.env.HOME = home;
    // The canonical resolver honors the breadcrumb; the injected env must follow
    // it, not silently pick ~/.botmux/data.
    expect(resolveFleetDaemonEnv().SESSION_DATA_DIR).toBe(dataDir);
  });

  it('gives the dashboard the SAME data dir as the bot daemons', () => {
    delete process.env.SESSION_DATA_DIR;
    // One shared env object feeds every member the supervisor spawns, so the
    // dashboard cannot drift onto another store (the old ecosystem comment:
    // a diverged dashboard breaks /pair, reports hubsSynced:0, answers
    // remote-group not_a_member).
    const env = resolveFleetDaemonEnv();
    const members = resolveFleetMembers();
    const dashboard = members.find((m) => m.name === resolveDashboardSpec().name);
    expect(dashboard).toBeDefined();
    // The dashboard is spawned from this same daemonEnv (fleet-supervisor passes
    // opts.daemonEnv to every member; only 'daemon' entries add BOTMUX_BOT_INDEX).
    expect(env.SESSION_DATA_DIR).toBe(resolveBotmuxDataDir());
  });
});
