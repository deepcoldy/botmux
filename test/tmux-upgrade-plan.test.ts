import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PlatformInfo } from '../src/setup/detect-platform.js';
import { TMUX_RECOMMENDED_MIN, parseTmuxRelease } from '../src/setup/tmux-recommended.js';
import {
  executeTmuxUpgrade,
  isSafePackageVersion,
  parseAptMadison,
  parseRepoqueryVersions,
  pickCandidate,
  planTmuxUpgrade,
  readDebianCodename,
  spawnUpgradeCommand,
  type PackageCandidate,
  type SystemPackageManager,
  type TmuxUpgradeProbe,
  type UpgradeCommandRunner,
} from '../src/setup/tmux-upgrade-plan.js';

const min = parseTmuxRelease(TMUX_RECOMMENDED_MIN.version)!;
/** Releases relative to the live recommendation (not pinned literals). */
const BELOW = `${min.major}.${min.minor - 1}a`;
const ABOVE = `${min.major}.${min.minor + 1}a`;

function platform(over: Partial<PlatformInfo> = {}): PlatformInfo {
  return {
    os: 'linux',
    distro: 'debian',
    packageManagers: ['apt'],
    isRoot: true,
    hasTty: false,
    passwordlessSudo: true,
    ...over,
  };
}

function probe(over: Partial<TmuxUpgradeProbe> & { platform?: PlatformInfo } = {}): TmuxUpgradeProbe {
  return {
    platform: platform(),
    resolveTmux: () => ({ path: '/usr/bin/tmux', realPath: '/usr/bin/tmux' }),
    which: () => null,
    brewPrefix: () => null,
    exists: () => false,
    condaOwnsTmux: () => false,
    systemPackageInstalled: () => true,
    packageCandidates: () => [
      { packageVersion: `${BELOW}-3`, release: BELOW },
      { packageVersion: `${ABOVE}-2~bpo12+1`, release: ABOVE },
    ],
    ...over,
  };
}

describe('planTmuxUpgrade: who owns the tmux botmux runs', () => {
  it('apt-owned /usr/bin/tmux with a ≥min candidate (e.g. backports) → one-click', async () => {
    const plan = await planTmuxUpgrade(probe());
    expect(plan).toMatchObject({ auto: true, owner: { kind: 'system', pm: 'apt' }, candidate: ABOVE, tmuxPath: '/usr/bin/tmux' });
    expect(plan.auto && plan.display).toContain('apt-get update');
  });

  it('apt without any ≥min candidate → no button, Debian backports hint', async () => {
    const plan = await planTmuxUpgrade(probe({
      packageCandidates: () => [{ packageVersion: `${BELOW}-3`, release: BELOW }],
    }), { debianCodename: 'bookworm' });
    expect(plan).toMatchObject({ auto: false, reason: 'no_candidate', candidate: BELOW });
    expect(!plan.auto && plan.hint).toContain('bookworm-backports');
  });

  it('a non-Debian distro without a candidate gets the Homebrew / conda way out instead', async () => {
    const plan = await planTmuxUpgrade(probe({
      platform: platform({ distro: 'ubuntu' }),
      packageCandidates: () => [{ packageVersion: '3.2a-4ubuntu0.2', release: '3.2a' }],
    }), { debianCodename: 'jammy' });
    expect(plan).toMatchObject({ auto: false, reason: 'no_candidate' });
    expect(!plan.auto && plan.hint).not.toContain('backports');
    expect(!plan.auto && plan.hint).toContain('brew');
  });

  it('needs a password for sudo → manual command, never an interactive prompt', async () => {
    const plan = await planTmuxUpgrade(probe({
      platform: platform({ isRoot: false, passwordlessSudo: false, hasTty: true }),
    }));
    expect(plan).toMatchObject({ auto: false, reason: 'needs_sudo' });
    expect(!plan.auto && plan.manualCommand).toContain('sudo apt-get');
  });

  it('NOPASSWD sudo runs non-interactively (sudo -n)', async () => {
    const plan = await planTmuxUpgrade(probe({ platform: platform({ isRoot: false, passwordlessSudo: true }) }));
    expect(plan.auto && plan.display).toMatch(/^sudo -n apt-get update && sudo -n apt-get install/);
  });

  it('a hand-placed binary (e.g. ~/.local/bin/tmux) is never touched', async () => {
    const plan = await planTmuxUpgrade(probe({
      resolveTmux: () => ({ path: '/home/u/.local/bin/tmux', realPath: '/home/u/.local/bin/tmux' }),
    }));
    expect(plan).toEqual({ auto: false, reason: 'unmanaged_binary', tmuxPath: '/home/u/.local/bin/tmux' });
  });

  it('/usr/bin/tmux the package manager does not know about is unmanaged too', async () => {
    const plan = await planTmuxUpgrade(probe({ systemPackageInstalled: () => false }));
    expect(plan).toMatchObject({ auto: false, reason: 'unmanaged_binary' });
  });

  it('Homebrew only when the binary is in Homebrew\'s own tmux keg', async () => {
    const brew = probe({
      platform: platform({ os: 'darwin', distro: 'unknown', packageManagers: ['brew'] }),
      which: name => (name === 'brew' ? '/opt/homebrew/bin/brew' : null),
      brewPrefix: () => '/opt/homebrew',
      resolveTmux: () => ({ path: '/opt/homebrew/bin/tmux', realPath: '/opt/homebrew/Cellar/tmux/3.3a/bin/tmux' }),
    });
    expect(await planTmuxUpgrade(brew)).toMatchObject({ auto: true, owner: { kind: 'brew', brewBin: '/opt/homebrew/bin/brew' } });

    // An Intel Mac's /usr/local is Homebrew's prefix AND home to source builds.
    const sourceBuild = probe({
      platform: platform({ os: 'darwin', distro: 'unknown', packageManagers: ['brew'] }),
      which: name => (name === 'brew' ? '/usr/local/bin/brew' : null),
      brewPrefix: () => '/usr/local',
      resolveTmux: () => ({ path: '/usr/local/bin/tmux', realPath: '/usr/local/bin/tmux' }),
    });
    expect(await planTmuxUpgrade(sourceBuild)).toMatchObject({ auto: false, reason: 'unmanaged_binary' });
  });

  it('conda only when conda-meta records tmux in that prefix', async () => {
    const conda = (owns: boolean) => probe({
      platform: platform({ packageManagers: ['conda', 'apt'] }),
      resolveTmux: () => ({ path: '/opt/conda/bin/tmux', realPath: '/opt/conda/bin/tmux' }),
      which: name => (name === 'conda' ? '/opt/conda/bin/conda' : null),
      exists: p => p === '/opt/conda/conda-meta',
      condaOwnsTmux: () => owns,
    });
    const plan = await planTmuxUpgrade(conda(true));
    expect(plan).toMatchObject({ auto: true, owner: { kind: 'conda', prefix: '/opt/conda' } });
    expect(plan.auto && plan.display).toContain(`tmux>=${TMUX_RECOMMENDED_MIN.version}`);
    expect(await planTmuxUpgrade(conda(false))).toMatchObject({ auto: false, reason: 'unmanaged_binary' });
  });

  it('unknown candidate list (no metadata) still offers the button; the result is verified afterwards', async () => {
    const plan = await planTmuxUpgrade(probe({
      platform: platform({ distro: 'rocky', packageManagers: ['dnf'] }),
      packageCandidates: () => null,
    }));
    expect(plan).toMatchObject({ auto: true, owner: { kind: 'system', pm: 'dnf' } });
  });

  it('missing tmux / unsupported OS → no button', async () => {
    expect(await planTmuxUpgrade(probe({ resolveTmux: () => null }))).toMatchObject({ auto: false, reason: 'tmux_missing' });
    expect(await planTmuxUpgrade(probe({ platform: platform({ os: 'other' }) }))).toMatchObject({ auto: false, reason: 'unsupported_platform' });
  });
});

describe('package source parsing', () => {
  it('apt-cache madison → upstream releases, keeping the exact Debian version for the pin', async () => {
    const text = [
      `      tmux | ${ABOVE}-2~bpo12+1 | http://deb.debian.org/debian bookworm-backports/main amd64 Packages`,
      `      tmux | ${BELOW}-3 | http://deb.debian.org/debian bookworm/main amd64 Packages`,
      `      tmux | 1:${BELOW}-3 | http://mirror bookworm/main amd64 Packages`,
      '   other | 9.9-1 | http://x y',
      `      tmux | ${ABOVE}-2;rm -rf / | http://evil x`,
    ].join('\n');
    expect(parseAptMadison(text)).toEqual([
      { packageVersion: `${ABOVE}-2~bpo12+1`, release: ABOVE },
      { packageVersion: `${BELOW}-3`, release: BELOW },
      { packageVersion: `1:${BELOW}-3`, release: BELOW },
    ]);
  });

  it('repoquery output, one version per line', async () => {
    expect(parseRepoqueryVersions('3.2a\n\n3.5a\n%{version}\n')).toEqual([
      { packageVersion: '3.2a', release: '3.2a' },
      { packageVersion: '3.5a', release: '3.5a' },
    ]);
  });

  it('only plain version strings can become an argv pin', async () => {
    expect(isSafePackageVersion('3.5a-2~bpo12+1')).toBe(true);
    expect(isSafePackageVersion('1:3.5a-2')).toBe(true);
    for (const bad of ['', '-oAPT::x=1', '3.5a 4', '3.5a;id', '$(id)', 'a'.repeat(80)]) {
      expect(isSafePackageVersion(bad)).toBe(false);
    }
  });

  it('picks the highest candidate at or above the recommendation', async () => {
    const list: PackageCandidate[] = [
      { packageVersion: 'x1', release: BELOW },
      { packageVersion: 'x2', release: TMUX_RECOMMENDED_MIN.version },
      { packageVersion: 'x3', release: ABOVE },
    ];
    expect(pickCandidate(list)?.packageVersion).toBe('x3');
    expect(pickCandidate(list.slice(0, 1))).toBeUndefined();
  });

  it('reads the Debian codename for the backports hint', async () => {
    expect(readDebianCodename(() => 'ID=debian\nVERSION_CODENAME=bookworm\n')).toBe('bookworm');
    expect(readDebianCodename(() => 'VERSION_CODENAME="trixie"\n')).toBe('trixie');
    expect(readDebianCodename(() => { throw new Error('ENOENT'); })).toBeUndefined();
  });
});

describe('executeTmuxUpgrade (fake installer)', () => {
  type Call = { argv: string[]; env: NodeJS.ProcessEnv };
  function fakeRunner(script: (argv: string[]) => { code: number; lines?: string[]; timedOut?: boolean }) {
    const calls: Call[] = [];
    const run: UpgradeCommandRunner = async (argv, opts) => {
      calls.push({ argv, env: opts.env });
      const r = script(argv);
      for (const l of r.lines ?? []) opts.onLine(l);
      return { code: r.timedOut ? null : r.code, signal: r.timedOut ? 'SIGKILL' : null, timedOut: !!r.timedOut };
    };
    return { calls, run };
  }
  type AutoPlan = Extract<Awaited<ReturnType<typeof planTmuxUpgrade>>, { auto: true }>;
  const aptPlan = () => planTmuxUpgrade(probe()) as Promise<AutoPlan>;

  it('apt: refreshes lists, then pins the best ≥min version from the REFRESHED lists', async () => {
    const { calls, run } = fakeRunner(() => ({ code: 0, lines: ['Reading package lists...'] }));
    const lines: string[] = [];
    const result = await executeTmuxUpgrade(await aptPlan(), {
      platform: platform(),
      run,
      onLine: l => lines.push(l),
      aptCandidates: () => [
        { packageVersion: `${ABOVE}-2~bpo12+1`, release: ABOVE },
        { packageVersion: `${min.major}.${min.minor + 2}-1~bpo12+1`, release: `${min.major}.${min.minor + 2}` },
      ],
      env: { PATH: '/usr/bin' },
    });
    expect(result).toMatchObject({ ok: true, selected: `${min.major}.${min.minor + 2}` });
    expect(calls.map(c => c.argv)).toEqual([
      ['apt-get', 'update'],
      ['apt-get', 'install', '-y', '--no-install-recommends', `tmux=${min.major}.${min.minor + 2}-1~bpo12+1`],
    ]);
    expect(calls[1]!.env.DEBIAN_FRONTEND).toBe('noninteractive');
    expect(lines).toContain('Reading package lists...');
  });

  it('apt: no ≥min version even after refresh → nothing is installed', async () => {
    const { calls, run } = fakeRunner(() => ({ code: 0 }));
    const result = await executeTmuxUpgrade(await aptPlan(), {
      platform: platform(),
      run,
      onLine: () => {},
      aptCandidates: () => [{ packageVersion: `${BELOW}-3`, release: BELOW }],
      env: {},
    });
    expect(result).toMatchObject({ ok: false, failure: 'no_candidate' });
    expect(calls.map(c => c.argv[0])).toEqual(['apt-get']); // update only
    expect(calls[0]!.argv).toEqual(['apt-get', 'update']);
  });

  it('a failed apt-get update is not fatal', async () => {
    const { calls, run } = fakeRunner(argv => ({ code: argv[1] === 'update' ? 100 : 0 }));
    const result = await executeTmuxUpgrade(await aptPlan(), {
      platform: platform(), run, onLine: () => {}, env: {},
      aptCandidates: () => [{ packageVersion: `${ABOVE}-1`, release: ABOVE }],
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('brew / conda / dnf use their own upgrade command; failures and timeouts are reported', async () => {
    const brewPlan = { auto: true as const, owner: { kind: 'brew' as const, brewBin: '/opt/homebrew/bin/brew' }, tmuxPath: '/opt/homebrew/bin/tmux', display: 'brew upgrade tmux' };
    const ok = fakeRunner(() => ({ code: 0 }));
    expect(await executeTmuxUpgrade(brewPlan, { platform: platform(), run: ok.run, onLine: () => {}, env: {} })).toMatchObject({ ok: true });
    expect(ok.calls[0]!.argv).toEqual(['/opt/homebrew/bin/brew', 'upgrade', 'tmux']);

    const fail = fakeRunner(() => ({ code: 1 }));
    expect(await executeTmuxUpgrade(brewPlan, { platform: platform(), run: fail.run, onLine: () => {}, env: {} }))
      .toMatchObject({ ok: false, failure: 'command_failed' });

    const slow = fakeRunner(() => ({ code: 0, timedOut: true }));
    const dnfPlan = { auto: true as const, owner: { kind: 'system' as const, pm: 'dnf' as SystemPackageManager }, tmuxPath: '/usr/bin/tmux', display: 'dnf upgrade -y tmux' };
    expect(await executeTmuxUpgrade(dnfPlan, { platform: platform(), run: slow.run, onLine: () => {}, env: {} }))
      .toMatchObject({ ok: false, failure: 'timed_out' });
    expect(slow.calls[0]!.argv).toEqual(['dnf', 'upgrade', '-y', 'tmux']);
  });

  it('refuses to escalate without root / NOPASSWD sudo', async () => {
    const { calls, run } = fakeRunner(() => ({ code: 0 }));
    const result = await executeTmuxUpgrade(await aptPlan(), {
      platform: platform({ isRoot: false, passwordlessSudo: false, hasTty: true }),
      run, onLine: () => {}, env: {},
    });
    expect(result).toMatchObject({ ok: false, failure: 'refused' });
    expect(calls).toHaveLength(0);
  });
});

describe('spawnUpgradeCommand', () => {
  it('streams stdout+stderr lines and reports the exit code', async () => {
    const lines: string[] = [];
    const r = await spawnUpgradeCommand(['/bin/sh', '-c', 'echo out1; echo err1 >&2; printf tail; exit 3'], {
      timeoutMs: 10_000, env: { PATH: '/usr/bin:/bin' }, onLine: l => lines.push(l),
    });
    expect(r).toMatchObject({ code: 3, timedOut: false });
    expect(lines).toEqual(expect.arrayContaining(['out1', 'err1', 'tail']));
  });

  it.runIf(process.platform === 'linux')('writes to a file, not a pipe, so a daemon restart cannot SIGPIPE the installer; the file is removed', async () => {
    const lines: string[] = [];
    const r = await spawnUpgradeCommand(['/bin/sh', '-c', 'readlink /proc/self/fd/1; readlink /proc/self/fd/2'], {
      timeoutMs: 10_000, env: { PATH: '/usr/bin:/bin' }, onLine: l => lines.push(l),
    });
    expect(r.code).toBe(0);
    expect(lines).toHaveLength(2);
    for (const target of lines) {
      expect(target).not.toMatch(/^pipe:/);
      expect(target).toMatch(/botmux-tmux-upgrade-.*\.log$/);
      expect(existsSync(target)).toBe(false);
    }
  });

  it('kills the process group on timeout', async () => {
    const started = Date.now();
    const r = await spawnUpgradeCommand(['/bin/sh', '-c', 'sleep 30 & wait'], {
      timeoutMs: 200, env: { PATH: '/usr/bin:/bin' }, onLine: () => {},
    });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('a missing executable is an error, not a hang', async () => {
    const r = await spawnUpgradeCommand(['/nonexistent/definitely-not-here'], {
      timeoutMs: 5_000, env: {}, onLine: () => {},
    });
    expect(r.code).toBeNull();
    expect(r.error).toBeTruthy();
  });
});
