import { describe, expect, it } from 'vitest';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';

const shellEnv = {
  BOTMUX_IDENTITY_BIN: '/tmp/session "quoted"/bin',
  ZDOTDIR: '/tmp/session/shell',
  BASH_ENV: '/tmp/session/shell/bash_env.sh',
  GIT_ASKPASS: '/tmp/session/bin/git-askpass',
};

function shellOverrides(args: string[]): Record<string, string> {
  const prefix = 'shell_environment_policy.set.';
  return Object.fromEntries(args.flatMap((arg, index) => {
    if (!arg.startsWith(prefix)) return [];
    expect(args[index - 1]).toBe('-c');
    const separator = arg.indexOf('=');
    return [[arg.slice(prefix.length, separator), JSON.parse(arg.slice(separator + 1))]];
  }));
}

describe('TraeX trigger-user shell environment', () => {
  it.each([false, true])('forwards the identity wrapper paths for resume=%s', (resume) => {
    const args = createTraexAdapter('/bin/traex').buildArgs({
      sessionId: 'botmux-session',
      resume,
      resumeSessionId: resume ? 'native-session' : undefined,
      workingDir: '/tmp/project',
      shellSubprocessEnv: shellEnv,
    });

    expect(shellOverrides(args)).toMatchObject(shellEnv);
    expect(args).not.toContain('shell_environment_policy.inherit="all"');
    expect(args).not.toContain('shell_environment_policy.ignore_default_excludes=true');
    expect(args[args.indexOf('-C') + 1]).toBe('/tmp/project');
    if (resume) {
      expect(args[0]).toBe('resume');
      expect(args.at(-1)).toBe('native-session');
    }
  });

  it.each([undefined, {}])('keeps the launch unchanged without requested variables: %j', (env) => {
    const adapter = createTraexAdapter('/bin/traex');
    const request = { sessionId: 'botmux-session', resume: false };
    expect(adapter.buildArgs({ ...request, shellSubprocessEnv: env }))
      .toEqual(adapter.buildArgs(request));
  });

  it('forwards identity paths for a restricted CLI without granting bypass flags', () => {
    const args = createTraexAdapter('/bin/traex').buildArgs({
      sessionId: 'botmux-session',
      resume: false,
      disableCliBypass: true,
      bypassHookTrust: true,
      shellSubprocessEnv: shellEnv,
    });

    expect(shellOverrides(args)).toMatchObject(shellEnv);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--dangerously-bypass-hook-trust');
  });

  it('does not attach execution settings to the remote viewer', () => {
    const adapter = createTraexAdapter('/bin/traex');
    const request = {
      sessionId: 'botmux-session',
      resume: true,
      remoteWsUrl: 'ws://127.0.0.1:9876',
      remoteThreadId: 'remote-thread',
    };

    expect(adapter.buildArgs({ ...request, shellSubprocessEnv: shellEnv }))
      .toEqual(adapter.buildArgs(request));
  });
});
