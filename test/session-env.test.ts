/**
 * Session environment overlay (core/session-env.ts): the layer order
 * inherited → global → bot → botmux reserved, the single lock rule
 * (per-bot-env.ts sessionEnvLock), write-path validation and masking.
 */
import { describe, expect, it } from 'vitest';
import { sessionEnvLock } from '../src/core/per-bot-env.js';
import {
  applyEnvOps,
  applySessionEnvUnset,
  buildSessionEnvRows,
  composeSessionEnv,
  emptyEnvLayer,
  envLayerArgvBytes,
  envLayerWithinBudget,
  globalEnvLayer,
  maskEnvValue,
  MAX_SESSION_ENV_LAYER_BYTES,
  normalizeEnvLayer,
  parseEnvOps,
  sessionChildEnvWithInject,
  sessionEnvRowRawValue,
  sessionEnvUnsetFlags,
  type EnvLayer,
} from '../src/core/session-env.js';

const layer = (set: Record<string, string> = {}, unset: string[] = []): EnvLayer => ({ set, unset });

describe('composeSessionEnv: inherited → global → bot', () => {
  it('a bot entry replaces the global entry for the same name, in both directions', () => {
    const global = layer({ HTTPS_PROXY: 'http://global', ANTHROPIC_BASE_URL: 'https://g' }, ['BYTECLOUD_AUTH_AS', 'NODE_OPTIONS']);
    const bot = layer({ BYTECLOUD_AUTH_AS: 'user', HTTPS_PROXY: 'http://bot' }, ['ANTHROPIC_BASE_URL']);
    expect(composeSessionEnv([global, bot])).toEqual({
      // bot set beats global set; bot set beats global unset
      set: { BYTECLOUD_AUTH_AS: 'user', HTTPS_PROXY: 'http://bot' },
      // bot unset beats global set; untouched global unset survives
      unset: ['ANTHROPIC_BASE_URL', 'NODE_OPTIONS'],
    });
  });

  it('removing the bot entry ("restore") falls back to the global entry', () => {
    const global = layer({ HTTPS_PROXY: 'http://global' }, ['BYTECLOUD_AUTH_AS']);
    const bot = applyEnvOps(layer({ HTTPS_PROXY: 'http://bot' }, ['X']), [{ op: 'reset', key: 'HTTPS_PROXY' }]);
    expect(composeSessionEnv([global, bot])).toEqual({ set: { HTTPS_PROXY: 'http://global' }, unset: ['BYTECLOUD_AUTH_AS', 'X'] });
  });

  it('botmux-reserved names never come out of any layer, whatever was stored', () => {
    const out = composeSessionEnv([
      layer({ BOTMUX_SESSION_ID: 'evil', TMPDIR: '/tmp', OK: '1' }, ['SESSION_DATA_DIR', 'LARK_APP_ID']),
    ]);
    expect(out).toEqual({ set: { OK: '1' }, unset: [] });
  });

  it('PATH/HOME may be overridden but never removed', () => {
    expect(composeSessionEnv([layer({ PATH: '/opt/bin' }, ['HOME'])])).toEqual({ set: { PATH: '/opt/bin' }, unset: [] });
  });

  it('identity-wrapper names are locked only while that wrapper is on (A1)', () => {
    const l = layer({ ZDOTDIR: '/z', GIT_ASKPASS: '/a', GIT_CONFIG_COUNT: '1' }, ['BASH_ENV']);
    expect(composeSessionEnv([l], {})).toEqual({ set: { ZDOTDIR: '/z', GIT_ASKPASS: '/a', GIT_CONFIG_COUNT: '1' }, unset: ['BASH_ENV'] });
    // lark tool binding owns only the login-shell shim
    expect(composeSessionEnv([l], { identityShell: true })).toEqual({ set: { GIT_ASKPASS: '/a', GIT_CONFIG_COUNT: '1' }, unset: [] });
    // trigger-user auth also owns the git attribution
    expect(composeSessionEnv([l], { identityShell: true, identityGit: true })).toEqual({ set: {}, unset: [] });
  });
});

describe('the lock rule is one function', () => {
  it('classifies reserved / identity / no-unset / free', () => {
    expect(sessionEnvLock('BOTMUX_CHAT_ID')).toBe('reserved');
    expect(sessionEnvLock('LARK_APP_SECRET')).toBe('reserved');
    expect(sessionEnvLock('TMPDIR')).toBe('reserved');
    expect(sessionEnvLock('ZDOTDIR')).toBeNull();
    expect(sessionEnvLock('ZDOTDIR', { identityShell: true })).toBe('identity');
    expect(sessionEnvLock('GIT_CONFIG_KEY_0', { identityShell: true })).toBeNull();
    expect(sessionEnvLock('GIT_CONFIG_KEY_0', { identityGit: true })).toBe('identity');
    expect(sessionEnvLock('PATH')).toBe('no-unset');
    expect(sessionEnvLock('BYTECLOUD_AUTH_AS')).toBeNull();
  });
});

describe('parseEnvOps (write path)', () => {
  it('accepts set / unset / reset and keeps their order', () => {
    expect(parseEnvOps([
      { op: 'set', key: 'A', value: 'x y' },
      { op: 'unset', key: 'B' },
      { op: 'reset', key: 'C' },
    ])).toEqual({ ok: true, ops: [{ op: 'set', key: 'A', value: 'x y' }, { op: 'unset', key: 'B' }, { op: 'reset', key: 'C' }] });
  });

  it('rejects reserved names for set AND unset', () => {
    expect(parseEnvOps([{ op: 'set', key: 'BOTMUX_SESSION_ID', value: 'x' }])).toEqual({ ok: false, error: 'reserved_key', key: 'BOTMUX_SESSION_ID' });
    expect(parseEnvOps([{ op: 'unset', key: 'SESSION_DATA_DIR' }])).toEqual({ ok: false, error: 'reserved_key', key: 'SESSION_DATA_DIR' });
  });

  it('rejects identity names only with the wrapper on', () => {
    expect(parseEnvOps([{ op: 'set', key: 'ZDOTDIR', value: '/z' }]).ok).toBe(true);
    expect(parseEnvOps([{ op: 'set', key: 'ZDOTDIR', value: '/z' }], { identityShell: true })).toEqual({ ok: false, error: 'reserved_key', key: 'ZDOTDIR' });
  });

  it('rejects removing PATH/HOME but allows overriding them', () => {
    expect(parseEnvOps([{ op: 'unset', key: 'PATH' }])).toEqual({ ok: false, error: 'unset_forbidden', key: 'PATH' });
    expect(parseEnvOps([{ op: 'set', key: 'HOME', value: '/h' }]).ok).toBe(true);
  });

  it('caps name length (every name lands in the pane argv)', () => {
    const long = `A${'B'.repeat(256)}`;
    expect(parseEnvOps([{ op: 'unset', key: long }])).toEqual({ ok: false, error: 'invalid_key' });
    expect(parseEnvOps([{ op: 'unset', key: long.slice(0, 256) }]).ok).toBe(true);
    expect(normalizeEnvLayer({}, [long, 'OK']).unset).toEqual(['OK']);
    expect(sessionEnvUnsetFlags([long, 'OK'])).toEqual(['-u', 'OK']);
  });

  it('never echoes an invalid name (it may be a pasted secret)', () => {
    expect(parseEnvOps([{ op: 'set', key: 'sk-secret value', value: 'x' }])).toEqual({ ok: false, error: 'invalid_key' });
  });

  it('rejects NUL in values, non-arrays and unknown ops', () => {
    expect(parseEnvOps([{ op: 'set', key: 'A', value: 'a\0b' }])).toEqual({ ok: false, error: 'invalid_value', key: 'A' });
    expect(parseEnvOps({ op: 'set' })).toEqual({ ok: false, error: 'invalid_ops' });
    expect(parseEnvOps([{ op: 'delete', key: 'A' }])).toEqual({ ok: false, error: 'invalid_ops' });
  });
});

describe('layer byte budget (pane argv)', () => {
  it('counts KEY=VAL and -u KEY the way they land in argv', () => {
    expect(envLayerArgvBytes(layer({ AB: 'xyz' }, ['CD']))).toBe('AB=xyz'.length + 1 + 3 + 'CD'.length + 1);
    expect(envLayerArgvBytes(layer({ A: '中' }))).toBe(2 + 3 + 1);
  });

  it('refuses to grow past the budget but always lets an oversized layer shrink', () => {
    const big = layer({ A: 'x'.repeat(MAX_SESSION_ENV_LAYER_BYTES) });
    expect(envLayerWithinBudget(emptyEnvLayer(), layer({ A: 'x'.repeat(2000) }))).toBe(true);
    expect(envLayerWithinBudget(layer({ A: 'x'.repeat(2000) }), layer({ A: 'x'.repeat(2000), B: 'y'.repeat(2500) }))).toBe(false);
    expect(envLayerWithinBudget(big, applyEnvOps(big, [{ op: 'unset', key: 'C' }]))).toBe(false);
    expect(envLayerWithinBudget(big, applyEnvOps(big, [{ op: 'set', key: 'A', value: 'x'.repeat(3000) }]))).toBe(true);
    expect(envLayerWithinBudget(big, applyEnvOps(big, [{ op: 'reset', key: 'A' }]))).toBe(true);
    // still over budget after the edit, but smaller than before → allowed
    const legacy = layer({ A: 'x'.repeat(MAX_SESSION_ENV_LAYER_BYTES), B: 'y'.repeat(2000) });
    expect(envLayerWithinBudget(legacy, applyEnvOps(legacy, [{ op: 'reset', key: 'B' }]))).toBe(true);
  });

  it('caps one value at the layer budget in UTF-8 bytes, not characters', () => {
    expect(parseEnvOps([{ op: 'set', key: 'A', value: 'x'.repeat(MAX_SESSION_ENV_LAYER_BYTES + 1) }]))
      .toEqual({ ok: false, error: 'invalid_value', key: 'A' });
    // 4000 ASCII chars = 4000 bytes → accepted; the same CHARACTER count of CJK
    // is 12000 bytes → rejected (pane argv is a byte channel).
    expect(parseEnvOps([{ op: 'set', key: 'A', value: 'x'.repeat(4000) }]).ok).toBe(true);
    expect(parseEnvOps([{ op: 'set', key: 'A', value: '中'.repeat(4000) }]))
      .toEqual({ ok: false, error: 'invalid_value', key: 'A' });
  });
});

describe('stored layers', () => {
  it('a name hand-edited into both lists keeps its set entry (legacy env semantics)', () => {
    expect(normalizeEnvLayer({ A: '1' }, ['A', 'B', 'BOTMUX_X', 'not valid'])).toEqual({ set: { A: '1' }, unset: ['B'] });
  });

  it('applyEnvOps moves a name between set and unset', () => {
    const l1 = applyEnvOps(emptyEnvLayer(), [{ op: 'set', key: 'A', value: '1' }, { op: 'unset', key: 'B' }]);
    expect(l1).toEqual({ set: { A: '1' }, unset: ['B'] });
    expect(applyEnvOps(l1, [{ op: 'unset', key: 'A' }, { op: 'set', key: 'B', value: '2' }])).toEqual({ set: { B: '2' }, unset: ['A'] });
  });

  it('globalEnvLayer tolerates junk', () => {
    expect(globalEnvLayer(undefined)).toEqual(emptyEnvLayer());
    expect(globalEnvLayer({ set: 'x', unset: 7 })).toEqual(emptyEnvLayer());
  });
});

describe('applying removals', () => {
  it('deletes only removable names', () => {
    const env: NodeJS.ProcessEnv = { A: '1', PATH: '/bin', BOTMUX_SESSION_ID: 's', KEEP: 'k' };
    applySessionEnvUnset(env, ['A', 'PATH', 'BOTMUX_SESSION_ID']);
    expect(env).toEqual({ PATH: '/bin', BOTMUX_SESSION_ID: 's', KEEP: 'k' });
  });

  it('env(1) flags carry the same filter', () => {
    expect(sessionEnvUnsetFlags(['A', 'HOME', 'BOTMUX', 'B'])).toEqual(['-u', 'A', '-u', 'B']);
    expect(sessionEnvUnsetFlags(undefined)).toEqual([]);
  });

  it('a local child: removals first, then the set values', () => {
    expect(sessionChildEnvWithInject({ env: { A: '1', B: '2' }, injectEnv: { C: '3' }, unsetEnv: ['A'] })).toEqual({ B: '2', C: '3' });
  });
});

describe('masking', () => {
  const masked = (key: string, value: string) => maskEnvValue(key, value).masked;

  it('masks credential-like names', () => {
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'SSH_KEY_PATH', 'NGROK_AUTHTOKEN',
      'DB_PASSWORD', 'BYTECLOUD_AUTH_JWT', 'MY_CLIENT_SECRET', 'SSH_PRIVATE_KEY', 'FOO_AK', 'FOO_SK', 'COOKIE']) {
      expect(masked(key, 'abcdefghijklmnop'), key).toBe(true);
    }
  });

  it('leaves ordinary names readable', () => {
    for (const key of ['PATH', 'LANG', 'HTTPS_PROXY', 'PWD', 'OLDPWD', 'ANTHROPIC_BASE_URL', 'GIT_AUTHOR_NAME', 'KEYBOARD_LAYOUT']) {
      expect(masked(key, 'abcdefghijklmnop'), key).toBe(false);
    }
  });

  it('shows only the last four characters of a long secret, none of a short one', () => {
    expect(maskEnvValue('X_TOKEN', 'sk-0123456789abcd')).toEqual({ value: '••••••abcd', masked: true });
    expect(maskEnvValue('X_TOKEN', 'short')).toEqual({ value: '••••••', masked: true });
  });

  it('masks only the password of a credential-bearing URL', () => {
    expect(maskEnvValue('HTTPS_PROXY', 'http://user:hunter2@proxy:8080')).toEqual({ value: 'http://user:••••••@proxy:8080', masked: true });
  });

  it('masks a JWT-shaped value under any name', () => {
    expect(masked('SOMETHING', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJl')).toBe(true);
  });

  it('maskAll hides every non-empty value', () => {
    expect(maskEnvValue('LANG', 'en_US.UTF-8', { maskAll: true })).toEqual({ value: '••••••', masked: true });
    expect(maskEnvValue('HTTPS_PROXY', 'http://u:p@h', { maskAll: true })).toEqual({ value: '••••••', masked: true });
    expect(maskEnvValue('LANG', '', { maskAll: true })).toEqual({ value: '', masked: false });
  });
});

describe('editing rows', () => {
  const mask = (key: string, value: string) => maskEnvValue(key, value);
  const baseline = { LANG: 'C', HTTPS_PROXY: 'http://host', ANTHROPIC_AUTH_TOKEN: 'sk-host-0000000000', PATH: '/bin', TMPDIR: '/tmp' };

  it('labels each row with the layer that decided it and what it replaced', () => {
    const rows = buildSessionEnvRows({
      baseline,
      layers: [
        { source: 'global', layer: layer({ HTTPS_PROXY: 'http://global' }, ['LANG']) },
        { source: 'bot', layer: layer({ ANTHROPIC_AUTH_TOKEN: 'sk-bot-1111111111' }, ['HTTPS_PROXY']) },
      ],
      mask,
    });
    const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
    expect(byKey.LANG).toMatchObject({ state: 'unset', source: 'global', value: 'C' });
    expect(byKey.LANG.entry).toBeUndefined();   // the bot scope has no entry for it
    expect(byKey.HTTPS_PROXY).toMatchObject({ state: 'unset', source: 'bot', entry: 'unset', value: 'http://global',
      lower: { source: 'global', state: 'set', value: 'http://global' } });
    expect(byKey.ANTHROPIC_AUTH_TOKEN).toMatchObject({ state: 'set', source: 'bot', entry: 'set', masked: true,
      lower: { source: 'host', state: 'inherited', masked: true } });
    expect(byKey.PATH).toMatchObject({ state: 'inherited', source: 'host', lock: 'no-unset' });
    // reserved names are listed separately, never as editable rows
    expect(byKey.TMPDIR).toBeUndefined();
  });

  it('never puts a masked original into the rows', () => {
    const rows = buildSessionEnvRows({
      baseline,
      layers: [{ source: 'bot', layer: layer({ OPENAI_API_KEY: 'sk-bot-secret-sentinel' }) }],
      mask,
    });
    const json = JSON.stringify(rows);
    expect(json).not.toContain('sk-bot-secret-sentinel');
    expect(json).not.toContain('sk-host-0000000000');
  });

  it('reveal returns the value behind the row (effective, or the one being removed)', () => {
    const layers = [{ layer: layer({ HTTPS_PROXY: 'http://global' }) }, { layer: layer({}, ['HTTPS_PROXY', 'LANG']) }];
    expect(sessionEnvRowRawValue({ key: 'HTTPS_PROXY', baseline, layers })).toBe('http://global');
    expect(sessionEnvRowRawValue({ key: 'LANG', baseline, layers })).toBe('C');
    expect(sessionEnvRowRawValue({ key: 'TMPDIR', baseline, layers })).toBeUndefined();
  });
});
