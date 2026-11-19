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

  // Output shapes as bytedcli 0.195 prints them (identifiers replaced): the
  // result on stdout, progress and action_required events on stderr. Since
  // 0.186 `--begin` on a HOME that already holds a login prints that login and
  // no link.
  it('reads bytedcli 0.186+ output: an existing login, a new challenge and an error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-auth-process-'));
    roots.push(root);
    const tools = join(root, 'tools');
    mkdirSync(tools);
    const challenge = '{"status":"success","data":{"message":"Login challenge created","login_mode":"device_code","login_status":"pending","challenge_reused":false,"complete_token":"tok-fixture","complete_command":"bytedcli --json auth login --complete tok-fixture","qr_image_path":"/tmp/auth-login.png","verification_uri_complete":"https://cloud.example.test/open/ai/service_account/create_and_bind?code=fixture&domain-id=online"},"error":null,"context":{"execution_time_ms":90,"timestamp":"2026-11-17T12:39:22.093+08:00"}}';
    const qrEvent = '{"event":"qr_image_ready","data":{"path":"/tmp/auth-login.png","verification_uri_complete":"https://cloud.example.test/open/ai/service_account/create_and_bind?code=fixture&domain-id=online"}}';
    const already = '{"status":"success","data":{"site":"cn","status":"ready","initialized":true,"authType":"user","identity":{"username":"alice"},"message":"Already authenticated","login_mode":"device_code","login_status":"success","already_authenticated":true},"error":null,"context":{"execution_time_ms":61,"timestamp":"2026-11-17T12:40:35.376+08:00"}}';
    const statusYes = '{"status":"success","data":{"authenticated":true,"auth_source":"bytecloud_auth","auth_as":"user","profile":null,"token_expires_at":"2026-11-17T14:40:35.000+08:00","bytecloud_auth":{"site":"cn","status":"ready","initialized":true,"authType":"user"}},"error":null,"context":{"execution_time_ms":22}}';
    const statusNo = '{"status":"success","data":{"authenticated":false,"auth_source":"bytecloud_auth","auth_as":"user","profile":null,"token_expires_at":null,"bytecloud_auth":{"site":"cn","status":"need_login","initialized":true,"nextCommand":"bytedcli auth login"}},"error":null,"context":{"execution_time_ms":41}}';
    const failure = '{"status":"error","data":null,"error":{"message":"ByteCloud Auth runtime error.: login challenge not found","code":"BYTECLOUD_AUTH_RUNTIME_ERROR","hint":"Retry with --debug to show ByteCloud Auth runtime logs if this keeps failing."},"context":{"execution_time_ms":24}}';
    const actionRequired = '{"event":"action_required","data":{"title":"Action required","message":"Retry with --debug to show ByteCloud Auth runtime logs if this keeps failing.","code":"BYTECLOUD_AUTH_RUNTIME_ERROR"}}';
    writeFileSync(join(tools, 'bytedcli'), `#!/bin/sh
case "$2" in
  login)
    if [ -e "$HOME/broken" ]; then printf '%s\\n' '${failure}'; printf '%s\\n' '${actionRequired}' >&2; exit 1; fi
    if [ -e "$HOME/logged-in" ]; then printf '%s\\n' '${already}'; exit 0; fi
    printf '%s\\n' '${qrEvent}' >&2; printf '%s\\n' '${challenge}' ;;
  status)
    if [ -e "$HOME/logged-in" ]; then printf '%s\\n' '${statusYes}'; else printf '%s\\n' '${statusNo}'; fi ;;
esac
`);
    chmodSync(join(tools, 'bytedcli'), 0o755);
    vi.stubEnv('HOME', root);
    vi.stubEnv('PATH', [tools, '/usr/bin', '/bin'].join(delimiter));
    vi.resetModules();
    const provider = await import('../src/services/bytedcli-auth.js');
    for (const [person, marker] of [['ou_alice', 'logged-in'], ['ou_carol', 'broken']]) {
      mkdirSync(provider.bytedcliHomeFor(person), { recursive: true });
      writeFileSync(join(provider.bytedcliHomeFor(person), marker), '');
    }

    expect(await provider.startBytedcliLogin('ou_alice')).toEqual({ state: 'authorized' });
    expect(await provider.startBytedcliLogin('ou_bob')).toEqual({ state: 'challenge', challenge: {
      authUrl: 'https://cloud.example.test/open/ai/service_account/create_and_bind?code=fixture&domain-id=online',
      completeToken: 'tok-fixture',
    } });
    expect(await provider.startBytedcliLogin('ou_carol')).toEqual({ state: 'failed',
      detail: 'BYTECLOUD_AUTH_RUNTIME_ERROR: ByteCloud Auth runtime error.: login challenge not found' });
    expect(provider.pendingBytedcliChallenge('ou_alice')).toBeNull();
    expect(provider.pendingBytedcliChallenge('ou_carol')).toBeNull();
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
