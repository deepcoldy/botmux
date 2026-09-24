import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginRegistryPath } from '../src/core/plugins/paths.js';
import {
  readPluginRegistry,
  removeInstalledPlugin,
  upsertInstalledPlugin,
  writePluginRegistry,
} from '../src/services/plugin-registry-store.js';
import { accessForPath, buildFsPolicy, type FsPolicyContext } from '../src/adapters/cli/fs-policy.js';
import { resolve } from 'node:path';
import type { InstalledPluginRecord } from '../src/core/plugins/types.js';

/**
 * A sandboxed bot gets `~/.botmux/plugins-registry.json` read-only and nothing
 * else under `~/.botmux`. Before this fix `botmux plugin list` died with
 * `EPERM: operation not permitted, open '.../plugins-registry.json.lock'`,
 * because the READ path serializes on a lock file it has no authority to create.
 *
 * The tests below reproduce that with filesystem modes rather than a real
 * sandbox: a `~/.botmux` that is `r-x` (0o500) denies the lock create exactly
 * the way the seatbelt/bwrap policy does, while leaving the registry readable.
 */
const record = (id: string, contributions?: unknown): InstalledPluginRecord => ({
  id,
  packageName: `@botmux/plugin-${id}`,
  version: '1.0.0',
  manifest: { schemaVersion: 1, id },
  ...(contributions === undefined ? {} : { contributions }),
} as InstalledPluginRecord);

describe('plugin registry reads survive a read-only ~/.botmux (sandboxed bot)', () => {
  let home: string;
  let botmuxHome: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-plugin-ro-'));
    vi.stubEnv('HOME', home);
    botmuxHome = join(home, '.botmux');
    mkdirSync(botmuxHome, { recursive: true });
  });

  afterEach(() => {
    // Restore write access before cleanup, else rmSync cannot unlink.
    try { chmodSync(botmuxHome, 0o700); } catch { /* already gone */ }
    try { chmodSync(pluginRegistryPath(), 0o600); } catch { /* may not exist */ }
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  /** Freeze `~/.botmux` the way the sandbox does: readable + traversable, not writable. */
  const freezeBotmuxHome = () => chmodSync(botmuxHome, 0o500);

  it('lists installed plugins when the lock file cannot be created', () => {
    upsertInstalledPlugin(record('data-mcp'));
    freezeBotmuxHome();

    // Sanity: the condition under test is really "cannot create the lock".
    expect(() => writeFileSync(`${pluginRegistryPath()}.lock`, '')).toThrow();

    expect(Object.keys(readPluginRegistry().plugins)).toEqual(['data-mcp']);
    expect(existsSync(`${pluginRegistryPath()}.lock`)).toBe(false);
  });

  it('reports an empty registry only when the file is genuinely absent', () => {
    freezeBotmuxHome();
    expect(readPluginRegistry().plugins).toEqual({});
  });

  it('never answers "no plugins installed" for an UNREADABLE registry', () => {
    upsertInstalledPlugin(record('data-mcp'));
    chmodSync(pluginRegistryPath(), 0o000);
    freezeBotmuxHome();

    // The silent-zero answer is the bug: it is byte-identical to a clean host.
    expect(() => readPluginRegistry()).toThrow(/EACCES|EPERM/);
  });

  it('projects a legacy inline MCP descriptor to its public shape, leaking no command/env', () => {
    upsertInstalledPlugin(record('data-mcp'));
    // Hand-write the pre-migration shape: the whole server descriptor inline.
    writeFileSync(pluginRegistryPath(), JSON.stringify({
      schemaVersion: 1,
      plugins: {
        'data-mcp': {
          ...record('data-mcp'),
          contributions: {
            mcp: { name: 'data-mcp', transport: 'stdio', command: ['node', 'server.js'], env: { TOKEN: 's3cret' } },
          },
        },
      },
    }));
    freezeBotmuxHome();

    const mcp = (readPluginRegistry().plugins['data-mcp']!.contributions as { mcp: Record<string, unknown> }).mcp;
    expect(mcp.name).toBe('data-mcp');
    expect(mcp.privateRef).toBe('private/mcp.json');
    expect(mcp.command).toBeUndefined();
    expect(mcp.env).toBeUndefined();
    // The registry on disk is untouched — the degraded read never migrates.
    expect(readFileSync(pluginRegistryPath(), 'utf-8')).toContain('s3cret');
  });

  it('refuses a record whose public-shaped mcp still carries private fields', () => {
    // The other half of the anti-leak check: `privateRef` present (so it passes the
    // public-shape test) AND `env` present. The degraded read must NOT hand this
    // record to a caller that has no authority to migrate it — this is the only
    // gate stopping a private descriptor field from being served.
    upsertInstalledPlugin(record('data-mcp'));
    writeFileSync(pluginRegistryPath(), JSON.stringify({
      schemaVersion: 1,
      plugins: {
        'data-mcp': {
          ...record('data-mcp'),
          contributions: {
            mcp: { name: 'data-mcp', transport: 'stdio', privateRef: 'private/mcp.json', env: { TOKEN: 's3cret' } },
          },
        },
      },
    }));
    freezeBotmuxHome();

    expect(() => readPluginRegistry()).toThrow(/invalid_plugin_mcp_contribution/);
  });

  it('degrades when the lock is fine but the MIGRATION cannot write (bwrap shape)', () => {
    // Linux/bwrap: `~/.botmux` is writable (the ro-bind auto-creates it), so the lock
    // IS created and the migrating path runs — then the WRITE fails. Reproduced by
    // leaving `~/.botmux` writable and freezing the plugin dir so the migration cannot
    // create the private dir it wants to move the descriptor into.
    //
    // Freezing `plugins/<id>/private` itself does NOT work: `assertPrivateStorageLayout`
    // chmods an existing private dir back to 0o700, so the write would succeed and this
    // test would silently re-test the happy path. Freeze the PARENT and leave `private`
    // absent — mkdir inside a 0o500 dir fails, and nothing can chmod what it never made.
    upsertInstalledPlugin(record('data-mcp'));
    writeFileSync(pluginRegistryPath(), JSON.stringify({
      schemaVersion: 1,
      plugins: {
        'data-mcp': {
          ...record('data-mcp'),
          contributions: {
            mcp: { name: 'data-mcp', transport: 'stdio', command: ['node', 'server.js'], env: { TOKEN: 's3cret' } },
          },
        },
      },
    }));
    const pluginDir = join(botmuxHome, 'plugins', 'data-mcp');
    mkdirSync(pluginDir, { recursive: true });
    chmodSync(pluginDir, 0o500);

    try {
      // Sanity: the lock really is creatable — otherwise this would re-test the
      // EPERM path instead of the migration path.
      writeFileSync(`${pluginRegistryPath()}.lock`, '');
      rmSync(`${pluginRegistryPath()}.lock`);

      const mcp = (readPluginRegistry().plugins['data-mcp']!.contributions as { mcp: Record<string, unknown> }).mcp;
      expect(mcp.privateRef).toBe('private/mcp.json');
      expect(mcp.command).toBeUndefined();
      expect(mcp.env).toBeUndefined();
      // The distinguishing assertion: a SUCCESSFUL migration would have rewritten the
      // registry without the secret. It is still there, so what we just read really is
      // the non-migrating projection.
      expect(readFileSync(pluginRegistryPath(), 'utf-8')).toContain('s3cret');
    } finally {
      chmodSync(pluginDir, 0o700);
    }
  });

  it('degrades ONLY for unwritability — a security-relevant layout error still surfaces', () => {
    // The degrade must not become a blanket catch for everything the migration can
    // throw. `unsafe_plugin_private_dir` means someone replaced the private dir with
    // a symlink; that has to reach the caller, not be quietly replaced by a
    // projection. It arrives wrapped in the same `plugin_mcp_registry_migration_failed:`
    // prefix as the writability failures, so only the errno on `.cause` tells them
    // apart.
    upsertInstalledPlugin(record('data-mcp'));
    writeFileSync(pluginRegistryPath(), JSON.stringify({
      schemaVersion: 1,
      plugins: {
        'data-mcp': {
          ...record('data-mcp'),
          contributions: {
            mcp: { name: 'data-mcp', transport: 'stdio', command: ['node', 'server.js'] },
          },
        },
      },
    }));
    const pluginDir = join(botmuxHome, 'plugins', 'data-mcp');
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(pluginDir, 'private'));

    expect(() => readPluginRegistry()).toThrow(/unsafe_plugin_private_dir/);
  });

  it('keeps writers fail-loud under the same condition', () => {
    upsertInstalledPlugin(record('data-mcp'));
    freezeBotmuxHome();

    expect(() => upsertInstalledPlugin(record('other'))).toThrow(/EACCES|EPERM/);
    expect(() => removeInstalledPlugin('data-mcp')).toThrow(/EACCES|EPERM/);
    expect(() => writePluginRegistry({ schemaVersion: 1, plugins: {} })).toThrow(/EACCES|EPERM/);
  });
});

describe('fs-policy exposes the plugin registry read-only', () => {
  const ctx = (o: Partial<FsPolicyContext> = {}): FsPolicyContext => ({
    platform: 'darwin',
    homeDir: '/Users/u',
    botmuxHome: '/Users/u/.botmux',
    sessionDataDir: '/Users/u/.botmux/data',
    sessionId: 's',
    workingDir: '/Users/u/proj',
    currentAppId: 'cli_self',
    botHome: '/Users/u/.botmux/bots/cli_self',
    redirectedCliData: true,
    ...o,
  });

  for (const platform of ['darwin', 'linux'] as const) {
    it(`grants readOnly on ${platform} while the rest of ~/.botmux stays denied`, () => {
      const p = buildFsPolicy(ctx({ platform }));
      expect(accessForPath(p.rules, '/Users/u/.botmux/plugins-registry.json').access).toBe('readOnly');
      // The neighbours that must NOT come along: the private descriptor store and
      // the bots config / dashboard HMAC sitting in the same directory.
      expect(accessForPath(p.rules, '/Users/u/.botmux/plugins/data-mcp/private/mcp.json').access).not.toBe('readOnly');
      expect(accessForPath(p.rules, '/Users/u/.botmux/bots.json').access).not.toBe('readOnly');
      expect(accessForPath(p.rules, '/Users/u/.botmux/.dashboard-secret').access).not.toBe('readOnly');
    });
  }
});

/**
 * Making the registry readable is only half the answer for `botmux plugin list`:
 * the per-machine ENABLED set lives in `~/.botmux/config.json`, which the sandbox
 * deliberately keeps denied (it can hold voice credentials). `readGlobalConfig()`
 * swallows EPERM and returns {}, so a naive listing would print every plugin
 * WITHOUT the `enabled` flag — asserting "not enabled" from an unread file. The
 * listing must say "unknown" instead.
 *
 * Source-lock (cli.ts's plugin branch is not separately importable): pinned by
 * SEMANTICS, not by identifier spelling, so a correct refactor stays green.
 */
describe('plugin list distinguishes "not enabled" from "could not read the enabled set"', () => {
  const cliSource = readFileSync(resolve('src/cli.ts'), 'utf-8');

  it('classifies ANY unreadable global config as unknown, not just the deny errnos', () => {
    const fn = cliSource.slice(cliSource.indexOf('function readEnabledPluginIdsOrUnknown'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    // Reads the global config path, not some other file.
    expect(body).toMatch(/readFileSync\(globalConfigPath\(\)/);
    // Every read failure is "unknown". Keying on the errno is the bug: seatbelt
    // denies the read (EPERM) while bwrap never binds the file in (ENOENT), so an
    // errno filter works on macOS and silently does nothing on Linux.
    expect(body).toMatch(/catch\s*\{\s*return undefined;?\s*\}/);
    expect(body).not.toMatch(/EPERM|EACCES|ENOENT|\.code/);
  });

  it('the listing consumes the classifier and surfaces the unknown state', () => {
    const listBranch = cliSource.slice(cliSource.indexOf("if (sub === 'list' || sub === 'ls')"));
    const body = listBranch.slice(0, listBranch.indexOf('\n  if (sub ==='));
    // No direct readGlobalConfig() in the listing — that is the call that cannot
    // tell denied from empty.
    expect(body).not.toMatch(/readGlobalConfig\(\)/);
    // The unknown state must be visible in the output, not silently dropped.
    expect(body).toContain('enabled?');
    expect(body).toMatch(/undefined/);
  });
});
