import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { buildGeminiShellEnvSnapshotFragment, GEMINI_SHELL_ENV_LOG } from './gemini-shell-env.js';

describe('buildGeminiShellEnvSnapshotFragment', () => {
  it('renders every tracked variable with set-presence and value expansion', () => {
    const frag = buildGeminiShellEnvSnapshotFragment();
    for (const name of ['GITHUB_SHA', 'BOTMUX_SESSION_ID', 'BOTMUX_IDENTITY_BIN', 'BASH_ENV', '__OWNER_OPEN_ID']) {
      expect(frag).toContain(`${name}={\${${name}+x}:\${${name}}}`);
    }
    expect(frag).toContain(`>> ${GEMINI_SHELL_ENV_LOG}`);
  });

  it('distinguishes unset, set-empty, and set-value in a real POSIX shell', () => {
    const run = (env: NodeJS.ProcessEnv): string =>
      execFileSync('bash', ['-c', `${buildGeminiShellEnvSnapshotFragment()}; cat ${GEMINI_SHELL_ENV_LOG}`], {
        cwd: '/tmp',
        env: { PATH: process.env.PATH, ...env },
        encoding: 'utf8',
      }).trim();

    // unset: presence marker empty
    expect(run({})).toContain('GITHUB_SHA={:}');
    // set empty (the fix shape): presence 'x', empty value
    expect(run({ GITHUB_SHA: '' })).toContain('GITHUB_SHA={x:}');
    // leaked non-empty runner value: presence 'x' + value
    expect(run({ GITHUB_SHA: 'deadbeef' })).toContain('GITHUB_SHA={x:deadbeef}');
    // session vars survive alongside an empty SHA
    const kept = run({ GITHUB_SHA: '', BOTMUX_SESSION_ID: 's42', __OWNER_OPEN_ID: 'ou1' });
    expect(kept).toContain('GITHUB_SHA={x:}');
    expect(kept).toContain('BOTMUX_SESSION_ID={x:s42}');
    expect(kept).toContain('__OWNER_OPEN_ID={x:ou1}');
  });
});
