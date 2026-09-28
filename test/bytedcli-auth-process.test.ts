import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { findRealToolBinary, renderIdentityWrapper } from '../src/core/cli-identity.js';
import { scrubSessionTurnMarkerEnv } from '../src/utils/child-env.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bytedcli provider process boundary', () => {
  it('can provision authorization despite an inherited denying session wrapper', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-auth-process-'));
    roots.push(root);
    const wrappers = join(root, 'data', 'cli-identity', 'old-session.bin');
    const tools = join(root, 'tools');
    mkdirSync(wrappers, { recursive: true });
    mkdirSync(tools);
    const real = join(tools, 'bytedcli');
    writeFileSync(real, `#!/bin/sh
if [ -n "$BOTMUX_IDENTITY_BIN$BOTMUX_SESSION_ID$BYTEDCLI_USER_CLOUD_JWT$AIME_USER_CLOUD_JWT$BYTEDCLI_PROFILE$BYTECLOUD_AUTH_ACCESS_KEY_ID$AIME_WORKSPACE_PATH$AIME_CURRENT_USER" ]; then
  exit 77
fi
[ "$BYTECLOUD_AUTH_AS" = user ] || exit 78
case "$HOME" in */bytedcli-home/ou_alice|*/bytedcli-home/ou_bob) ;; *) exit 79 ;; esac
printf '%s\\n' "$2" >> "$HOME/provider-calls"
case "$2" in
  login) printf '%s\\n' '{"status":"success","data":{"verification_uri_complete":"https://example.test/login","complete_token":"challenge"}}' ;;
  status) case "$HOME" in */ou_bob) printf '%s\\n' '{"status":"success","data":{"authenticated":false}}'; exit 0 ;; esac
    printf '%s\\n' '{"status":"success","data":{"authenticated":true,"auth_as":"user","bytecloud_auth":{"authType":"user"}}}' ;;
  get-bytecloud-jwt-token) printf '%s\\n' 'test-cloud-jwt' ;;
  get-codebase-jwt-token) printf '%s\\n' 'test-code-jwt' ;;
esac
`);
    chmodSync(real, 0o755);
    const wrapper = join(wrappers, 'bytedcli');
    writeFileSync(wrapper, renderIdentityWrapper('bytedcli', real));
    chmodSync(wrapper, 0o755);
    vi.stubEnv('HOME', root);
    vi.stubEnv('PATH', [wrappers, tools, '/usr/bin', '/bin'].join(delimiter));
    vi.stubEnv('BOTMUX_IDENTITY_BIN', wrappers);
    vi.stubEnv('BOTMUX_SESSION_ID', 'old-session');
    vi.stubEnv('BYTEDCLI_USER_CLOUD_JWT', 'unrelated-identity');
    vi.stubEnv('AIME_USER_CLOUD_JWT', 'unrelated-identity');
    vi.stubEnv('BYTEDCLI_PROFILE', 'unrelated-profile');
    vi.stubEnv('AIME_WORKSPACE_PATH', root);
    vi.stubEnv('AIME_CURRENT_USER', 'unrelated-user');
    vi.stubEnv('BYTECLOUD_AUTH_ACCESS_KEY_ID', 'unrelated-app');
    expect(findRealToolBinary('bytedcli', process.env.PATH)).toBe(real);
    vi.resetModules();
    const provider = await import('../src/services/bytedcli-auth.js');
    expect((await provider.beginBytedcliLogin('ou_alice'))?.completeToken).toBe('challenge');
    // The test exercises the real spawn, wrapper lookup, HOME and provider API.
    expect(await provider.hasBytedcliHome('ou_alice')).toBe(true);
    await provider.beginBytedcliLogin('ou_bob');
    expect(await provider.hasBytedcliHome('ou_bob')).toBe(false);
    expect(readFileSync(join(provider.bytedcliHomeFor('ou_alice'), 'provider-calls'), 'utf8')).toBe('login\nstatus\n');
    expect(process.env.BOTMUX_IDENTITY_BIN).toBe(wrappers);
  });

  it('removes stale wrappers even after the session marker was already lost', () => {
    const env = {
      PATH: ['/custom/cli-identity/old.bin', '/custom/cli-identity/other.bin/', '/usr/bin'].join(delimiter),
      ZDOTDIR: '/custom/cli-identity/old.bin/shell',
      BASH_ENV: '/custom/cli-identity/old.bin/shell/bash_env.sh',
      GIT_ASKPASS: '/custom/cli-identity/old.bin/botmux-git-askpass',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'old-helper',
      SESSION_DATA_DIR: '/custom', HTTPS_PROXY: 'https://proxy.example.test',
    };
    scrubSessionTurnMarkerEnv(env);
    expect(env).toEqual({ PATH: '/usr/bin', SESSION_DATA_DIR: '/custom', HTTPS_PROXY: 'https://proxy.example.test' });
  });

  it('preserves ordinary shell customization and git configuration', () => {
    const env = { PATH: '/tools:/usr/bin', ZDOTDIR: '/my/shell', BASH_ENV: '/my/bashrc',
      GIT_ASKPASS: '/my/askpass', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'example' };
    const before = { ...env };
    scrubSessionTurnMarkerEnv(env);
    expect(env).toEqual(before);
  });
});
