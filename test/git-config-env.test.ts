import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { buildBotmuxEnvAssignments, shellCommandArgv, shellWrapperScript } from '../src/adapters/backend/tmux-backend.js';
import { tmuxEnv } from '../src/setup/ensure-tmux.js';
import { isBotmuxManagedTmuxServerGlobalEnvKey } from '../src/utils/child-env.js';

function configEnv(values: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(values.length) };
  values.forEach((value, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = 'botmuxprobe.value';
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

const baseEnv = {
  PATH: process.env.PATH,
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

for (const shell of ['sh', 'bash', 'zsh', 'fish'] as const) {
  const available = spawnSync(shell, ['-c', 'exit 0']).status === 0;
  describe.skipIf(!available)(`${shell} Git config pane environment`, () => {
    function runPane(env: NodeJS.ProcessEnv, command: string[], ambient: NodeJS.ProcessEnv = {}) {
      const [bin, ...args] = shellCommandArgv(
        { shell, flags: [] },
        shellWrapperScript('/usr/bin', shell === 'fish' ? 'fish' : 'sh'),
        [tmpdir(), ...buildBotmuxEnvAssignments(env), ...command],
      );
      return spawnSync(bin, args, { env: { ...baseEnv, ...ambient }, encoding: 'utf8', timeout: 5000 });
    }

    it.each([4, 7, 14, 19])('preserves all %i ordered entries through the shell and Git', (count) => {
      const values = Array.from({ length: count }, (_, i) => `value ${i}`);
      values[1] = 'quotes \'"; $(exit 91) `exit 92` = literal\nnext line';
      values[count - 1] = '';
      const result = runPane(configEnv(values), ['git', 'config', '--null', '--get-all', 'botmuxprobe.value']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(values.map(value => `${value}\0`).join(''));
    });

    it.each(['KEY', 'VALUE'])('keeps a missing source %s visible to Git despite an ambient replacement', (part) => {
      const env = configEnv(['a', 'b', 'c', 'd']);
      delete env[`GIT_CONFIG_${part}_3`];
      const result = runPane(env, ['git', 'config', '--list'], configEnv(['stale-a', 'stale-b', 'stale-c', 'stale-d']));
      expect(result.status, result.stderr).toBe(128);
      expect(result.stderr).toContain(`missing config ${part.toLowerCase()} GIT_CONFIG_${part}_3`);
    });

    it('clears inherited numbered pairs while preserving unrelated Git configuration variables', () => {
      const result = runPane({}, ['/usr/bin/env'], {
        ...configEnv(Array.from({ length: 19 }, () => 'stale')),
        GIT_CONFIG_KEY_3_EXTRA: 'keep',
        GIT_CONFIG_VALUE_label: 'keep',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toMatch(/^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)=/m);
      expect(result.stdout).toContain('GIT_CONFIG_KEY_3_EXTRA=keep\n');
      expect(result.stdout).toContain('GIT_CONFIG_VALUE_label=keep\n');
      expect(result.stdout).toContain('GIT_CONFIG_GLOBAL=/dev/null\n');
    });
  });
}

it('strips every numbered pair from the tmux client and selects them for server cleanup', () => {
  const env = {
    ...configEnv(Array.from({ length: 19 }, () => 'value')),
    GIT_CONFIG_KEY_3_EXTRA: 'keep',
    GIT_CONFIG_VALUE_label: 'keep',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const client = tmuxEnv(env);
  expect(Object.keys(client).filter(key => /^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)$/.test(key))).toEqual([]);
  for (const key of Object.keys(configEnv(Array.from({ length: 19 }, () => 'value')))) {
    expect(isBotmuxManagedTmuxServerGlobalEnvKey(key), key).toBe(true);
  }
  for (const key of ['GIT_CONFIG_KEY_3_EXTRA', 'GIT_CONFIG_VALUE_label', 'GIT_CONFIG_GLOBAL']) {
    expect(client[key]).toBe(env[key as keyof typeof env]);
    expect(isBotmuxManagedTmuxServerGlobalEnvKey(key), key).toBe(false);
    expect(buildBotmuxEnvAssignments(env).some(assignment => assignment.startsWith(`${key}=`))).toBe(false);
  }
});

// Regression for a defect found while porting this fix onto a newer base: the
// runtime pair collection originally used SINGLE quotes, which truncates when a
// caller embeds the whole wrapper inside a single-quoted shell word (the pane
// spawn contract does exactly that). Double quotes are required.
// The scrub alone is not enough: it strips the ambient pairs, so botmux must put
// its own COUNT back afterwards. Together they must leave git able to parse.
it('scrubbed pane plus botmux re-injection leaves git usable', () => {
  const corrupt = {
    GIT_CONFIG_COUNT: '14',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '',
  };
  const [bin, ...args] = shellCommandArgv(
    { shell: 'sh', flags: [] },
    shellWrapperScript('/usr/bin', 'sh'),
    [tmpdir(), ...buildBotmuxEnvAssignments(corrupt), 'git', 'config', '--get-all', 'x.y'],
  );
  // The poison lives in the AMBIENT env (the tmux server global env), while the
  // worker env legitimately carries no pairs; that is the real pane contract.
  const r = spawnSync(bin, args, { env: { ...baseEnv, ...corrupt }, encoding: 'utf8', timeout: 5000 });
  // 1 = key absent, config parsed fine. 128 = the ambience still poisons git.
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).not.toContain('missing config key');
});
