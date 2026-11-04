import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBotmuxEnvAssignments, shellCommandArgv, shellWrapperScript } from '../src/adapters/backend/tmux-backend.js';
import { tmuxEnv } from '../src/setup/ensure-tmux.js';
import { isBotmuxManagedTmuxServerGlobalEnvKey } from '../src/utils/child-env.js';

type Pair = readonly [string, string];

// The turn-authored carrier: arbitrary git config contents, renumbered by the
// pane transport. Values deliberately include every shell metacharacter —
// assignments ride as env(1) argv items, so they must pass verbatim.
function probePairs(count: number): Pair[] {
  const values = Array.from({ length: count }, (_, i) => `value ${i}`);
  values[1] = 'quotes \'"; $(exit 91) `exit 92` = literal\nnext line';
  values[count - 1] = '';
  return values.map(value => ['botmuxprobe.value', value] as Pair);
}

// Ambient block the tmux SERVER global / rcfile could hold: the exact field
// shape — a pushed-up count with a few low-index pairs plus a high-index one.
function ambientPoison(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_COUNT: '14',
    GIT_CONFIG_KEY_0: 'stale.k0', GIT_CONFIG_VALUE_0: 'stale-v0',
    GIT_CONFIG_KEY_1: 'stale.k1', GIT_CONFIG_VALUE_1: 'stale-v1',
    GIT_CONFIG_KEY_2: 'stale.k2', GIT_CONFIG_VALUE_2: 'stale-v2',
    GIT_CONFIG_KEY_14: 'core.hooksPath', GIT_CONFIG_VALUE_14: '/tmp/gcw/evil-hooks',
    GIT_CONFIG_KEY_3_EXTRA: 'keep',
    GIT_CONFIG_VALUE_label: 'keep',
    ...extra,
  };
}

const baseEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

const SHELLS = [
  { name: 'sh', kind: 'sh' as const, bin: '/bin/sh', flags: [] as string[] },
  { name: 'bash', kind: 'bash' as const, bin: '/bin/bash', flags: ['-i'] as string[] },
  { name: 'zsh', kind: 'zsh' as const, bin: '/usr/bin/zsh', flags: ['-l', '-i'] as string[] },
  { name: 'fish', kind: 'fish' as const, bin: '/usr/bin/fish', flags: ['-i'] as string[] },
];

for (const shell of SHELLS) {
  const available = spawnSync(shell.bin, ['-c', 'exit 0']).status === 0;
  describe.skipIf(!available)(`${shell.name} Git config pane environment`, () => {
    function runPane(opts: {
      pairs?: Pair[];
      env?: NodeJS.ProcessEnv;
      ambient?: NodeJS.ProcessEnv;
      command: string[];
      home?: string;
    }) {
      const [bin, ...args] = shellCommandArgv(
        { shell: shell.bin, flags: shell.flags },
        shellWrapperScript('/usr/bin', shell.kind),
        [
          opts.home ?? tmpdir(),
          ...buildBotmuxEnvAssignments(opts.env ?? {}, undefined, undefined, opts.pairs),
          ...opts.command,
        ],
      );
      return spawnSync(bin, args, {
        env: { ...baseEnv, HOME: opts.home ?? tmpdir(), ...opts.ambient },
        encoding: 'utf8',
        timeout: 10_000,
      });
    }

    it.each([4, 7, 14, 19])('forwards all %i carrier entries through the shell and Git', (count) => {
      const pairs = probePairs(count);
      const result = runPane({ pairs, command: ['git', 'config', '--null', '--get-all', 'botmuxprobe.value'] });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(pairs.map(([, value]) => `${value}\0`).join(''));
    });

    it('rebuilds the carrier over ambient COUNT=14 / high-index pairs and ignores both', () => {
      const pairs = probePairs(3);
      const result = runPane({
        pairs,
        env: {},
        ambient: ambientPoison(),
        command: [
          'sh', '-c',
          'git config --null --get-all botmuxprobe.value; printf -- "---\\n"; echo "COUNT=$GIT_CONFIG_COUNT"; '
          + 'echo "HOOKS=[$(git config --get core.hooksPath 2>/dev/null)]"; '
          + 'echo "STALE=[$(git config --get stale.k0 2>/dev/null)]"',
        ],
      });
      expect(result.status, result.stderr).toBe(0);
      const [probeOut, meta] = result.stdout.split('---\n');
      expect(probeOut).toBe(pairs.map(([, value]) => `${value}\0`).join(''));
      expect(meta).toContain('COUNT=3');
      expect(meta).toContain('HOOKS=[]');
      expect(meta).toContain('STALE=[]');
    });

    it('keeps user variables that merely resemble pair names', () => {
      const result = runPane({ command: ['/usr/bin/env'], ambient: ambientPoison() });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toMatch(/^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)=/m);
      expect(result.stdout).toContain('GIT_CONFIG_KEY_3_EXTRA=keep\n');
      expect(result.stdout).toContain('GIT_CONFIG_VALUE_label=keep\n');
      expect(result.stdout).toContain('GIT_CONFIG_GLOBAL=/dev/null\n');
    });

    it('leaves Git usable (exit 1 on a missing key, never 128) with only a bare ambient COUNT', () => {
      const result = runPane({
        env: { GIT_CONFIG_COUNT: '14' },
        ambient: { GIT_CONFIG_COUNT: '14' },
        command: ['git', 'config', '--get', 'x.nonexistent'],
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).not.toContain('missing config');
    });

    // E1/E2: even if the worker-side env itself carried a full contiguous
    // external block (or a pushed-up count with gaps), the pane transport
    // trusts the carrier alone.
    it.each([
      ['external block filling the next indices', {
        GIT_CONFIG_COUNT: '4',
        GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/tmp/gcw/evil-hooks',
        GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '!f() { printf LEAK; }; f',
        GIT_CONFIG_KEY_2: 'url.https://evil/.insteadOf', GIT_CONFIG_VALUE_2: 'https://evil/',
        GIT_CONFIG_KEY_3: 'x.y', GIT_CONFIG_VALUE_3: 'z',
      }],
      ['half pair and gaps', {
        GIT_CONFIG_COUNT: '4',
        GIT_CONFIG_KEY_3: 'core.hooksPath',
        GIT_CONFIG_KEY_5: 'x.y', GIT_CONFIG_VALUE_5: 'z',
      }],
    ])('E-form: env-borne %s never reaches Git without a carrier', (_label, env) => {
      const result = runPane({
        env,
        ambient: { GIT_CONFIG_COUNT: '14' },
        command: [
          'sh', '-c',
          'echo "HOOKS=[$(git config --get core.hooksPath 2>/dev/null)]"; '
          + 'echo "HELPER=[$(git config --get credential.helper 2>/dev/null)]"; '
          + 'git config --get x.nonexistent; echo "git-exit=$?"',
        ],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('HOOKS=[]');
      expect(result.stdout).toContain('HELPER=[]');
      expect(result.stdout).toContain('git-exit=1');
    });
  });
}

// The unset prelude must not depend on the surrounding IFS. Interactive shells
// take it from rcfiles (sh/dash inherits an exported IFS): the historical
// defect made zsh abort the wrapper before the CLI started (its special builtin
// unset rejected one multi-word argument) and made bash/dash silently keep the
// stale pairs.
describe('pane unset prelude is IFS-independent', () => {
  const IFS_VALUES = ['', ' ', ':'] as const;

  function rcfileHome(shellKind: string, ifsValue: string): string {
    const home = mkdtempSync(join(tmpdir(), 'pr2203-ifs-'));
    const assignment = `IFS="${ifsValue}"`;
    if (shellKind === 'bash') writeFileSync(join(home, '.bashrc'), `${assignment}\n`);
    if (shellKind === 'zsh') {
      writeFileSync(join(home, '.zshrc'), `${assignment}\n`);
      writeFileSync(join(home, '.zshenv'), `${assignment}\n`);
    }
    if (shellKind === 'fish') {
      mkdirSync(join(home, '.config', 'fish'), { recursive: true });
      writeFileSync(join(home, '.config', 'fish', 'config.fish'), `set -g IFS "${ifsValue}"\n`);
    }
    return home;
  }

  for (const ifsValue of IFS_VALUES) {
    for (const shell of SHELLS) {
      const available = spawnSync(shell.bin, ['-c', 'exit 0']).status === 0;
      it.skipIf(!available)(`${shell.name} starts the CLI and strips pairs with IFS=${JSON.stringify(ifsValue)}`, () => {
        let home: string | undefined;
        if (shell.kind !== 'sh') home = rcfileHome(shell.kind, ifsValue);
        const cwd = home ?? tmpdir();
        const [bin, ...args] = shellCommandArgv(
          { shell: shell.bin, flags: shell.flags },
          shellWrapperScript('/usr/bin', shell.kind),
          [cwd, ...buildBotmuxEnvAssignments({}), 'sh', '-c',
            'echo "MARKER=$?"; echo "K0=[${GIT_CONFIG_KEY_0-x}]"; echo "K14=[${GIT_CONFIG_KEY_14-x}]"; echo "COUNT=[${GIT_CONFIG_COUNT-x}]"'],
        );
        try {
          const result = spawnSync(bin, args, {
            env: {
              ...baseEnv,
              HOME: cwd,
              ...(shell.kind === 'sh' ? { IFS: ifsValue } : {}),
              ...ambientPoison(),
            },
            encoding: 'utf8',
            timeout: 10_000,
          });
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain('MARKER=0');
          expect(result.stdout).toContain('K0=[x]');
          expect(result.stdout).toContain('K14=[x]');
          expect(result.stdout).toContain('COUNT=[x]');
        } finally {
          if (home) rmSync(home, { recursive: true, force: true });
        }
      });
    }
  }
});

// ── Non-shell transport contract ────────────────────────────────────────────

describe('git config carrier transport', () => {
  it('publishes COUNT and renumbered KEY/VALUE entries only from the carrier', () => {
    const assignments = buildBotmuxEnvAssignments(ambientPoison(), undefined, undefined, probePairs(3));
    expect(assignments).toContain('GIT_CONFIG_COUNT=3');
    expect(assignments).toContain('GIT_CONFIG_KEY_0=botmuxprobe.value');
    expect(assignments.some(a => /^GIT_CONFIG_(KEY|VALUE)_(?:[3-9]|\d{2})=/.test(a))).toBe(false);
    expect(assignments).not.toContain('GIT_CONFIG_KEY_0=stale.k0');
    expect(assignments).not.toContain('GIT_CONFIG_KEY_14=core.hooksPath');
  });

  it('zeroes an ambient count without a carrier and never emits numbered pairs', () => {
    const assignments = buildBotmuxEnvAssignments(ambientPoison());
    expect(assignments).toContain('GIT_CONFIG_COUNT=0');
    expect(assignments.some(a => /^GIT_CONFIG_(KEY|VALUE)_[0-9]+=/.test(a))).toBe(false);
  });

  it('does not emit COUNT=0 when neither a carrier nor an ambient count exists', () => {
    const assignments = buildBotmuxEnvAssignments({ PATH: '/x' });
    expect(assignments.some(a => a.startsWith('GIT_CONFIG_'))).toBe(false);
  });

  it('drops GIT_CONFIG_* entries attempted through per-bot env', () => {
    const assignments = buildBotmuxEnvAssignments(
      {},
      { GIT_CONFIG_COUNT: '9', GIT_CONFIG_KEY_7: 'core.hooksPath', GIT_CONFIG_VALUE_7: '/tmp/evil', OK: '1' },
      undefined,
      [['botmuxprobe.value', 'only']] as Pair[],
    );
    expect(assignments).toContain('GIT_CONFIG_COUNT=1');
    expect(assignments).not.toContain('GIT_CONFIG_KEY_7=core.hooksPath');
    expect(assignments).toContain('OK=1');
  });

  it('strips every numbered pair from the tmux client but leaves lookalike vars', () => {
    const client = tmuxEnv(ambientPoison());
    expect(Object.keys(client).filter(key => /^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)$/.test(key))).toEqual([]);
    expect(client.GIT_CONFIG_KEY_3_EXTRA).toBe('keep');
    expect(client.GIT_CONFIG_VALUE_label).toBe('keep');
  });

  it('never selects numbered pairs for shared-server global-env repair', () => {
    // A user-owned shared tmux server may legitimately hold GIT_CONFIG_KEY_*;
    // daemon startup repair must not delete them. COUNT still rides the
    // botmux injected allowlist and is repaired there.
    for (let i = 0; i < 19; i++) {
      expect(isBotmuxManagedTmuxServerGlobalEnvKey(`GIT_CONFIG_KEY_${i}`), `KEY_${i}`).toBe(false);
      expect(isBotmuxManagedTmuxServerGlobalEnvKey(`GIT_CONFIG_VALUE_${i}`), `VALUE_${i}`).toBe(false);
    }
    expect(isBotmuxManagedTmuxServerGlobalEnvKey('GIT_CONFIG_KEY_3_EXTRA')).toBe(false);
    expect(isBotmuxManagedTmuxServerGlobalEnvKey('BOTMUX_SESSION_ID')).toBe(true);
  });
});
