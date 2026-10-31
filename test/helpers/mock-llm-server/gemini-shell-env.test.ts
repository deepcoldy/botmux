import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildGeminiShellEnvSnapshotFragment, GEMINI_SHELL_ENV_LOG } from './gemini-shell-env.js';

const LOG_PATH = join('/tmp', GEMINI_SHELL_ENV_LOG);

function runFragment(env: NodeJS.ProcessEnv, extra = ''): string {
  return execFileSync('bash', ['-c', `${extra}${buildGeminiShellEnvSnapshotFragment('ACK-e2e-cli-1793300000000')}; cat ${GEMINI_SHELL_ENV_LOG}`], {
    cwd: '/tmp',
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  }).trim();
}

afterEach(() => rmSync(LOG_PATH, { force: true }));

describe('buildGeminiShellEnvSnapshotFragment', () => {
  it('renders every tracked variable with set-presence and set-u-safe value expansion', () => {
    const frag = buildGeminiShellEnvSnapshotFragment();
    for (const name of ['GITHUB_SHA', 'BOTMUX_SESSION_ID', 'BOTMUX_IDENTITY_BIN', 'BASH_ENV', '__OWNER_OPEN_ID']) {
      expect(frag).toContain(`${name}={\${${name}+x}:\${${name}-}}`);
    }
    expect(frag).toContain('$(date +%s)');
    expect(frag).toContain(`>> ${GEMINI_SHELL_ENV_LOG}`);
  });

  it('distinguishes unset, set-empty, and set-value in a real POSIX shell', () => {
    expect(runFragment({})).toContain('GITHUB_SHA={:}');
    expect(runFragment({ GITHUB_SHA: '' })).toContain('GITHUB_SHA={x:}');
    expect(runFragment({ GITHUB_SHA: 'deadbeef' })).toContain('GITHUB_SHA={x:deadbeef}');
    const kept = runFragment({ GITHUB_SHA: '', BOTMUX_SESSION_ID: 's42', __OWNER_OPEN_ID: 'ou1' });
    expect(kept).toContain('GITHUB_SHA={x:}');
    expect(kept).toContain('BOTMUX_SESSION_ID={x:s42}');
    expect(kept).toContain('__OWNER_OPEN_ID={x:ou1}');
  });

  it('survives `set -u` even when every tracked variable is unset (P2)', () => {
    // Bare ${VAR} would abort under nounset and silently swallow the snapshot
    // AND the following botmux send; ${VAR-} must keep the line intact.
    const out = runFragment({}, 'set -u; ');
    expect(out).toContain('GITHUB_SHA={:}');
    expect(out).toContain('BOTMUX_SESSION_ID={:}');
    expect(out).toContain('__OWNER_OPEN_ID={:}');
  });

  it('prefixes an epoch timestamp and the marker so retry attempts are separable', () => {
    const out = runFragment({ GITHUB_SHA: '' });
    // "<epoch> <marker> GITHUB_SHA=…"
    expect(out).toMatch(/^\d+ ACK-e2e-cli-1793300000000 GITHUB_SHA=/);
  });

  it('refuses a marker outside the shell-quoted-safe charset', () => {
    for (const evil of ['$(touch pwned)', '`id`', 'a; rm -rf /', 'a"$(id)', '$HOME', 'a|b', 'a\nb']) {
      expect(() => buildGeminiShellEnvSnapshotFragment(evil)).toThrow(/unsafe marker/);
    }
    expect(buildGeminiShellEnvSnapshotFragment('ACK-e2e-x.1:2#3@4 5')).toContain('ACK-e2e-x.1:2#3@4 5');
  });
});
