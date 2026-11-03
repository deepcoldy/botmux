import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeCredentialsSourceDir,
  planCredentialSource,
  readCredentialSource,
} from '../src/services/cli-credential-source.js';
import { parseBotConfigsFromText } from '../src/bot-registry.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function account(cred: string | null): string {
  const d = mkdtempSync(join(tmpdir(), 'botmux-cred-src-'));
  dirs.push(d);
  if (cred !== null) {
    mkdirSync(join(d, 'claude'));
    writeFileSync(join(d, 'claude', '.credentials.json'), cred);
  }
  return d;
}
const VALID = JSON.stringify({ claudeAiOauth: { accessToken: 'at-b', refreshToken: 'rt-b', expiresAt: 1 } });

describe('normalizeCredentialsSourceDir', () => {
  it('treats missing/blank as unset', () => {
    expect(normalizeCredentialsSourceDir(undefined)).toBeUndefined();
    expect(normalizeCredentialsSourceDir('   ')).toBeUndefined();
  });
  it('expands ~/ against the given home and resolves', () => {
    expect(normalizeCredentialsSourceDir('~/accounts/b/', '/h/u')).toBe('/h/u/accounts/b');
    expect(normalizeCredentialsSourceDir('/abs/x/../y')).toBe('/abs/y');
  });
  it('rejects relative paths and non-strings', () => {
    expect(() => normalizeCredentialsSourceDir('accounts/b')).toThrow(/absolute/);
    expect(() => normalizeCredentialsSourceDir('~other/b')).toThrow(/absolute/);
    expect(() => normalizeCredentialsSourceDir(42)).toThrow(/string/);
  });
});

describe('planCredentialSource', () => {
  const base = {
    cliId: 'claude-code', sandboxRequested: true, willRedirectCliData: true, isClaudeFamily: true,
    supportsReadIsolation: true, sessionDataDirPresent: true, home: '/h/u',
  };
  const notSandboxed = { ...base, sandboxRequested: false, willRedirectCliData: false };
  it('is a no-op when unset (historical shared-login behaviour)', () => {
    expect(planCredentialSource({ ...base })).toEqual({ kind: 'default' });
    for (const v of [notSandboxed, { ...base, willRedirectCliData: false }, { ...base, wrapperCli: 'aiden x', willRedirectCliData: false }]) {
      expect(planCredentialSource(v)).toEqual({ kind: 'default' });
    }
  });
  it('copies for a redirected Claude-family bot', () => {
    expect(planCredentialSource({ ...base, sourceDir: '~/accounts/b' }))
      .toEqual({ kind: 'copy', family: 'claude', sourceDir: '/h/u/accounts/b' });
    // Forced per-bot home without a sandbox request still counts as redirected.
    expect(planCredentialSource({ ...base, sandboxRequested: false, sourceDir: '/acc/b' }))
      .toEqual({ kind: 'copy', family: 'claude', sourceDir: '/acc/b' });
  });
  it('only warns for a non-redirected bot — it keeps the global login, as today', () => {
    const plan = planCredentialSource({ ...notSandboxed, sourceDir: '/acc/b' });
    expect(plan.kind).toBe('ineffective');
    const bad = planCredentialSource({ ...notSandboxed, sourceDir: 'rel' });
    expect(bad.kind).toBe('ineffective');
  });
  it.each([
    ['wrapperCli', { wrapperCli: 'aiden x' }, /wrapperCli is set/],
    ['adapter without redirection', { cliId: 'genius', supportsReadIsolation: false }, /adapter genius does not support/],
    ['missing SESSION_DATA_DIR', { sessionDataDirPresent: false }, /SESSION_DATA_DIR is missing/],
  ])('refuses when the sandbox is requested but the data dir is not redirected (%s)', (_l, extra, re) => {
    const plan = planCredentialSource({ ...base, ...extra, willRedirectCliData: false, sourceDir: '/acc/b' });
    expect(plan).toMatchObject({ kind: 'refuse' });
    const reason = (plan as { reason: string }).reason;
    expect(reason).toMatch(re);
    expect(reason).toContain("this bot's credentialsSourceDir cannot take effect");
    // A bad path under a requested sandbox is also a refusal, not a warning.
    expect(planCredentialSource({ ...base, ...extra, willRedirectCliData: false, sourceDir: 'rel' }).kind).toBe('refuse');
  });

  it('allow-lists claude-code only: other Claude-family forks are refused', () => {
    for (const cliId of ['seed', 'relay', 'some-future-claude-fork', 'constructor', '__proto__']) {
      const plan = planCredentialSource({ ...base, cliId, sourceDir: '/acc/b' });
      expect(plan).toMatchObject({ kind: 'refuse' });
      expect((plan as { reason: string }).reason).toContain(`cli ${cliId}`);
    }
  });

  it('refuses an unsupported CLI family instead of running on the shared login', () => {
    const plan = planCredentialSource({ ...base, cliId: 'codex', isClaudeFamily: false, sourceDir: '/acc/b' });
    expect(plan).toMatchObject({ kind: 'refuse' });
    expect((plan as { reason: string }).reason).toContain('codex');
  });
  it('refuses a relative path and the codexAuthSync=isolated conflict on a redirected bot', () => {
    expect(planCredentialSource({ ...base, sourceDir: 'rel/b' }).kind).toBe('refuse');
    expect(planCredentialSource({ ...base, sourceDir: '/acc/b', codexAuthSync: 'isolated' }).kind).toBe('refuse');
  });
});

describe('readCredentialSource', () => {
  it('returns the Claude credential file verbatim (trimmed)', () => {
    const d = account(`${VALID}\n`);
    expect(readCredentialSource(d, 'claude')).toEqual({ '.credentials.json': VALID });
  });
  it.each([
    ['missing', null, /unreadable/],
    ['empty', '  \n', /empty/],
    ['not JSON', '{nope', /not valid JSON/],
    ['no access token', JSON.stringify({ claudeAiOauth: { refreshToken: 'x' } }), /accessToken/],
  ])('throws when the source is %s', (_label, cred, re) => {
    expect(() => readCredentialSource(account(cred), 'claude')).toThrow(re);
  });
  it('throws when the credential path is a directory', () => {
    const d = account(null);
    mkdirSync(join(d, 'claude', '.credentials.json'), { recursive: true });
    expect(() => readCredentialSource(d, 'claude')).toThrow(/not a regular file/);
  });
});

describe('bots.json credentialsSourceDir parsing', () => {
  const parse = (extra: Record<string, unknown>) =>
    parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'cs1', larkAppSecret: 's', ...extra }]))[0];
  it('stays undefined when absent', () => {
    expect(parse({}).credentialsSourceDir).toBeUndefined();
  });
  it('normalizes ~/ to an absolute path', () => {
    expect(parse({ credentialsSourceDir: '~/accounts/b' }).credentialsSourceDir).toBe(join(homedir(), 'accounts/b'));
  });
  it('rejects a relative path and the codexAuthSync=isolated conflict at load time', () => {
    expect(() => parse({ credentialsSourceDir: 'accounts/b' })).toThrow(/Bot config \[0\]: credentialsSourceDir must be an absolute path/);
    expect(() => parse({ cliId: 'codex', credentialsSourceDir: '/acc/b', codexAuthSync: 'isolated' }))
      .toThrow(/cannot be combined with codexAuthSync/);
  });
});

describe('fail-closed hardening: symlinks, file modes, auth overrides, stamps', () => {
  it('refuses a leaf symlink as the source credential', async () => {
    const { symlinkSync } = await import('node:fs');
    const real = account(VALID);
    const d = account(null);
    mkdirSync(join(d, 'claude'));
    symlinkSync(join(real, 'claude', '.credentials.json'), join(d, 'claude', '.credentials.json'));
    expect(() => readCredentialSource(d, 'claude')).toThrow(/unreadable/);
  });

  it('writeFileAtomic0600 replaces a planted symlink instead of writing through it, and forces 0600', async () => {
    const { symlinkSync, readFileSync: rf, lstatSync, chmodSync } = await import('node:fs');
    const { writeFileAtomic0600 } = await import('../src/services/cli-credential-source.js');
    const d = account(null);
    const victim = join(d, 'victim');
    writeFileSync(victim, 'untouched');
    const dst = join(d, 'dst');
    symlinkSync(victim, dst);
    writeFileAtomic0600(dst, 'secret');
    expect(rf(victim, 'utf-8')).toBe('untouched');
    expect(lstatSync(dst).isSymbolicLink()).toBe(false);
    expect(rf(dst, 'utf-8')).toBe('secret');
    const loose = join(d, 'loose');
    writeFileSync(loose, 'secret');
    chmodSync(loose, 0o644);
    writeFileAtomic0600(loose, 'secret');
    expect(lstatSync(loose).mode & 0o777).toBe(0o600);
  });

  it('refuses per-bot env auth overrides alongside a source dir', () => {
    const plan = planCredentialSource({
      cliId: 'claude-code', sandboxRequested: true, willRedirectCliData: true, isClaudeFamily: true, supportsReadIsolation: true, sessionDataDirPresent: true, sourceDir: '/acc/b',
      perBotEnv: { ANTHROPIC_API_KEY: 'k', HTTPS_PROXY: 'p' },
    });
    expect(plan).toMatchObject({ kind: 'refuse' });
    expect((plan as { reason: string }).reason).toContain('ANTHROPIC_API_KEY');
    expect(planCredentialSource({
      cliId: 'claude-code', sandboxRequested: true, willRedirectCliData: true, isClaudeFamily: true, supportsReadIsolation: true, sessionDataDirPresent: true, sourceDir: '/acc/b',
      perBotEnv: { HTTPS_PROXY: 'p', ANTHROPIC_AUTH_TOKEN: '' },
    }).kind).toBe('copy');
  });

  it('detects settings-level auth overrides (env keys and apiKeyHelper)', async () => {
    const { claudeSettingsAuthOverrides } = await import('../src/services/cli-credential-source.js');
    const d = account(null);
    const p = join(d, 'settings.json');
    expect(claudeSettingsAuthOverrides(p)).toEqual([]);
    writeFileSync(p, JSON.stringify({ apiKeyHelper: '/bin/key', env: { CLAUDE_CODE_USE_BEDROCK: '1', HTTPS_PROXY: 'x' } }));
    expect(claudeSettingsAuthOverrides(p)).toEqual(['apiKeyHelper', 'CLAUDE_CODE_USE_BEDROCK']);
  });

  it('stamps round-trip; absent ≡ shared login; garbage never matches any config', async () => {
    const { readCredentialSourceStamp, writeCredentialSourceStamp, credentialSourceStampPath } =
      await import('../src/services/cli-credential-source.js');
    const d = account(null);
    expect(readCredentialSourceStamp(d, 's1')).toBeNull();
    writeCredentialSourceStamp(d, 's1', '/acc/b');
    expect(readCredentialSourceStamp(d, 's1')).toBe('/acc/b');
    writeCredentialSourceStamp(d, 's1', undefined);
    expect(readCredentialSourceStamp(d, 's1')).toBeNull();
    mkdirSync(join(d, 'credentials-source'), { recursive: true });
    writeFileSync(credentialSourceStampPath(d, 's2'), 'garbage');
    writeFileSync(credentialSourceStampPath(d, 's3'), '{}');
    mkdirSync(credentialSourceStampPath(d, 's4'));
    for (const id of ['s2', 's3', 's4']) {
      const g = readCredentialSourceStamp(d, id);
      expect(g).not.toBeNull();
      expect(g).not.toBe('/acc/b');
      expect(g).not.toBe('garbage');
    }
  });
});

describe('fail-closed hardening: settings layers, parent directory, temp cleanup', () => {
  it('checks project shared/local and managed settings layers, failing closed on unparseable files', async () => {
    const { claudeAuthOverridesInSettingsLayers } = await import('../src/services/cli-credential-source.js');
    const d = account(null);
    const work = join(d, 'work');
    mkdirSync(join(work, '.claude'), { recursive: true });
    const user = join(d, 'user-settings.json');
    const managed = join(d, 'managed.json');
    const layers = () => claudeAuthOverridesInSettingsLayers({ userSettingsPath: user, workingDir: work, managedPaths: [managed] });
    expect(layers()).toEqual([]);
    writeFileSync(join(work, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'k' } }));
    writeFileSync(join(work, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: '/bin/k' }));
    writeFileSync(managed, '{not json');
    expect(layers()).toEqual([
      `${join(work, '.claude', 'settings.json')}:apiKeyHelper`,
      `${join(work, '.claude', 'settings.local.json')}:ANTHROPIC_API_KEY`,
      `${managed}:<unreadable>`,
    ]);
    writeFileSync(managed, '[]');
    expect(layers()).toContain(`${managed}:<unreadable>`);
    rmSync(managed);
    mkdirSync(managed); // present but not a readable file (EISDIR)
    expect(layers()).toContain(`${managed}:<unreadable>`);
  });

  it('writeFileAtomic0600 refuses a symlinked parent directory', async () => {
    const { symlinkSync, existsSync } = await import('node:fs');
    const { writeFileAtomic0600 } = await import('../src/services/cli-credential-source.js');
    const d = account(null);
    const elsewhere = join(d, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(d, 'claude'));
    expect(() => writeFileAtomic0600(join(d, 'claude', '.credentials.json'), 'secret')).toThrow(/not a real directory/);
    expect(existsSync(join(elsewhere, '.credentials.json'))).toBe(false);
    // Refused BEFORE anything is created through the symlink: with the target
    // unwritable, a late check would surface EACCES from the temp-file open.
    const { chmodSync } = await import('node:fs');
    chmodSync(elsewhere, 0o500);
    try {
      expect(() => writeFileAtomic0600(join(d, 'claude', '.credentials.json'), 'secret')).toThrow(/not a real directory/);
    } finally {
      chmodSync(elsewhere, 0o700);
    }
  });

  it('writeFileAtomic0600 removes its temp file when publishing fails', async () => {
    const { readdirSync } = await import('node:fs');
    const { writeFileAtomic0600 } = await import('../src/services/cli-credential-source.js');
    const d = account(null);
    const dst = join(d, 'target');
    mkdirSync(join(dst, 'occupied'), { recursive: true }); // rename(file → non-empty dir) fails
    expect(() => writeFileAtomic0600(dst, 'secret')).toThrow();
    expect(readdirSync(d).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
});

describe('reconcileClaudeAccountState', () => {
  const setup = async (perBot: unknown, source: string | null) => {
    const { reconcileClaudeAccountState } = await import('../src/services/cli-credential-source.js');
    const src = account(null);
    mkdirSync(join(src, 'claude'), { recursive: true });
    if (source !== null) writeFileSync(join(src, 'claude', '.claude.json'), source);
    const botDir = account(null);
    const state = join(botDir, '.claude.json');
    if (perBot !== undefined) writeFileSync(state, typeof perBot === 'string' ? perBot : JSON.stringify(perBot));
    return { run: () => reconcileClaudeAccountState(state, src), state, src };
  };
  const read = async (p: string) => JSON.parse((await import('node:fs')).readFileSync(p, 'utf-8'));
  const seeded = {
    oauthAccount: { emailAddress: 'shared@a' }, primaryApiKey: 'sk-shared',
    projects: { '/w': { hasTrustDialogAccepted: true } }, mcpServers: { g: {} }, hasCompletedOnboarding: true,
  };

  it('takes oauthAccount from the source state, drops primaryApiKey, keeps everything else', async () => {
    const t = await setup(seeded, JSON.stringify({ oauthAccount: { emailAddress: 'b@b' }, projects: { '/src': {} } }));
    t.run();
    expect(await read(t.state)).toEqual({
      oauthAccount: { emailAddress: 'b@b' },
      projects: { '/w': { hasTrustDialogAccepted: true } }, mcpServers: { g: {} }, hasCompletedOnboarding: true,
    });
    const { lstatSync } = await import('node:fs');
    expect(lstatSync(t.state).mode & 0o777).toBe(0o600);
  });

  it('removes the shared oauthAccount when the source has no state file or no account', async () => {
    const a = await setup(seeded, null);
    a.run();
    expect(await read(a.state)).not.toHaveProperty('oauthAccount');
    expect(await read(a.state)).not.toHaveProperty('primaryApiKey');
    const b = await setup(seeded, JSON.stringify({ projects: {} }));
    b.run();
    expect(await read(b.state)).not.toHaveProperty('oauthAccount');
  });

  it('fails closed on an unusable source state file or per-bot state file', async () => {
    await expect((await setup(seeded, '{bad')).run).toThrow(/not a JSON object/);
    await expect((await setup(seeded, '[1]')).run).toThrow(/not a JSON object/);
    const t = await setup(undefined, null);
    mkdirSync(t.state); // present but not a regular file
    expect(t.run).toThrow(/unreadable/);
    const m = await setup('{broken', null);
    expect(m.run).toThrow(/per-bot Claude state .* not a JSON object/);
    const s1 = await setup(seeded, null);
    mkdirSync(join(s1.src, 'claude', '.claude.json')); // source present but not a file
    expect(s1.run).toThrow(/credential source .* is unreadable/);
    const s2 = await setup(seeded, null);
    const { symlinkSync } = await import('node:fs');
    const other = join(s2.src, 'other.json');
    writeFileSync(other, JSON.stringify({ oauthAccount: { emailAddress: 'x@x' } }));
    symlinkSync(other, join(s2.src, 'claude', '.claude.json')); // leaf symlink refused
    expect(s2.run).toThrow(/credential source .* is unreadable/);
  });

  it('creates the state when absent', async () => {
    const t = await setup(undefined, JSON.stringify({ oauthAccount: { emailAddress: 'b@b' } }));
    t.run();
    expect(await read(t.state)).toEqual({ oauthAccount: { emailAddress: 'b@b' } });
  });

  it('claudeStateAuthOverrides flags an API-key login', async () => {
    const { claudeStateAuthOverrides } = await import('../src/services/cli-credential-source.js');
    const d = account(null);
    const p = join(d, 's.json');
    expect(claudeStateAuthOverrides(p)).toEqual([]);
    writeFileSync(p, JSON.stringify({ primaryApiKey: 'sk' }));
    expect(claudeStateAuthOverrides(p)).toEqual(['primaryApiKey']);
    writeFileSync(p, 'nope');
    expect(claudeStateAuthOverrides(p)).toEqual(['<unreadable>']);
  });
});
