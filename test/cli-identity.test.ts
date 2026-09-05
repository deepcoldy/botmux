/**
 * Session credential handoff for trigger-user CLI authentication.
 *
 * The properties worth pinning here are about SAFETY, not plumbing:
 *
 *   1. A credential value survives `sh` sourcing byte-for-byte — a token that
 *      got mangled to be "safe" is a token that fails with a baffling error.
 *   2. Clearing an identity REMOVES the file. Leaving the previous person's
 *      token behind is exactly the failure this feature exists to prevent.
 *   3. A `../` shaped session id cannot redirect a credential write.
 *   4. The wrapper tolerates a missing identity file (that is the bot-identity
 *      fallback path), and never re-enters itself.
 *
 * Run:  npx vitest run --project unit test/cli-identity.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderIdentityEnv,
  renderIdentityWrapper,
  writeSessionIdentity,
  clearSessionIdentity,
  clearAllSessionIdentities,
  sessionIdentityPath,
  installIdentityWrapper,
  identityWrapperInstalled,
  renderGitAskpassScript,
  installGitAskpass,
  gitIdentityConfigEnv,
} from '../src/core/cli-identity.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-cli-identity-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const SESSION = 'sess-abc123';

describe('renderIdentityEnv', () => {
  it('emits the pair lark-cli needs — token alone makes it refuse outright', () => {
    const body = renderIdentityEnv({ tool: 'lark-cli', appId: 'cli_app', userAccessToken: 'u-tok' });
    expect(body).toContain("LARKSUITE_CLI_APP_ID='cli_app'");
    expect(body).toContain("LARKSUITE_CLI_USER_ACCESS_TOKEN='u-tok'");
  });

  it('omits the Codebase JWT until one has been minted', () => {
    const body = renderIdentityEnv({ tool: 'bytedcli', cloudJwt: 'a.b.c' });
    expect(body).toContain("BYTEDCLI_USER_CLOUD_JWT='a.b.c'");
    expect(body).not.toContain('BYTEDCLI_USER_CODE_JWT');
  });

  it('refuses a value carrying a line break rather than silently truncating it', () => {
    expect(() => renderIdentityEnv({ tool: 'bytedcli', cloudJwt: 'a\nb' }))
      .toThrow(/line break/);
  });
});

// A token is opaque: whatever bytes the provider issued must arrive at the tool
// unchanged. This runs a real /bin/sh to prove the round trip, because "looks
// escaped" and "sources correctly" are different claims.
describe('identity values survive a real sh source', () => {
  const nasty = [
    "quote'inside",
    'dollar$VAR and ${BRACED}',
    'back`tick`',
    'semi;colon && pipe |',
    'space  and\ttab',
    'star* glob? [brackets]',
    'back\\slash',
  ];

  for (const value of nasty) {
    it(`round-trips ${JSON.stringify(value)}`, () => {
      writeSessionIdentity(dir, SESSION, { tool: 'bytedcli', cloudJwt: value });
      const path = sessionIdentityPath(dir, SESSION, 'bytedcli');
      const out = execFileSync('/bin/sh', [
        '-c',
        `. ${JSON.stringify(path)}; printf %s "$BYTEDCLI_USER_CLOUD_JWT"`,
      ], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
      expect(out).toBe(value);
    });
  }
});

describe('writeSessionIdentity', () => {
  it('keeps the token 0600 inside a 0700 dir', () => {
    const path = writeSessionIdentity(dir, SESSION, { tool: 'lark-cli', appId: 'a', userAccessToken: 't' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'cli-identity')).mode & 0o777).toBe(0o700);
  });

  it('replaces rather than accumulates when the acting person changes', () => {
    writeSessionIdentity(dir, SESSION, { tool: 'lark-cli', appId: 'a', userAccessToken: 'tok-alice' });
    writeSessionIdentity(dir, SESSION, { tool: 'lark-cli', appId: 'a', userAccessToken: 'tok-bob' });
    const body = readFileSync(sessionIdentityPath(dir, SESSION, 'lark-cli'), 'utf8');
    expect(body).toContain('tok-bob');
    expect(body).not.toContain('tok-alice');
  });

  it('keeps concurrent sessions of one bot apart', () => {
    writeSessionIdentity(dir, 'sess-one', { tool: 'lark-cli', appId: 'a', userAccessToken: 'tok-one' });
    writeSessionIdentity(dir, 'sess-two', { tool: 'lark-cli', appId: 'a', userAccessToken: 'tok-two' });
    expect(readFileSync(sessionIdentityPath(dir, 'sess-one', 'lark-cli'), 'utf8')).toContain('tok-one');
    expect(readFileSync(sessionIdentityPath(dir, 'sess-two', 'lark-cli'), 'utf8')).toContain('tok-two');
  });

  it('refuses a traversal-shaped session id', () => {
    for (const bad of ['../escape', '..', 'a/b', '.']) {
      expect(() => writeSessionIdentity(dir, bad, { tool: 'lark-cli', appId: 'a', userAccessToken: 't' }))
        .toThrow(/unsafe session id/);
    }
  });
});

describe('clearSessionIdentity', () => {
  // The critical one. If clearing left the file in place, the next command would
  // run as the previous person — silently, with the wrong name in the audit log.
  it('removes the file so no stale identity can be inherited', () => {
    writeSessionIdentity(dir, SESSION, { tool: 'lark-cli', appId: 'a', userAccessToken: 'tok' });
    clearSessionIdentity(dir, SESSION, 'lark-cli');
    expect(existsSync(sessionIdentityPath(dir, SESSION, 'lark-cli'))).toBe(false);
  });

  it('is idempotent when nothing is there', () => {
    expect(() => clearSessionIdentity(dir, SESSION, 'bytedcli')).not.toThrow();
  });

  it('clears one tool without disturbing the other', () => {
    writeSessionIdentity(dir, SESSION, { tool: 'lark-cli', appId: 'a', userAccessToken: 'tok-lark' });
    writeSessionIdentity(dir, SESSION, { tool: 'bytedcli', cloudJwt: 'jwt' });
    clearSessionIdentity(dir, SESSION, 'lark-cli');
    expect(existsSync(sessionIdentityPath(dir, SESSION, 'lark-cli'))).toBe(false);
    expect(existsSync(sessionIdentityPath(dir, SESSION, 'bytedcli'))).toBe(true);
  });

  it('clears every tool on teardown', () => {
    writeSessionIdentity(dir, SESSION, { tool: 'lark-cli', appId: 'a', userAccessToken: 'tok' });
    writeSessionIdentity(dir, SESSION, { tool: 'bytedcli', cloudJwt: 'jwt' });
    clearAllSessionIdentities(dir, SESSION);
    expect(existsSync(sessionIdentityPath(dir, SESSION, 'lark-cli'))).toBe(false);
    expect(existsSync(sessionIdentityPath(dir, SESSION, 'bytedcli'))).toBe(false);
  });
});

// The wrapper is what actually runs, on every CLI call. These tests execute it
// against a stub "real binary" that just prints the env it received.
describe('renderIdentityWrapper', () => {
  function stubTool(): string {
    const p = join(dir, 'real-tool.sh');
    writeFileSync(p, '#!/bin/sh\nprintf "%s|%s|%s" "$LARKSUITE_CLI_APP_ID" "$LARKSUITE_CLI_USER_ACCESS_TOKEN" "$*"\n');
    chmodSync(p, 0o755);
    return p;
  }

  function runWrapper(wrapperPath: string, env: Record<string, string>, args: string[] = []): string {
    return execFileSync('/bin/sh', [wrapperPath, ...args], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', ...env },
    });
  }

  it('exports the published identity to the real tool', () => {
    const wrapperPath = join(dir, 'lark-cli');
    writeFileSync(wrapperPath, renderIdentityWrapper('lark-cli', stubTool()));
    writeSessionIdentity(dir, SESSION, { tool: 'lark-cli', appId: 'cli_app', userAccessToken: 'u-tok' });

    const out = runWrapper(wrapperPath, { SESSION_DATA_DIR: dir, BOTMUX_SESSION_ID: SESSION }, ['im', '+send']);
    expect(out).toBe('cli_app|u-tok|im +send');
  });

  // Missing file is the bot-identity fallback path, not an error: lark-cli runs
  // as the bot with no env at all. Failing closed is the daemon's call.
  it('runs the tool with no identity when the file is absent', () => {
    const wrapperPath = join(dir, 'lark-cli');
    writeFileSync(wrapperPath, renderIdentityWrapper('lark-cli', stubTool()));
    const out = runWrapper(wrapperPath, { SESSION_DATA_DIR: dir, BOTMUX_SESSION_ID: SESSION });
    expect(out).toBe('||');
  });

  it('runs the tool plainly outside a botmux session', () => {
    const wrapperPath = join(dir, 'lark-cli');
    writeFileSync(wrapperPath, renderIdentityWrapper('lark-cli', stubTool()));
    expect(runWrapper(wrapperPath, {})).toBe('||');
  });

  // A cleared identity must actually stop being used — this is the same
  // guarantee as the clear test, but observed from where it matters.
  it('stops passing an identity once it has been cleared', () => {
    const wrapperPath = join(dir, 'lark-cli');
    writeFileSync(wrapperPath, renderIdentityWrapper('lark-cli', stubTool()));
    const env = { SESSION_DATA_DIR: dir, BOTMUX_SESSION_ID: SESSION };

    writeSessionIdentity(dir, SESSION, { tool: 'lark-cli', appId: 'cli_app', userAccessToken: 'u-tok' });
    expect(runWrapper(wrapperPath, env)).toBe('cli_app|u-tok|');

    clearSessionIdentity(dir, SESSION, 'lark-cli');
    expect(runWrapper(wrapperPath, env)).toBe('||');
  });

  // Re-reading per invocation is the whole reason this is a file. Same process
  // environment, different identity — no restart involved.
  it('picks up a new identity on the next call without restarting anything', () => {
    const wrapperPath = join(dir, 'lark-cli');
    writeFileSync(wrapperPath, renderIdentityWrapper('lark-cli', stubTool()));
    const env = { SESSION_DATA_DIR: dir, BOTMUX_SESSION_ID: SESSION };

    writeSessionIdentity(dir, SESSION, { tool: 'lark-cli', appId: 'cli_app', userAccessToken: 'tok-alice' });
    expect(runWrapper(wrapperPath, env)).toContain('tok-alice');

    writeSessionIdentity(dir, SESSION, { tool: 'lark-cli', appId: 'cli_app', userAccessToken: 'tok-bob' });
    expect(runWrapper(wrapperPath, env)).toContain('tok-bob');
  });

  // The wrapper shadows the tool's own name on PATH, so resolving by name would
  // re-enter this script forever.
  it('execs the real binary by absolute path, never by name', () => {
    const script = renderIdentityWrapper('lark-cli', '/opt/homebrew/bin/lark-cli');
    expect(script).toContain("exec '/opt/homebrew/bin/lark-cli' \"$@\"");
    expect(script).not.toMatch(/^exec lark-cli/m);
  });

  it('leaves no scratch variable behind in the tool\'s environment', () => {
    const probe = join(dir, 'probe.sh');
    writeFileSync(probe, '#!/bin/sh\nprintf "%s" "${__botmux_cred-unset}"\n');
    chmodSync(probe, 0o755);
    const wrapperPath = join(dir, 'bytedcli');
    writeFileSync(wrapperPath, renderIdentityWrapper('bytedcli', probe));
    writeSessionIdentity(dir, SESSION, { tool: 'bytedcli', cloudJwt: 'jwt' });
    const out = execFileSync('/bin/sh', [wrapperPath], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', SESSION_DATA_DIR: dir, BOTMUX_SESSION_ID: SESSION },
    });
    expect(out).toBe('unset');
  });
});

describe('installIdentityWrapper', () => {
  it('installs an executable wrapper', () => {
    const binDir = join(dir, 'bin');
    const path = installIdentityWrapper(binDir, 'lark-cli', '/usr/local/bin/lark-cli');
    expect(path).toBe(join(binDir, 'lark-cli'));
    expect(statSync(path!).mode & 0o777).toBe(0o755);
    expect(identityWrapperInstalled(binDir, 'lark-cli')).toBe(true);
  });

  // A wrapper pointing at a binary that is not there would turn "tool not
  // installed" into a confusing wrapper error.
  it('installs nothing when the real tool is absent', () => {
    const binDir = join(dir, 'bin');
    expect(installIdentityWrapper(binDir, 'bytedcli', null)).toBeNull();
    expect(identityWrapperInstalled(binDir, 'bytedcli')).toBe(false);
  });
});

// Git over HTTPS to Codebase authenticates with a Codebase JWT, which git mints
// via GIT_ASKPASS and which reads none of the identity env vars. Without this
// helper, work pushed on someone's behalf would carry the machine's identity —
// and "who opened this MR" is the attribution that matters most.
describe('renderGitAskpassScript / installGitAskpass', () => {
  function runAskpass(scriptPath: string, prompt: string): string {
    return execFileSync('/bin/sh', [scriptPath, prompt], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
  }

  it('answers the username prompt with git\'s expected sentinel', () => {
    const p = join(dir, 'askpass');
    writeFileSync(p, renderGitAskpassScript('/bin/false'));
    expect(runAskpass(p, "Username for 'https://git.example.com': ")).toBe('x-access-token');
  });

  // Parses the real bytedcli response shape: {"status":…,"data":{"jwt":"…"}}.
  it('extracts the JWT for the password prompt', () => {
    const stub = join(dir, 'bytedcli-stub.sh');
    writeFileSync(stub, '#!/bin/sh\nprintf \'%s\' \'{"status":"success","data":{"jwt":"a.b.c"},"error":null}\'\n');
    chmodSync(stub, 0o755);
    const p = join(dir, 'askpass');
    writeFileSync(p, renderGitAskpassScript(stub));
    expect(runAskpass(p, "Password for 'https://x@git.example.com': ")).toBe('a.b.c');
  });

  // No credentials must produce an empty answer, which git reports as an auth
  // failure — not a shell error that looks like a botmux bug.
  it('answers empty when no JWT can be minted', () => {
    const stub = join(dir, 'failing.sh');
    writeFileSync(stub, '#!/bin/sh\nexit 1\n');
    chmodSync(stub, 0o755);
    const p = join(dir, 'askpass');
    writeFileSync(p, renderGitAskpassScript(stub));
    expect(runAskpass(p, 'Password: ')).toBe('');
  });

  // Pointing at the WRAPPED bytedcli is what makes git inherit the per-turn
  // identity — a helper aimed at the real binary would silently use the
  // machine's own SSO session instead.
  it('installs pointing at the wrapped bytedcli, not the real binary', () => {
    const binDir = join(dir, 'bin');
    const path = installGitAskpass(binDir, true);
    expect(path).toBe(join(binDir, 'botmux-git-askpass'));
    expect(readFileSync(path!, 'utf8')).toContain(join(binDir, 'bytedcli'));
    expect(statSync(path!).mode & 0o777).toBe(0o755);
  });

  it('installs nothing when bytedcli is not wrapped for this session', () => {
    expect(installGitAskpass(join(dir, 'bin'), false)).toBeNull();
  });

  // The helper is reached FROM git, and bytedcli shells out to git for repo
  // context. Without resetting the config that inner git re-reads the very
  // credential helper that invoked us — recursing, or silently taking an SSH
  // path that authenticates as the machine instead of the person.
  it('neutralizes git config and SSH before calling bytedcli', () => {
    const script = renderGitAskpassScript('/usr/local/bin/bytedcli');
    expect(script).toContain('GIT_CONFIG_COUNT=0');
    expect(script).toContain('GIT_SSH_COMMAND=false');
  });

  it('falls back to the exchange endpoint when bytedcli yields nothing', () => {
    const failing = join(dir, 'no-token.sh');
    writeFileSync(failing, '#!/bin/sh\nexit 1\n');
    chmodSync(failing, 0o755);
    // Stub `curl` on PATH so the fallback is exercised without a network call.
    const stubBin = join(dir, 'stub-bin');
    mkdirSync(stubBin, { recursive: true });
    writeFileSync(join(stubBin, 'curl'),
      '#!/bin/sh\nprintf \'%s\' \'{"code":0,"data":{"code_base_token":"from-exchange"}}\'\n');
    chmodSync(join(stubBin, 'curl'), 0o755);

    const p = join(dir, 'askpass');
    writeFileSync(p, renderGitAskpassScript(failing, 'https://exchange.example.com/token'));
    const out = execFileSync('/bin/sh', [p, 'Password: '], {
      encoding: 'utf8',
      env: { PATH: `${stubBin}:/usr/bin:/bin`, BYTEDCLI_USER_CLOUD_JWT: 'a.b.c' },
    });
    expect(out).toBe('from-exchange');
  });

  // No cloud JWT means there is nothing to exchange — it must not call out with
  // an empty credential and must still answer empty rather than erroring.
  it('skips the fallback when there is no cloud JWT to exchange', () => {
    const failing = join(dir, 'no-token2.sh');
    writeFileSync(failing, '#!/bin/sh\nexit 1\n');
    chmodSync(failing, 0o755);
    const p = join(dir, 'askpass2');
    writeFileSync(p, renderGitAskpassScript(failing, 'https://exchange.example.com/token'));
    const out = execFileSync('/bin/sh', [p, 'Password: '], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(out).toBe('');
  });

  // A JWT in a remote URL would persist in .git/config and leak into any error
  // message git prints.
  it('never embeds the token in a URL or writes it to disk', () => {
    const script = renderGitAskpassScript('/usr/local/bin/bytedcli');
    expect(script).not.toMatch(/https:\/\/\S*\$/);
    expect(script).not.toMatch(/>\s*\/tmp|>\s*\$TMPDIR|tee /);
  });
});

// SSH remotes are the quiet escape hatch: a repo cloned over SSH keeps using the
// machine's key, the push lands under the host's identity, and nothing reports a
// problem. Rewriting to HTTPS for the configured host closes that path.
describe('gitIdentityConfigEnv', () => {
  it('binds the helper to one host and rewrites its SSH remotes', () => {
    const env = gitIdentityConfigEnv('/tmp/askpass', 'code.example.com');
    const pairs: Record<string, string> = {};
    for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) {
      pairs[env[`GIT_CONFIG_KEY_${i}`]] = env[`GIT_CONFIG_VALUE_${i}`];
    }
    expect(pairs['credential.https://code.example.com.helper']).toContain('/tmp/askpass');
    expect(pairs['url.https://code.example.com/.insteadOf']).toBeDefined();
  });

  it('declares a count matching the entries, so git reads them all', () => {
    const env = gitIdentityConfigEnv('/tmp/askpass', 'code.example.com');
    const count = Number(env.GIT_CONFIG_COUNT);
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      expect(env[`GIT_CONFIG_KEY_${i}`]).toBeTruthy();
      expect(env[`GIT_CONFIG_VALUE_${i}`]).toBeTruthy();
    }
    expect(env[`GIT_CONFIG_KEY_${count}`]).toBeUndefined();
  });
});
