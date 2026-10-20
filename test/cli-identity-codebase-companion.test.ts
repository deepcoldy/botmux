/**
 * `codebase` (the Codebase CLI) as a COMPANION of bytedcli: its identity is the
 * Codebase JWT bytedcli mints, published alongside every bytedcli publication,
 * wrapped whenever bytedcli is governed, never authorized on its own.
 *
 * Run:  npx vitest run --project unit test/cli-identity-codebase-companion.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeSessionIdentity,
  clearSessionIdentity,
  sessionIdentityPath,
  sessionIdentityBinDir,
  renderIdentityWrapper,
  identityToolsFor,
  codebaseCompanionOf,
  prepareTriggerUserCliEnv,
  identityWrapperInstalled,
  IDENTITY_ENV_KEYS,
} from '../src/core/cli-identity.js';

const SESSION = 'sess-cb';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-codebase-companion-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const read = (tool: 'bytedcli' | 'codebase') => readFileSync(sessionIdentityPath(dir, SESSION, tool), 'utf8');

describe('companion publication', () => {
  it('a bytedcli grant with a Codebase JWT publishes codebase as the same person and turn', () => {
    writeSessionIdentity(dir, SESSION, { tool: 'bytedcli', cloudJwt: 'cloud', codeJwt: 'code-jwt', turnId: 'om_1', openId: 'ou_a' });
    const body = read('codebase');
    expect(body).toContain("BOTMUX_IDENTITY_MODE='user'");
    expect(body).toContain("CODEBASE_CLI_USER_JWT='code-jwt'");
    expect(body).toContain("BOTMUX_IDENTITY_TURN='om_1'");
    expect(body).toContain("BOTMUX_IDENTITY_OPEN_ID='ou_a'");
    expect(body).not.toContain('BYTEDCLI_USER_CLOUD_JWT');
  });

  it('a bytedcli grant WITHOUT a Codebase JWT refuses codebase instead of letting it use the machine login', () => {
    writeSessionIdentity(dir, SESSION, { tool: 'bytedcli', cloudJwt: 'cloud', turnId: 'om_1' });
    expect(read('bytedcli')).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud'");
    const body = read('codebase');
    expect(body).toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(body).toContain('Codebase');
  });

  it('a bytedcli refusal is mirrored verbatim', () => {
    writeSessionIdentity(dir, SESSION, { tool: 'bytedcli', mode: 'denied', message: 'botmux: 需要授权 bytedcli', turnId: 'om_2' });
    const body = read('codebase');
    expect(body).toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(body).toContain('需要授权 bytedcli');
    expect(body).toContain("BOTMUX_IDENTITY_TURN='om_2'");
  });

  it('clearing bytedcli clears the companion too; lark-cli does not touch it', () => {
    writeSessionIdentity(dir, SESSION, { tool: 'bytedcli', cloudJwt: 'c', codeJwt: 'k' });
    writeSessionIdentity(dir, SESSION, { tool: 'lark-cli', appId: 'a', userAccessToken: 't' });
    clearSessionIdentity(dir, SESSION, 'lark-cli');
    expect(existsSync(sessionIdentityPath(dir, SESSION, 'codebase'))).toBe(true);
    clearSessionIdentity(dir, SESSION, 'bytedcli');
    expect(existsSync(sessionIdentityPath(dir, SESSION, 'bytedcli'))).toBe(false);
    expect(existsSync(sessionIdentityPath(dir, SESSION, 'codebase'))).toBe(false);
  });

  it('the companion exports exactly the variable the Codebase CLI reads (`codebase auth login --help`: CODEBASE_CLI_USER_JWT)', () => {
    expect(IDENTITY_ENV_KEYS.codebase).toEqual(['CODEBASE_CLI_USER_JWT']);
  });

  it('identityToolsFor adds codebase only when bytedcli is governed, without duplicates', () => {
    expect(identityToolsFor(['bytedcli', 'bytedcli'])).toEqual(['bytedcli', 'codebase']);
    expect(identityToolsFor(['lark-cli'])).toEqual(['lark-cli']);
    expect(identityToolsFor(['bytedcli'])).toEqual(['bytedcli', 'codebase']);
    expect(identityToolsFor(['lark-cli', 'bytedcli'])).toEqual(['lark-cli', 'bytedcli', 'codebase']);
    expect(codebaseCompanionOf({ tool: 'bytedcli', cloudJwt: 'c', codeJwt: 'k', openId: 'ou' })).toEqual({ tool: 'codebase', codeJwt: 'k', openId: 'ou' });
  });
});

describe('companion wrapper', () => {
  it('exports CODEBASE_CLI_USER_JWT to the real codebase binary', () => {
    const real = join(dir, 'real-codebase.sh');
    writeFileSync(real, '#!/bin/sh\nprintf "%s|%s|%s" "$CODEBASE_CLI_USER_JWT" "${BYTEDCLI_USER_CODE_JWT:-unset}" "$*"\n');
    chmodSync(real, 0o755);
    const wrapper = join(dir, 'codebase');
    writeFileSync(wrapper, renderIdentityWrapper('codebase', real));
    writeSessionIdentity(dir, SESSION, { tool: 'bytedcli', cloudJwt: 'cloud', codeJwt: 'code-jwt' });
    const out = execFileSync('/bin/sh', [wrapper, 'mr', 'list'], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', SESSION_DATA_DIR: dir, BOTMUX_SESSION_ID: SESSION },
    });
    expect(out).toBe('code-jwt|unset|mr list');
  });

  it('a refused bytedcli identity makes the codebase wrapper refuse too, never running the real binary', () => {
    const real = join(dir, 'real-codebase-denied.sh');
    writeFileSync(real, '#!/bin/sh\necho RAN_AS_MACHINE\n');
    chmodSync(real, 0o755);
    const wrapper = join(dir, 'codebase');
    writeFileSync(wrapper, renderIdentityWrapper('codebase', real));
    writeSessionIdentity(dir, SESSION, { tool: 'bytedcli', mode: 'denied', message: 'botmux: 需要授权 bytedcli' });
    let status = 0; let stderr = ''; let stdout = '';
    try {
      stdout = execFileSync('/bin/sh', [wrapper, 'mr', 'list'], {
        encoding: 'utf8', env: { PATH: '/usr/bin:/bin', SESSION_DATA_DIR: dir, BOTMUX_SESSION_ID: SESSION }, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) { status = e.status; stderr = String(e.stderr ?? ''); stdout = String(e.stdout ?? ''); }
    expect(status).toBe(77);
    expect(stderr).toContain('需要授权 bytedcli');
    expect(stdout).not.toContain('RAN_AS_MACHINE');
    // Same when bytedcli was granted but no Codebase JWT came with it.
    writeSessionIdentity(dir, SESSION, { tool: 'bytedcli', cloudJwt: 'cloud' });
    let status2 = 0;
    try { execFileSync('/bin/sh', [wrapper], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', SESSION_DATA_DIR: dir, BOTMUX_SESSION_ID: SESSION }, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e: any) { status2 = e.status; }
    expect(status2).toBe(77);
  });

  it('prepareTriggerUserCliEnv wraps codebase whenever bytedcli is governed', () => {
    const fakeBin = join(dir, 'fakebin');
    mkdirSync(fakeBin);
    for (const name of ['bytedcli', 'codebase']) {
      writeFileSync(join(fakeBin, name), '#!/bin/sh\necho real\n');
      chmodSync(join(fakeBin, name), 0o755);
    }
    const env: NodeJS.ProcessEnv = { PATH: `${fakeBin}:/usr/bin:/bin` };
    const logs: string[] = [];
    prepareTriggerUserCliEnv(env, dir, SESSION, { enabled: true, tools: ['bytedcli'], fallback: 'none' }, m => logs.push(m));
    const binDir = sessionIdentityBinDir(dir, SESSION);
    expect(identityWrapperInstalled(binDir, 'bytedcli')).toBe(true);
    expect(identityWrapperInstalled(binDir, 'codebase')).toBe(true);
    expect(identityWrapperInstalled(binDir, 'lark-cli')).toBe(false);
    expect(existsSync(sessionIdentityPath(dir, SESSION, 'codebase'))).toBe(true);
    expect(logs.some(l => l.includes('wrapping codebase'))).toBe(true);
    expect(env.PATH!.startsWith(binDir)).toBe(true);
  });
});
