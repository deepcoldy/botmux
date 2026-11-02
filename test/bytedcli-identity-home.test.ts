/**
 * bytedcli under a trigger-user identity runs with a per-person HOME scoped to
 * that one exec (the lark-cli device-code identity does the same). bytedcli
 * writes `$HOME/.local/share/bytedcli` even on injected JWTs — userinfo.json
 * with the acting person's profile, Codebase repo caches, traces — so the
 * machine HOME would be a directory every person's turns share.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bytedcliTurnHome,
  canonicalPathNearest,
  publishActiveTurn,
  recallProvenIdentityContent,
  refreshSessionIdentity,
  renderIdentityEnv,
  renderIdentityWrapper,
  writeSessionIdentity,
} from '../src/core/cli-identity.js';
import { ensureSessionTempDir, sessionTempDir } from '../src/core/session-temp.js';

const SESSION = 'sess-bytedcli-home';
let dir: string;
let previousHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-bytedcli-home-'));
  // The session scratch root derives from HOME; keep it inside this test dir.
  previousHome = process.env.HOME;
  process.env.HOME = join(dir, 'machine-home');
  mkdirSync(process.env.HOME, { recursive: true });
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
});

const dataDir = () => join(dir, 'data');

function stubTool(): string {
  const p = join(dir, 'real-bytedcli.sh');
  // Reports the HOME it ran with and writes where bytedcli would.
  writeFileSync(p, [
    '#!/bin/sh',
    'mkdir -p "$HOME/.local/share/bytedcli/data"',
    'echo me > "$HOME/.local/share/bytedcli/data/userinfo.json"',
    'printf "%s|%s|%s" "$HOME" "$BYTEDCLI_USER_CLOUD_JWT" "$*"',
    '',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

function runWrapper(wrapperPath: string, args: string[] = []): string {
  return execFileSync('/bin/sh', [wrapperPath, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', SESSION_DATA_DIR: dataDir(), BOTMUX_SESSION_ID: SESSION, HOME: process.env.HOME! },
  });
}

describe('bytedcli per-person HOME', () => {
  it('lives in the session scratch, one directory per person', () => {
    const alice = bytedcliTurnHome(dataDir(), SESSION, { openId: 'ou_alice' });
    const bob = bytedcliTurnHome(dataDir(), SESSION, { openId: 'ou_bob' });
    expect(alice.startsWith(canonicalPathNearest(join(sessionTempDir(dataDir(), SESSION), 'identity-home', 'bytedcli')) + '/')).toBe(true);
    expect(alice).not.toBe(bob);
    // Stable for the same person across turns; another session gets its own.
    expect(bytedcliTurnHome(dataDir(), SESSION, { openId: 'ou_alice' })).toBe(alice);
    expect(bytedcliTurnHome(dataDir(), 'sess-other', { openId: 'ou_alice' })).not.toBe(alice);
  });

  it('without an open_id keeps one directory per session, not one per turn', () => {
    writeSessionIdentity(dataDir(), SESSION, { tool: 'bytedcli', cloudJwt: 'jwt-turn-1', turnId: 't1' }, 'proven');
    writeSessionIdentity(dataDir(), SESSION, { tool: 'bytedcli', cloudJwt: 'jwt-turn-2', turnId: 't2' }, 'proven');
    const homeOf = (turnId: string) => /BOTMUX_IDENTITY_HOME='([^']+)'/.exec(
      recallProvenIdentityContent(dataDir(), SESSION, turnId, 'bytedcli')!)?.[1];
    expect(homeOf('t1')).toBeDefined();
    expect(homeOf('t2')).toBe(homeOf('t1'));
    expect(homeOf('t1')).not.toBe(bytedcliTurnHome(dataDir(), SESSION, { openId: 'ou_alice' }));
  });

  it('publishes the HOME with a granted identity, never with a refusal', () => {
    writeSessionIdentity(dataDir(), SESSION, {
      tool: 'bytedcli', cloudJwt: 'jwt-a', openId: 'ou_alice', turnId: 'turn-1',
    }, 'proven');
    const granted = recallProvenIdentityContent(dataDir(), SESSION, 'turn-1', 'bytedcli')!;
    const home = bytedcliTurnHome(dataDir(), SESSION, { openId: 'ou_alice' });
    expect(granted).toContain(`BOTMUX_IDENTITY_HOME='${home}'`);
    // Path only: nothing is created on the daemon side.
    expect(existsSync(home)).toBe(false);
    expect(renderIdentityEnv({ tool: 'bytedcli', mode: 'denied', message: 'no' })).not.toContain('BOTMUX_IDENTITY_HOME');
    // The Codebase companion keeps its own (unchanged) shape.
    expect(recallProvenIdentityContent(dataDir(), SESSION, 'turn-1', 'codebase')).not.toContain('BOTMUX_IDENTITY_HOME');
  });

  it('a refresh of the same turn publishes the same HOME as the original publication', () => {
    writeSessionIdentity(dataDir(), SESSION, {
      tool: 'bytedcli', cloudJwt: 'jwt-a', openId: 'ou_alice', turnId: 'turn-r',
    }, 'proven');
    publishActiveTurn(dataDir(), SESSION, 'turn-r');
    const before = recallProvenIdentityContent(dataDir(), SESSION, 'turn-r', 'bytedcli')!;
    expect(refreshSessionIdentity(dataDir(), SESSION, {
      tool: 'bytedcli', cloudJwt: 'jwt-a2', openId: 'ou_alice', turnId: 'turn-r',
    }, 'proven')).toBe(true);
    const after = recallProvenIdentityContent(dataDir(), SESSION, 'turn-r', 'bytedcli')!;
    const homeOf = (body: string) => /BOTMUX_IDENTITY_HOME='([^']+)'/.exec(body)?.[1];
    expect(after).toContain("BYTEDCLI_USER_CLOUD_JWT='jwt-a2'");
    expect(homeOf(after)).toBe(homeOf(before));
    expect(homeOf(after)).toBe(bytedcliTurnHome(dataDir(), SESSION, { openId: 'ou_alice' }));
  });

  it('the wrapper runs that exec with the person HOME and leaves the machine HOME untouched', () => {
    ensureSessionTempDir(dataDir(), SESSION);
    const wrapperPath = join(dir, 'bytedcli');
    writeFileSync(wrapperPath, renderIdentityWrapper('bytedcli', stubTool(), 'single'));
    writeSessionIdentity(dataDir(), SESSION, { tool: 'bytedcli', cloudJwt: 'jwt-a', openId: 'ou_alice' }, 'single');
    const home = bytedcliTurnHome(dataDir(), SESSION, { openId: 'ou_alice' });

    expect(runWrapper(wrapperPath, ['auth', 'userinfo'])).toBe(`${home}|jwt-a|auth userinfo`);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(existsSync(join(home, '.local/share/bytedcli/data/userinfo.json'))).toBe(true);
    expect(existsSync(join(process.env.HOME!, '.local'))).toBe(false);

    // Next person in the same session writes into their own directory.
    writeSessionIdentity(dataDir(), SESSION, { tool: 'bytedcli', cloudJwt: 'jwt-b', openId: 'ou_bob' }, 'single');
    const bobHome = bytedcliTurnHome(dataDir(), SESSION, { openId: 'ou_bob' });
    expect(runWrapper(wrapperPath)).toBe(`${bobHome}|jwt-b|`);
    expect(existsSync(join(bobHome, '.local/share/bytedcli/data/userinfo.json'))).toBe(true);
  });

  it('an identity published without a HOME (before this change) keeps the machine HOME', () => {
    const wrapperPath = join(dir, 'bytedcli-legacy');
    writeFileSync(wrapperPath, renderIdentityWrapper('bytedcli', stubTool(), 'single'));
    const envDir = join(dataDir(), 'cli-identity', `${SESSION}.bin`, '.data');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, 'bytedcli.env'), renderIdentityEnv({ tool: 'bytedcli', cloudJwt: 'jwt-old' }));
    expect(runWrapper(wrapperPath)).toBe(`${process.env.HOME}|jwt-old|`);
  });

  it('an inherited BOTMUX_IDENTITY_HOME cannot redirect an identity that carries no HOME', () => {
    const forged = join(dir, 'forged-home');
    const envDir = join(dataDir(), 'cli-identity', `${SESSION}.bin`, '.data');
    mkdirSync(envDir, { recursive: true });
    const run = (tool: 'bytedcli' | 'lark-cli' | 'codebase', body: string) => {
      const wrapperPath = join(dir, `wrapper-${tool}`);
      writeFileSync(wrapperPath, renderIdentityWrapper(tool, stubTool(), 'single'));
      writeFileSync(join(envDir, `${tool}.env`), body);
      return execFileSync('/bin/sh', [wrapperPath], {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin', SESSION_DATA_DIR: dataDir(), BOTMUX_SESSION_ID: SESSION,
          HOME: process.env.HOME!, BOTMUX_IDENTITY_HOME: forged,
        },
      }).split('|')[0];
    };
    expect(run('bytedcli', renderIdentityEnv({ tool: 'bytedcli', cloudJwt: 'jwt-old' }))).toBe(process.env.HOME);
    expect(run('lark-cli', renderIdentityEnv({ tool: 'lark-cli', appId: 'cli_app', userAccessToken: 'u' }))).toBe(process.env.HOME);
    expect(run('lark-cli', renderIdentityEnv({ tool: 'lark-cli', mode: 'bot', appId: 'cli_app', appSecret: 's' }))).toBe(process.env.HOME);
    expect(run('codebase', renderIdentityEnv({ tool: 'codebase', codeJwt: 'c' }))).toBe(process.env.HOME);
    expect(existsSync(forged)).toBe(false);
  });

  it('the lark-cli and codebase wrappers are unaffected by a bytedcli HOME', () => {
    const body = renderIdentityEnv({ tool: 'lark-cli', appId: 'cli_app', userAccessToken: 'u' });
    expect(body).not.toContain('BOTMUX_IDENTITY_HOME');
    expect(renderIdentityEnv({ tool: 'codebase', codeJwt: 'c' })).not.toContain('BOTMUX_IDENTITY_HOME');
  });
});
