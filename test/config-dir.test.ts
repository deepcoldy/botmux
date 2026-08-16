import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('worker spawnCli wiring (source lock)', () => {
  // P3 was a param-SHAPE bug that no resolver-level test could ever catch:
  // `resolveBotmuxConfigDir(process.env)` type-checks (a ProcessEnv is
  // structurally a valid options bag), so only the real call site proves it.
  const workerSource = readFileSync(resolvePath('src/worker.ts'), 'utf8');
  const workerPoolSource = readFileSync(resolvePath('src/core/worker-pool.ts'), 'utf8');
  const registrySource = readFileSync(resolvePath('src/bot-registry.ts'), 'utf8');

  it('pins on daemon-frozen PROVENANCE, not an existsSync probe or env re-derivation', () => {
    expect(workerSource).toContain(
      'resolveChildBotsConfig(\n      cfg.loadedBotsConfigPath,\n      cfg.loadedBotsConfigProvenance,\n    )',
    );
    // The existence probe is GONE: it conflated provenance with present
    // existence and so fail-opened to a foreign registry (round-2 blocker).
    expect(workerSource).not.toContain('resolveChildBotsConfig(cfg.loadedBotsConfigPath, { exists: existsSync })');
    // The old shape must be gone: a bare env map read as an options bag meant
    // any lowercase `env=` / `homeDir=` in the environment silently hijacked it.
    expect(workerSource).not.toContain('resolveBotmuxConfigDir(process.env)');
    // And the child must never be handed a re-derivation of its OWN environment.
    expect(workerSource).not.toContain('childEnv.BOTS_CONFIG = resolveBotsConfigFile');
  });

  it('assigns OR deletes, never leaving an inherited BOTS_CONFIG to chance', () => {
    const start = workerSource.indexOf('const pinned = resolveChildBotsConfig(');
    expect(start).toBeGreaterThan(-1);
    const block = workerSource.slice(start, start + 400);
    expect(block).toContain('if (pinned) childEnv.BOTS_CONFIG = pinned;');
    expect(block).toContain('else delete childEnv.BOTS_CONFIG;');
  });

  it('the daemon FREEZES provenance alongside the path into the worker init message', () => {
    expect(workerPoolSource).toContain('loadedBotsConfigProvenance: getLoadedConfigProvenance(),');
    expect(workerPoolSource).toContain('getLoadedConfigProvenance');
  });

  it('the registry records provenance at EVERY site that sets loadedConfigPath', () => {
    // A site that assigns the path but forgets the provenance would leave a stale
    // verdict from a previous resolution — so assert the pairing structurally.
    const assignments = [...registrySource.matchAll(/^\s*loadedConfigPath = .*$/gm)];
    expect(assignments.length).toBeGreaterThanOrEqual(3);
    for (const m of assignments) {
      const after = registrySource.slice(m.index!, m.index! + 700);
      expect(after, `provenance not set near: ${m[0].trim()}`)
        .toMatch(/loadedConfigProvenance = ('loaded'|'synthetic'|undefined)/);
    }
    // Core-only synthesis is the ONLY 'synthetic' producer.
    expect(registrySource).toContain("loadedConfigProvenance = 'synthetic';");
  });

  it('cli.ts and the registry share ONE home semantic (no win32 fork)', () => {
    // cli.ts owns setup/start/PM2_HOME/dashboard paths via
    // `join(homedir(), '.botmux')`. The registry's config dir must resolve from
    // the same homedir() — never a hand-rolled HOME/USERPROFILE precedence.
    const configDirSource = readFileSync(resolvePath('src/core/config-dir.ts'), 'utf8');
    expect(configDirSource).toContain("join(options.homeDir ?? homedir(), '.botmux')");
    // Strip comments before asserting the absence: the JSDoc deliberately QUOTES
    // the rejected rule to explain why it is wrong, and a naive substring check
    // would match that prose forever (and would also have passed pre-fix, when
    // the real code had it — i.e. it would be a toothless guard).
    const code = configDirSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('env.HOME');
    expect(code).not.toContain('env.USERPROFILE');
    expect(readFileSync(resolvePath('src/cli.ts'), 'utf8'))
      .toContain("const CONFIG_DIR = join(homedir(), '.botmux');");
  });
});
