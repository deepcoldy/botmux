import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sanitizePerBotEnv, isReservedPerBotEnvKey } from '../per-bot-env.js';
import { botInjectedEnv } from '../env-policy.js';
import { buildBotmuxEnvAssignments, shellCommandArgv, shellWrapperScript } from '../../adapters/backend/tmux-backend.js';
import { isBotmuxManagedTmuxEnvKey, isBotmuxManagedTmuxServerGlobalEnvKey } from '../../utils/child-env.js';

const key = 'BOTMUX_ASK_DELIVERY_MODE';

describe('per-bot Ask delivery mode', () => {
  it.each(['continuation', 'blocking'])('carries the explicit %s behavior through strict and ordinary injection', mode => {
    expect(isReservedPerBotEnvKey(key)).toBe(false);
    for (const policy of [undefined, { mode: 'strict' as const }]) {
      expect(botInjectedEnv({ [key]: mode }, policy)).toEqual({ [key]: mode });
    }
    expect(isBotmuxManagedTmuxEnvKey(key)).toBe(true);
    expect(isBotmuxManagedTmuxServerGlobalEnvKey(key)).toBe(true);
  });

  it.each(['', 'unknown', true, 1, ['continuation'], null])('rejects invalid mode %j', mode => {
    expect(sanitizePerBotEnv({ [key]: mode })).toEqual({});
  });

  it('does not grant any session, identity or routing overrides', () => {
    expect(sanitizePerBotEnv({
      [key]: 'continuation', BOTMUX_SESSION_ID: 'foreign', BOTMUX_OWNER_OPEN_ID: 'foreign',
      BOTMUX_LARK_APP_ID: 'foreign', BOTMUX_CHAT_ID: 'foreign', BOTMUX_ASK_DELIVERY_MODE_EXTRA: 'foreign',
    })).toEqual({ [key]: 'continuation' });
  });

  const hasTmux = !spawnSync('tmux', ['-V']).error;
  it.skipIf(!hasTmux)('keeps modes isolated in real panes on one shared tmux server, including an unconfigured bot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-mode-tmux-'));
    const socket = join(dir, 'tmux.sock');
    const run = (args: string[]) => {
      const result = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr || String(result.error ?? '')).toBe(0);
    };
    try {
      run(['-f', '/dev/null', 'new-session', '-d', '-s', 'holder', '/bin/sleep', '60']);
      run(['set-environment', '-g', key, 'continuation']);
      const probe = join(dir, 'probe.sh');
      writeFileSync(probe, '#!/bin/sh\nprintf "%s\\n" "${BOTMUX_ASK_DELIVERY_MODE-unset}" > "$1"\ntmux -S "$2" wait-for -S "$3"\n', { mode: 0o755 });
      const cases = [
        [undefined, 'continuation', 'continuation'], [undefined, 'blocking', 'blocking'],
        [undefined, undefined, 'unset'], ['continuation', undefined, 'continuation'],
        ['continuation', 'blocking', 'blocking'],
      ];
      for (const [index, [inherited, mode, expected]] of cases.entries()) {
        const result = join(dir, `result-${index}`), signal = `done-${index}`;
        run(['new-session', '-d', '-s', `bot-${index}`, ...shellCommandArgv({ shell: '/bin/sh', flags: [] }, shellWrapperScript(dir), [
          dir, ...buildBotmuxEnvAssignments({ [key]: inherited }, botInjectedEnv(mode ? { [key]: mode } : {})),
          probe, result, socket, signal,
        ])]);
        run(['wait-for', signal]);
        expect(readFileSync(result, 'utf8')).toBe(`${expected}\n`);
      }
    } finally {
      spawnSync('tmux', ['-S', socket, 'kill-server'], { timeout: 10_000 });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
