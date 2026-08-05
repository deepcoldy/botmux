/**
 * Unit tests for the mojo config surface — the `/config` + dashboard path.
 *
 * The JWT-redaction case is the one that matters: mojo's config block holds a
 * `jwt`, and every chat-visible rendering (`/config get`, the config card) plus
 * the applyConfigField change log goes through the same formatter. Falling
 * through to the generic `json` branch would JSON.stringify the whole object and
 * post the token into the chat.
 *
 * Run:  pnpm vitest run test/mojo-config-surface.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) { this.opts = opts; }
  }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', () => ({
  resolveAllowedUsersWithMap: async (_appId: string, raw: string[]) => ({
    resolved: raw.filter(v => v.startsWith('ou_')),
    map: new Map<string, string>(),
    entryStatus: new Map<string, 'resolved' | 'transient' | 'definitive'>(),
  }),
}));

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/bot-config-store.js');
  return { registry, store };
}

describe('mojo config surface', () => {
  let configPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-mojo-cfg-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    process.env.SESSION_DATA_DIR = dir;
  });
  afterEach(() => { delete process.env.BOTS_CONFIG; delete process.env.SESSION_DATA_DIR; });

  function writeConfig(entry: Record<string, unknown> = {}) {
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app_default',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      ...entry,
    }], null, 2), 'utf-8');
  }

  /** Mirrors the existing suite's `loaded()`: write bots.json, then register. */
  async function loaded(entry: Record<string, unknown> = {}) {
    writeConfig(entry);
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach((c: any) => registry.registerBot(c));
    return store;
  }

  it('NEVER renders the mojo jwt in chat-visible output', async () => {
    const store = await loaded({
      cliId: 'mojo',
      backendType: 'mojo',
      mojo: { jwt: 'super-secret-token-value', workspaceId: 'ws-visible', cloud: true },
    });
    const snap = store.getConfigSnapshot('app_default');
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    const row = snap.rows.find(r => r.key === 'mojo');
    expect(row).toBeDefined();
    // The token must never appear anywhere in the rendered row.
    expect(row!.value).not.toContain('super-secret-token-value');
    expect(row!.value).toContain('jwt=••••');
    // Non-secret fields stay visible so the row is still useful for debugging.
    expect(row!.value).toContain('workspaceId=ws-visible');
  });

  it('exposes mojo as a settable backendType and config field', async () => {
    const store = await loaded();

    const backend = store.findConfigField('backendType');
    expect(backend?.enumValues).toContain('mojo');

    // Without a `mojo` field spec, `/config set mojo {...}` is rejected outright.
    expect(store.findConfigField('mojo')).toBeDefined();
    expect(store.settableFieldKeys()).toContain('mojo');
  });

  it('rejects every platform-owned launch key inside the mojo block', async () => {
    // Each of these has a top-level bot field that is FROZEN onto the session, so
    // a second copy here would let a live edit override a frozen identity.
    // Rejecting visibly matters — a silent drop reads to the operator as
    // "applied", which is exactly wrong when the wrapper carries auth.
    const store = await loaded();
    const spec = store.findConfigField('mojo');
    expect(spec).toBeDefined();

    for (const key of ['bin', 'cwd', 'model', 'disableCliBypass', 'wrapperCli', 'resumeCliSessionId']) {
      const rejected = store.coerceConfigValue(
        spec!,
        JSON.stringify({ cloud: true, [key]: key === 'disableCliBypass' ? true : 'x' }),
      );
      expect(rejected.ok, `mojo.${key} must be rejected`).toBe(false);
      if (!rejected.ok) expect(rejected.reason).toContain(key);
    }

    // A block with only mojo-specific settings is accepted.
    const accepted = store.coerceConfigValue(
      spec!,
      JSON.stringify({ cloud: true, workspaceId: 'ws-1', idleTimeoutSec: 30 }),
    );
    expect(accepted.ok).toBe(true);
  });

  it('fails bots.json parsing closed on a hand-edited internal key', async () => {
    // The config-command path is not the only entry point: this is what a
    // hand-edited bots.json goes through, and silently stripping there is what
    // review found (parse succeeds, wrapper retained in memory, then dropped).
    writeConfig({ cliId: 'mojo', backendType: 'mojo', mojo: { cloud: true, wrapperCli: 'env X=1 mojo' } });
    const { registry } = await freshModules();
    expect(() => registry.loadBotConfigs()).toThrow(/mojo\.wrapperCli/);
    // The error must point at the field that DOES own it.
    expect(() => registry.loadBotConfigs()).toThrow(/top-level/);
  });

  it('renders an empty / absent mojo block without leaking undefined', async () => {
    const store = await loaded({ cliId: 'mojo', backendType: 'mojo' });
    const snap = store.getConfigSnapshot('app_default');
    if (!snap.ok) throw new Error('snapshot failed');
    expect(snap.rows.find(r => r.key === 'mojo')?.value).toBe('∅');
  });
});
