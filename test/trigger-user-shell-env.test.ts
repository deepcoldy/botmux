import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import {
  GIT_ASKPASS_BASENAME,
  IDENTITY_DENIED_EXIT_CODE,
  installIdentityWrapper,
  publishActiveTurn,
  sessionIdentityBinDir,
  writeSessionIdentity,
} from '../src/core/cli-identity.js';

// worker.ts is a process entrypoint: execute its actual environment-assembly
// block without starting a worker, rather than recreating that block in a fixture.
const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const start = worker.indexOf('const identityShellEnv: Record<string, string> = {');
const end = worker.indexOf('const args = cliAdapter.buildArgs({', start);
if (start < 0 || end <= start) throw new Error('Cannot locate worker identity environment assembly');
const assembly = ts.transpileModule(worker.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const assemble = new Function('cfg', 'process', 'sessionIdentityBinDir', 'join', 'GIT_ASKPASS_BASENAME',
  'effectiveAdapterSessionId', `${assembly}\nreturn identityShellEnv;`);

function workerShellEnv(sessionDataDir: string | undefined, enabled = true, tools = ['bytedcli']): Record<string, string> {
  return assemble(
    { sessionId: 'botmux-session', chatId: 'oc_chat', larkAppId: 'cli_app', triggerUserAuth: { enabled, tools } },
    { env: sessionDataDir === undefined ? {} : { SESSION_DATA_DIR: sessionDataDir } },
    sessionIdentityBinDir, join, GIT_ASKPASS_BASENAME, 'native-session',
  );
}

function shellOverrides(args: string[]): Record<string, string> {
  const prefix = 'shell_environment_policy.set.';
  return Object.fromEntries(args.flatMap((arg, index) => {
    if (!arg.startsWith(prefix)) return [];
    expect(args[index - 1]).toBe('-c');
    const separator = arg.indexOf('=');
    return [[arg.slice(prefix.length, separator), JSON.parse(arg.slice(separator + 1))]];
  }));
}

const routingEnv = { BOTMUX_SESSION_ID: 'botmux-session', BOTMUX_CHAT_ID: 'oc_chat', BOTMUX_LARK_APP_ID: 'cli_app', BOTMUX_SESSION_SCOPE: 'chat' };

describe('worker trigger-user shell contract', () => {
  it('uses the credential file identity, not the native CLI resume identity', () => {
    const dataDir = '/tmp/data "quoted"';
    expect(workerShellEnv(dataDir)).toEqual({
      ...routingEnv,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_IDENTITY_BIN: sessionIdentityBinDir(dataDir, 'botmux-session'),
      ZDOTDIR: join(sessionIdentityBinDir(dataDir, 'botmux-session'), 'shell'),
      BASH_ENV: join(sessionIdentityBinDir(dataDir, 'botmux-session'), 'shell', 'bash_env.sh'),
      GIT_ASKPASS: join(sessionIdentityBinDir(dataDir, 'botmux-session'), GIT_ASKPASS_BASENAME),
    });
  });

  it('retains routing without identity wrappers when auth is off or has no data root', () => {
    expect(workerShellEnv('/tmp/data', false)).toEqual(routingEnv);
    expect(workerShellEnv(undefined)).toEqual(routingEnv);
  });

  it('does not request git askpass for lark-only authentication', () => {
    expect(workerShellEnv('/tmp/data', true, ['lark-cli'])).not.toHaveProperty('GIT_ASKPASS');
  });
});

describe.each([
  ['traex', createTraexAdapter],
  ['codex', createCodexAdapter],
] as const)('%s explicit identity environment', (_name, createAdapter) => {
  it('emits each routing override once and skips undefined config values', () => {
    const args = createAdapter('/bin/cli').buildArgs({
      sessionId: 'native-session',
      shellSubprocessEnv: { ...routingEnv, UNSET: undefined } as unknown as Record<string, string>,
    });
    expect(args.filter(arg => arg.startsWith('shell_environment_policy.set.BOTMUX_SESSION_ID='))).toHaveLength(1);
    expect(shellOverrides(args)).toMatchObject(routingEnv);
    expect(shellOverrides(args)).not.toHaveProperty('UNSET');
  });

  it.each([false, true])('runs the real wrapper without inherited identity variables, resume=%s', (resume) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-shell-env-'));
    try {
      const shellEnv = workerShellEnv(dataDir);
      const realTool = join(dataDir, 'real-tool');
      writeFileSync(realTool, '#!/bin/sh\nprintf "%s" "$BYTEDCLI_USER_CLOUD_JWT"\n', { mode: 0o755 });
      const wrapper = installIdentityWrapper(shellEnv.BOTMUX_IDENTITY_BIN, 'bytedcli', realTool)!;
      const args = createAdapter('/bin/cli').buildArgs({
        sessionId: 'native-session',
        resume,
        resumeSessionId: resume ? 'native-session' : undefined,
        shellSubprocessEnv: shellEnv,
      });
      // Model a shell receiving ONLY the adapter's explicit .set entries. This
      // tests our contract, not any particular TRAE version's inheritance policy.
      const toolEnv = { PATH: '/usr/bin:/bin', ...shellOverrides(args) };
      expect(toolEnv).not.toHaveProperty('BYTEDCLI_USER_CLOUD_JWT');
      const run = (env: Record<string, string> = toolEnv) => spawnSync('/bin/sh', [wrapper], {
        env, encoding: 'utf8', timeout: 5_000,
      });
      const publish = (token: string, turnId: string) => {
        writeSessionIdentity(dataDir, 'botmux-session', { tool: 'bytedcli', cloudJwt: token, turnId });
        publishActiveTurn(dataDir, 'botmux-session', turnId);
      };
      publish('test-alice', 'turn-a');
      expect(run()).toMatchObject({ status: 0, stdout: 'test-alice' });
      publish('test-bob', 'turn-b');
      expect(run()).toMatchObject({ status: 0, stdout: 'test-bob' });

      for (const key of ['BOTMUX_SESSION_ID', 'SESSION_DATA_DIR']) {
        const missing: Record<string, string> = { ...toolEnv };
        delete missing[key];
        expect(run(missing)).toMatchObject({ status: IDENTITY_DENIED_EXIT_CODE, stdout: '' });
      }
      publishActiveTurn(dataDir, 'botmux-session', 'turn-a');
      expect(run()).toMatchObject({ status: IDENTITY_DENIED_EXIT_CODE, stdout: '' });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
