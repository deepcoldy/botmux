import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BOTS_CONFIG_ENV,
  resolveBotmuxConfigDir,
  resolveBotsConfigFile,
  resolveChildBotsConfig,
} from '../src/core/config-dir.js';
import {
  BOTMUX_INJECTED_ENV_KEYS,
  isBotmuxManagedTmuxEnvKey,
  isBotmuxManagedTmuxServerGlobalEnvKey,
} from '../src/utils/child-env.js';
import { isReservedPerBotEnvKey, sanitizePerBotEnv } from '../src/core/per-bot-env.js';
import { shellWrapperScript } from '../src/adapters/backend/tmux-backend.js';
import { tmuxEnv } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker } from '../src/types.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

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
  it('derives the config dir from os.homedir(), which on POSIX follows $HOME', () => {
    // The relocation this PR relies on is Node's own: on POSIX homedir() reads
    // $HOME, so `HOME=~/alt botmux start` moves the config dir with no extra code.
    const home = root();
    const saved = process.env.HOME;
    try {
      process.env.HOME = home;
      expect(resolveBotmuxConfigDir()).toBe(join(home, '.botmux'));
      expect(resolveBotmuxConfigDir()).toBe(join(homedir(), '.botmux'));
    } finally {
      if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    }
  });

  it('uses the homeDir seam for custom homes, and IGNORES env entirely', () => {
    // Production passes nothing; tests override through the seam. env must have
    // no say in the home half — that is what keeps this in lock-step with cli.ts.
    const seam = root();
    expect(resolveBotmuxConfigDir({ homeDir: seam })).toBe(join(seam, '.botmux'));
    expect(resolveBotmuxConfigDir({ env: { HOME: '/env-home', USERPROFILE: '/env-profile' } }))
      .toBe(join(homedir(), '.botmux'));
  });

  it('REGRESSION (win32): does not fork from cli.ts when HOME and USERPROFILE differ', () => {
    // Node's contract (os.homedir()): POSIX follows $HOME; win32 follows
    // %USERPROFILE% and NEVER consults HOME. A HOME-first rule therefore forks
    // from cli.ts's `join(homedir(), '.botmux')` on win32 whenever both vars are
    // set to different values (Git-for-Windows / MSYS shells set HOME) —
    // setup/start/PM2 would write %USERPROFILE%\.botmux while the daemon's
    // registry read %HOME%\.botmux, recreating the very split this module closes.
    // Guard the property directly: whatever env says, the config dir tracks the
    // SAME homedir() that cli.ts uses.
    const env = { HOME: 'C:\\fleet-home', USERPROFILE: 'C:\\Users\\alice' };
    const cliRule = join(homedir(), '.botmux');   // cli.ts:207
    expect(resolveBotmuxConfigDir({ env })).toBe(cliRule);
    expect(resolveBotmuxConfigDir({ env })).not.toBe(join(env.HOME, '.botmux'));
    // ...and the registry path built on top of it agrees too.
    expect(resolveBotsConfigFile({ env })).toBe(join(cliRule, 'bots.json'));
  });

  it('never yields a RELATIVE (cwd-dependent) config dir, even for HOME=""', () => {
    // Platform-independent half of the same defect: `??` is nullish, so an empty
    // HOME would be accepted as a real value and join('', '.botmux') gives the
    // relative '.botmux' — a registry that moves with cwd.
    expect(isAbsolute(resolveBotmuxConfigDir({ env: { HOME: '', USERPROFILE: '' } }))).toBe(true);
    expect(resolveBotmuxConfigDir({ env: { HOME: '' } })).toBe(join(homedir(), '.botmux'));
  });
});

describe('resolveBotsConfigFile', () => {
  it('honours BOTS_CONFIG as the exact file, above the homedir-derived default', () => {
    const explicit = join(root(), 'fleet-a.json');
    expect(resolveBotsConfigFile({ env: { [BOTS_CONFIG_ENV]: explicit } }))
      .toBe(explicit);
    expect(resolveBotsConfigFile({ env: {} }))
      .toBe(join(homedir(), '.botmux', 'bots.json'));
  });

  it('mirrors the loader: BOTS_CONFIG may name ANY filename, not just bots.json', () => {
    // The whole reason the child is pinned to a FILE and not a config DIR: a
    // dir + hardcoded 'bots.json' cannot express this deployment at all.
    const custom = join(root(), 'nested', 'fleet-a.json');
    expect(resolveBotsConfigFile({ env: { [BOTS_CONFIG_ENV]: custom } }))
      .toBe(custom);
  });
});

describe('resolveChildBotsConfig — what the daemon pins onto its CLI child', () => {
  it('pins a real LOADED path verbatim, including a custom filename', () => {
    const loaded = join(root(), 'fleet-a.json');
    writeFileSync(loaded, '[]');
    expect(resolveChildBotsConfig(loaded, 'loaded')).toBe(loaded);
  });

  it('returns null with no loaded path, so the caller DELETES an inherited value', () => {
    // Leaving a stale ambient BOTS_CONFIG in place would redirect the child to a
    // foreign registry — BOTS_CONFIG is the TOP of the precedence chain.
    expect(resolveChildBotsConfig(undefined, 'loaded')).toBeNull();
    expect(resolveChildBotsConfig('', 'loaded')).toBeNull();
    expect(resolveChildBotsConfig('   ', 'loaded')).toBeNull();
  });

  it('OMITS a core-only SYNTHETIC placeholder even when that file exists', () => {
    // Core-only pins <config dir>/bots.json purely for the fs-policy authority
    // root and never parses it. Existence must not promote it to an authority:
    // the pre-fix existsSync probe pinned exactly this never-loaded file.
    const neverParsed = join(root(), 'bots.json');
    writeFileSync(neverParsed, '[]');
    expect(existsSync(neverParsed)).toBe(true);          // positive control
    expect(resolveChildBotsConfig(neverParsed, 'synthetic')).toBeNull();
  });

  it('PINS a loaded path that has since VANISHED (no fail-open to another registry)', () => {
    // THE round-2 blocker. Existence is not provenance: a real loaded config that
    // was rotated/unmounted must keep its pin so the child fails loudly, instead
    // of silently resolving <its own HOME>/.botmux/bots.json — a DIFFERENT fleet.
    const vanished = join(root(), 'fleet-loaded-then-removed.json');
    expect(existsSync(vanished)).toBe(false);            // positive control
    expect(resolveChildBotsConfig(vanished, 'loaded')).toBe(vanished);
  });

  it('treats an unknown/absent provenance as NOT an authority (fail closed)', () => {
    expect(resolveChildBotsConfig('/srv/fleet.json', undefined)).toBeNull();
  });

  it('absolute-izes a relative loaded path (daemon/worker/pane share no cwd)', () => {
    expect(resolveChildBotsConfig('rel/bots.json', 'loaded')).toBe(resolvePath('rel/bots.json'));
  });
});

describe('regression: a daemon under a non-default HOME and its child agree', () => {
  it('the child resolves the daemon registry despite its own HOME differing', () => {
    const fleetHome = root();
    const defaultHome = root();
    const fleetConfig = join(fleetHome, '.botmux', 'bots.json');

    // Before: the child re-derived the registry from its own (default) home.
    expect(resolveBotsConfigFile({ homeDir: defaultHome })).not.toBe(fleetConfig);

    // After: the daemon pins the exact file it loaded, so the child agrees even
    // though its own home still points at the default one.
    const pinned = resolveChildBotsConfig(fleetConfig, 'loaded');
    expect(pinned).toBe(fleetConfig);
    expect(resolveBotsConfigFile({ homeDir: defaultHome, env: { [BOTS_CONFIG_ENV]: pinned! } }))
      .toBe(fleetConfig);
  });

  it('the pin OUTRANKS a stale ambient BOTS_CONFIG (the original blocker)', () => {
    // A shared tmux server carries a co-tenant's BOTS_CONFIG in its global env.
    // Pinning a config DIR would rank BELOW it and lose; pinning BOTS_CONFIG
    // itself replaces it.
    const stale = join(root(), 'stale-other.json');
    const correct = join(root(), 'correct.json');
    const childEnv: NodeJS.ProcessEnv = { [BOTS_CONFIG_ENV]: stale };
    childEnv[BOTS_CONFIG_ENV] = resolveChildBotsConfig(correct, 'loaded')!;
    expect(resolveBotsConfigFile({ env: childEnv })).toBe(correct);
  });
});

describe('regression (end-to-end): a VANISHED pin must never load a foreign registry', () => {
  // The round-2 blocker, exercised through the REAL loader in a REAL child
  // process — the resolver-level test above cannot prove what loadBotConfigs()
  // actually does with the verdict.
  //
  // Setup: the daemon parsed <fleet>/fleet-loaded.json ('loaded'), that file then
  // disappears, and the child's own HOME contains a DIFFERENT bots.json. Pre-fix
  // the pin was dropped and the child happily loaded the foreign registry.
  function bots(id: string): string {
    // Fake, non-credential secret: this fixture must never carry a real value.
    return JSON.stringify([
      { larkAppId: id, larkAppSecret: 'SECRET_REDACTED', cliId: 'claude-code' },
    ]);
  }

  function runChild(env: NodeJS.ProcessEnv): { loadedIds: string[] | null; err: string | null } {
    // Import by ABSOLUTE path: the script lives in a tmpdir, so a relative
    // specifier would resolve against that tmpdir instead of the repo. Run under
    // tsx because bot-registry.ts's own imports use `.js` specifiers for `.ts`
    // files, which plain --experimental-strip-types does not remap.
    const registry = resolvePath('src/bot-registry.ts');
    const script = [
      `const m = await import(${JSON.stringify(pathToFileURL(registry).href)});`,
      'let loadedIds = null, err = null;',
      'try { loadedIds = m.loadBotConfigs().map(b => b.larkAppId); }',
      'catch (e) { err = String(e && e.message || e); }',
      'console.log("CHILD_RESULT " + JSON.stringify({ loadedIds, err }));',
    ].join('\n');
    const file = join(root(), 'child.mts');
    writeFileSync(file, script);
    const out = execFileSync(resolvePath('node_modules/.bin/tsx'), [file], {
      cwd: resolvePath('.'),
      env: { ...process.env, ...env, BOTMUX_CORE_ONLY: '' },
      encoding: 'utf8',
    });
    const line = out.split('\n').find(l => l.startsWith('CHILD_RESULT '));
    if (!line) throw new Error(`child produced no result line:\n${out}`);
    return JSON.parse(line.slice('CHILD_RESULT '.length));
  }

  it('keeps the missing pin and FAILS, instead of loading the child HOME registry', () => {
    const fleetHome = root();
    const foreignHome = root();
    mkdirSync(join(foreignHome, '.botmux'), { recursive: true });
    writeFileSync(join(foreignHome, '.botmux', 'bots.json'), bots('cli_FOREIGN'));

    const vanished = join(fleetHome, 'fleet-loaded.json');   // parsed, then removed
    expect(existsSync(vanished)).toBe(false);

    // The daemon's verdict for this child (provenance 'loaded' survives the file).
    const pinned = resolveChildBotsConfig(vanished, 'loaded');
    expect(pinned).toBe(vanished);

    const res = runChild({ HOME: foreignHome, [BOTS_CONFIG_ENV]: pinned! });
    expect(res.loadedIds).toBeNull();
    expect(res.err).toContain('BOTS_CONFIG file not found');
    expect(res.err).toContain('refusing to fall back to a different registry');
    // The load must NOT have silently switched authority to the other fleet.
    expect(res.err).not.toContain('cli_FOREIGN');
  });

  it('positive control: the SAME child loads the foreign registry when nothing is pinned', () => {
    // Proves the fixture is real — the foreign registry IS reachable and would
    // have been loaded (this is exactly the pre-fix behaviour), so the assertion
    // above is not passing merely because the child could not load anything.
    const foreignHome = root();
    mkdirSync(join(foreignHome, '.botmux'), { recursive: true });
    writeFileSync(join(foreignHome, '.botmux', 'bots.json'), bots('cli_FOREIGN'));

    const res = runChild({ HOME: foreignHome, [BOTS_CONFIG_ENV]: '' });
    expect(res.err).toBeNull();
    expect(res.loadedIds).toEqual(['cli_FOREIGN']);
  });
});
describe('BOTS_CONFIG plumbing — all four leak vectors', () => {
  it('vector 1: injected into panes, so tmux matches the direct-spawn path', () => {
    // buildBotmuxEnvAssignments iterates this list; omitting the key would fix
    // only the pty backend and leave tmux sessions failing.
    expect(BOTMUX_INJECTED_ENV_KEYS).toContain(BOTS_CONFIG_ENV);
  });

  it('vector 2: stripped from the tmux CLIENT env, so no server global is seeded', () => {
    expect(isBotmuxManagedTmuxEnvKey(BOTS_CONFIG_ENV)).toBe(true);
    expect(isBotmuxManagedTmuxServerGlobalEnvKey(BOTS_CONFIG_ENV)).toBe(true);
    expect(tmuxEnv({ BOTS_CONFIG: '/tmp/stale.json' }).BOTS_CONFIG).toBeUndefined();
  });

  it('vector 3: unset in the pane wrapper, so a stale server global cannot win', () => {
    // The pane inherits the tmux SERVER's global env, which the client env
    // cannot override — so stripping the client env is not sufficient.
    expect(shellWrapperScript('/tmp/bin')).toMatch(/\bunset\b[^&]*\bBOTS_CONFIG\b/);
  });

  it('vector 4: reserved from per-bot env — a bot cannot redirect its own registry', () => {
    expect(isReservedPerBotEnvKey(BOTS_CONFIG_ENV)).toBe(true);
    expect(sanitizePerBotEnv({ [BOTS_CONFIG_ENV]: '/tmp/evil.json', KEEP: 'yes' }))
      .toEqual({ KEEP: 'yes' });
  });
});

describe('worker pins BOTS_CONFIG onto its CLI child by daemon-frozen provenance', () => {
  // Real worker child + fake CLI that reports what BOTS_CONFIG it was handed.
  // An inherited ambient value must never survive: BOTS_CONFIG tops the
  // registry precedence chain, so a stale one redirects the child to a foreign
  // registry. Only a LOADED authority is pinned.
  async function childBotsConfig(init: Partial<DaemonToWorker & { type: 'init' }>): Promise<string | null> {
    const dir = realpathSync(root());
    const report = join(dir, 'report.json');
    const cli = join(dir, 'fake-claude');
    writeFileSync(cli, `#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }\nrequire('node:fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify({ botsConfig: process.env.BOTS_CONFIG ?? null }));\nconsole.log('Ready >'); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
    const logs: string[] = [];
    const child = spawnNodeTsScript(resolvePath('src/worker.ts'), [], {
      cwd: resolvePath('.'),
      env: { ...process.env, HOME: dir, SESSION_DATA_DIR: join(dir, 'data'), BOTS_CONFIG: join(dir, 'foreign-fleet.json'), BOTMUX_NO_CLAIM: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', chunk => logs.push(String(chunk)));
    child.stderr?.on('data', chunk => logs.push(String(chunk)));
    try {
      child.send({ type: 'init', sessionId: `bots-config-${roots.length}`, chatId: 'oc_fixture', rootMessageId: 'om_fixture',
        workingDir: dir, cliId: 'claude-code', cliPathOverride: cli, backendType: 'pty', prompt: '', apiOnly: true,
        larkAppId: 'app_fixture', larkAppSecret: '', ...init } as DaemonToWorker);
      const deadline = Date.now() + 15_000;
      while (!existsSync(report) && child.exitCode === null && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 25));
      }
      expect(existsSync(report), logs.join('')).toBe(true);
      return JSON.parse(readFileSync(report, 'utf8')).botsConfig;
    } finally {
      const exited = new Promise(done => child.once('exit', done));
      if (child.connected) child.send({ type: 'close' }, () => {});
      const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
      if (child.exitCode === null && child.signalCode === null) await exited;
      clearTimeout(kill);
    }
  }

  it('deletes an inherited BOTS_CONFIG when the daemon loaded no registry', async () => {
    expect(await childBotsConfig({})).toBeNull();
  }, 30_000);

  it('deletes an inherited BOTS_CONFIG for a core-only synthetic placeholder', async () => {
    expect(await childBotsConfig({ loadedBotsConfigPath: '/srv/fleet/bots.json', loadedBotsConfigProvenance: 'synthetic' }))
      .toBeNull();
  }, 30_000);

  it('replaces it with the exact file the daemon loaded', async () => {
    expect(await childBotsConfig({ loadedBotsConfigPath: '/srv/fleet/fleet-loaded.json', loadedBotsConfigProvenance: 'loaded' }))
      .toBe('/srv/fleet/fleet-loaded.json');
  }, 30_000);
});

describe('registry provenance tracks every config resolution', () => {
  it('records loaded vs synthetic on each resolution, never keeping a stale verdict', async () => {
    const { loadBotConfigs, getLoadedConfigPath, getLoadedConfigProvenance } = await import('../src/bot-registry.js');
    const home = root();
    const homeBots = join(home, '.botmux', 'bots.json');
    const pinnedBots = join(root(), 'fleet.json');
    const fixture = JSON.stringify([{ larkAppId: 'cli_provenance', larkAppSecret: 'SECRET_REDACTED', cliId: 'claude-code' }]);
    mkdirSync(join(home, '.botmux'), { recursive: true });
    writeFileSync(homeBots, fixture);
    writeFileSync(pinnedBots, fixture);
    const keys = ['HOME', 'BOTS_CONFIG', 'BOTMUX_CORE_ONLY'] as const;
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const load = (env: Partial<Record<(typeof keys)[number], string | undefined>>) => {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      loadBotConfigs();
      return [getLoadedConfigProvenance(), getLoadedConfigPath()];
    };
    try {
      expect(load({ HOME: home, BOTS_CONFIG: undefined, BOTMUX_CORE_ONLY: '1' })).toEqual(['synthetic', homeBots]);
      expect(load({ BOTMUX_CORE_ONLY: undefined, BOTS_CONFIG: pinnedBots })).toEqual(['loaded', pinnedBots]);
      expect(load({ BOTS_CONFIG: undefined, BOTMUX_CORE_ONLY: '1' })).toEqual(['synthetic', homeBots]);
      expect(load({ BOTMUX_CORE_ONLY: undefined })).toEqual(['loaded', homeBots]);
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});
