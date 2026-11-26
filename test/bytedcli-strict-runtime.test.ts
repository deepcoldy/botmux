import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderIdentityWrapper, writeSessionIdentity, recallProvenIdentityContent } from '../src/core/cli-identity.js';
import { persistBytedcliStrictSession } from '../src/core/bytedcli-strict-session.js';

describe('strict ByteCloud runtime', () => {
  it('executes only the no-credential client and rejects actor/native/companion escapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'strict-wrapper-'));
    try {
      const client = join(root, 'client');
      writeFileSync(client, '#!/bin/sh\nprintf "client:%s" "$*"\nexit 17\n', { mode: 0o755 });
      for (const tool of ['bytedcli', 'codebase', 'bitscli'] as const) {
        const wrapper = join(root, tool);
        writeFileSync(wrapper, renderIdentityWrapper(tool, '/bin/echo', 'single', undefined,
          { meego: true, bytecloud: true, brokerClient: [client] }), { mode: 0o755 });
        const result = spawnSync(wrapper, ['meego', 'user'], { encoding: 'utf8' });
        expect(result.status).toBe(tool === 'bytedcli' ? 17 : 77);
        expect(result.stdout).toBe(tool === 'bytedcli' ? 'client:meego user' : '');
        expect(spawnSync(wrapper, [], { env: { PATH: '/bin:/usr/bin', BOTMUX_AS: 'someone' } }).status).toBe(77);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('withholds existing snapshots and rejects late writes after a durable strict fence', () => {
    const root = mkdtempSync(join(tmpdir(), 'strict-fence-'));
    try {
      writeSessionIdentity(root, 's', { tool: 'bytedcli', cloudJwt: 'secret', turnId: 't' }, 'proven');
      persistBytedcliStrictSession(root, 's');
      expect(recallProvenIdentityContent(root, 's', 't', 'bytedcli')).toBeUndefined();
      expect(() => writeSessionIdentity(root, 's', { tool: 'bytedcli', cloudJwt: 'late', turnId: 't' }, 'proven')).toThrow();
      expect(() => writeSessionIdentity(root, 's', { tool: 'lark-cli', mode: 'user-home', home: '/safe', turnId: 't' }, 'proven')).not.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

it('does not remember a forged configuration-only containment report', async () => {
  const { rememberBytedcliContainment } = await import('../src/core/bytedcli-broker-containment.js');
  const ds = { session: { sessionId: 's', status: 'active', backendType: 'pty' }, worker: { pid: process.pid },
    workerGeneration: 1, localProcessAttestation: { cliPid: process.pid } } as any;
  expect(rememberBytedcliContainment(ds, { protocol: 'botmux.bytedcli-containment.v1', sessionId: 's',
    workerGeneration: 1, workerPid: process.pid, cliPid: process.pid, pidNamespace: 'pretend', hostPidNamespace: 'host',
    filesystem: 'allowlist', protectedRoots: ['/credentials'], protectedRootsEnforced: true, freshCredentialFreeLaunch: true })).toBe(false);
});

it('installs strict wrappers under source Bun, keeps them after policy disable, and denies git credentials without blocking local git', async () => {
  const { spawnSyncBunTsEvalWithRepoImports } = await import('./helpers/ts-runner.js');
  const result = spawnSyncBunTsEvalWithRepoImports(`
    import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { spawnSync } from 'node:child_process';
    import { prepareTurnGitConfigEnv, sessionIdentityBinDir } from './src/core/cli-identity.ts';
    const root = mkdtempSync(join(tmpdir(), 'strict-bun-'));
    try {
      const env = { ...process.env };
      const execution = { appId: 'app', ipcPort: 1 };
      const policy = { enabled: true, tools: ['bytedcli'], bytecloudExecution: 'read-machine-write-actor' };
      prepareTurnGitConfigEnv(env, root, 's', policy, () => {}, 'proven', execution, { loopbackShared: true });
      prepareTurnGitConfigEnv(env, root, 's', undefined, () => {}, 'proven', execution, { loopbackShared: true });
      const run = (name, args = []) => spawnSync(join(sessionIdentityBinDir(root, 's'), name), args, { env, encoding: 'utf8' });
      for (const name of ['codebase', 'bitscli', 'botmux-git-askpass']) {
        const result = run(name); if (result.status !== 77 || result.stdout) throw new Error('credential bypass');
      }
      const byted = run('bytedcli', ['auth', 'token']);
      if (byted.status !== 77 || !byted.stderr.includes('broker_request_failed')) throw new Error('not client entry: ' + byted.stderr);
      const git = spawnSync('git', ['--version'], { env, encoding: 'utf8' });
      if (git.status !== 0) throw new Error('local git broken');
      if (env.GIT_CONFIG_KEY_0 !== 'credential.helper' || env.GIT_CONFIG_VALUE_0 !== '') throw new Error('credential helper override');
      process.stdout.write('strict-bun-ok');
    } finally { rmSync(root, { recursive: true, force: true }); }
  `, { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
  expect(result.status, String(result.stderr)).toBe(0);
  expect(result.stdout).toBe('strict-bun-ok');
});

it('removes caller credential and config overrides while retaining unrelated model and Lark env', async () => {
  const { scrubBytedcliBrokerEnv } = await import('../src/utils/child-env.js');
  const env = { BYTEDCLI_USER_CLOUD_JWT: 'cloud', BYTEDCLI_USER_CODE_JWT: 'code', AILY_WORKSPACE_DIR: '/workspace',
    AIME_USER_CLOUD_JWT: 'cloud', BOTMUX_AS: 'actor', NODE_OPTIONS: 'loader', GIT_ASKPASS: '/caller',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '/credential-command',
    LARKSUITE_CLI_USER_ACCESS_TOKEN: 'lark', ANTHROPIC_AUTH_TOKEN: 'model', PATH: '/bin' };
  scrubBytedcliBrokerEnv(env);
  expect(env).toEqual({ LARKSUITE_CLI_USER_ACCESS_TOKEN: 'lark', ANTHROPIC_AUTH_TOKEN: 'model', PATH: '/bin' });
});
