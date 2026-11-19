import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createPluginMarket, normalizePluginMarket, verifyPluginArchive,
  type MarketInstalledPlugin, type PluginInstallPlan, type PluginMarketDependencies,
} from '../src/dashboard/plugin-market.js';
import { pluginRecordHash } from '../src/core/plugins/mutation-guard.js';

const entry = {
  id: 'sample', package: '@test/plugin-sample', displayName: 'Sample',
  description: 'An example', repo: 'https://example.com/sample',
  categories: ['mcp'], compatibility: { botmux: '>=3.56.0' },
};
const bytes = Buffer.from('verified plugin archive');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const manifest = {
  name: entry.package, version: '1.2.3', keywords: ['botmux-plugin'],
  botmux: { schemaVersion: 1, id: entry.id, displayName: entry.displayName },
};
function fixture(overrides: Partial<PluginMarketDependencies> = {}) {
  const installed = new Map<string, MarketInstalledPlugin>();
  let clock = 1000;
  let enabled = false;
  let stopped = true;
  let revision = 0;
  const deps: PluginMarketDependencies = {
    fetchCatalog: vi.fn(async () => ({ schemaVersion: 1, plugins: [entry] })),
    metadata: vi.fn(async () => ({ version: '1.2.3', integrity })),
    now: () => clock,
    revision: () => String(revision),
    installed: id => installed.get(id),
    isEnabled: () => enabled,
    assertStopped: () => { if (!stopped) throw new Error('service is running'); },
    install: vi.fn(async plan => { installed.set(plan.id, plan); revision++; }),
    uninstall: vi.fn(async guard => { installed.delete(guard.id); revision++; }),
    ...overrides,
  };
  return {
    market: createPluginMarket(deps), deps, installed,
    advance: (ms: number) => { clock += ms; },
    enable: (value: boolean) => { enabled = value; },
    stop: (value: boolean) => { stopped = value; },
  };
}

describe('native plugin market', () => {
  it('rejects malformed catalog entries, duplicate ids and executable links', () => {
    expect(() => normalizePluginMarket({ schemaVersion: 1, plugins: [entry, entry] })).toThrow();
    for (const bad of [{ package: '--script' }, { docs: 'javascript:alert(1)' }, { id: '../escape' }]) {
      expect(() => normalizePluginMarket({ schemaVersion: 1, plugins: [{ ...entry, ...bad }] })).toThrow();
    }
  });
  it('deduplicates loads and retains a last-known catalog on failure', async () => {
    const f = fixture();
    await Promise.all([f.market.catalog(), f.market.catalog()]);
    expect(f.deps.fetchCatalog).toHaveBeenCalledTimes(1);
    vi.mocked(f.deps.fetchCatalog).mockRejectedValue(new Error('offline'));
    expect(await f.market.catalog(true)).toMatchObject({ items: [entry], stale: true, available: true });
  });
  it('degrades to an unavailable empty catalog when there is no cache', async () => {
    const f = fixture({ fetchCatalog: async () => { throw new Error('offline'); } });
    expect(await f.market.catalog()).toEqual({ items: [], stale: true, available: false });
  });
  it('installs a fixed version only after explicit confirmation by its original principal', async () => {
    const f = fixture();
    const plan = await f.market.prepare('sample', 'owner-A');
    expect(plan).not.toHaveProperty('principal');
    await expect(f.market.install(plan.nonce, true, 'owner-B')).rejects.toThrow();
    await expect(f.market.install(plan.nonce, false, 'owner-A')).rejects.toThrow();
    expect(f.deps.install).not.toHaveBeenCalled();
    expect(await f.market.install(plan.nonce, true, 'owner-A')).toEqual({ id: 'sample', version: '1.2.3' });
    await expect(f.market.install(plan.nonce, true, 'owner-A')).rejects.toThrow();
    expect(f.deps.install).toHaveBeenCalledTimes(1);
  });
  it('expires pending confirmation without starting an install', async () => {
    const f = fixture();
    const plan = await f.market.prepare('sample', 'owner');
    f.advance(300_001);
    await expect(f.market.install(plan.nonce, true, 'owner')).rejects.toThrow();
    expect(f.deps.install).not.toHaveBeenCalled();
  });
  it('refuses id collisions at both preparation and confirmation', async () => {
    const f = fixture();
    const plan = await f.market.prepare('sample', 'owner');
    f.installed.set('sample', { id: 'sample', packageName: '@other/sample', version: '1.0.0' });
    await expect(f.market.prepare('sample', 'owner')).rejects.toThrow();
    await expect(f.market.install(plan.nonce, true, 'owner')).rejects.toThrow();
    expect(f.deps.install).not.toHaveBeenCalled();
  });
  it('rechecks service state when a human starts it after preparation', async () => {
    const f = fixture();
    const plan = await f.market.prepare('sample', 'owner');
    f.stop(false);
    await expect(f.market.install(plan.nonce, true, 'owner')).rejects.toThrow();
    expect(f.deps.install).not.toHaveBeenCalled();
  });
  it('serializes long operations and prevents replay during a pending install', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture();
    vi.mocked(f.deps.install).mockImplementation(async plan => { await gate; f.installed.set(plan.id, plan); });
    const a = await f.market.prepare('sample', 'owner');
    const b = await f.market.prepare('sample', 'owner');
    const running = f.market.install(a.nonce, true, 'owner');
    await expect(f.market.install(b.nonce, true, 'owner')).rejects.toThrow();
    await expect(f.market.install(a.nonce, true, 'owner')).rejects.toThrow();
    release();
    await running;
    expect(f.deps.install).toHaveBeenCalledTimes(1);
  });
  it('releases the operation guard after partial failure but never reuses a nonce', async () => {
    const f = fixture();
    vi.mocked(f.deps.install).mockRejectedValueOnce(new Error('download failed'));
    const first = await f.market.prepare('sample', 'owner');
    await expect(f.market.install(first.nonce, true, 'owner')).rejects.toThrow();
    await expect(f.market.install(first.nonce, true, 'owner')).rejects.toThrow();
    const next = await f.market.prepare('sample', 'owner');
    await expect(f.market.install(next.nonce, true, 'owner')).resolves.toHaveProperty('id', 'sample');
  });
  it('does not claim successful installation when registry readback is missing', async () => {
    const f = fixture({ install: async () => {} });
    const plan = await f.market.prepare('sample', 'owner');
    await expect(f.market.install(plan.nonce, true, 'owner')).rejects.toThrow();
  });
  it('protects active scopes, running services and changed versions during uninstall', async () => {
    const f = fixture();
    f.installed.set('sample', { id: 'sample', packageName: entry.package, version: '1.2.3' });
    const request = { id: 'sample', packageName: entry.package, version: '1.2.3', expectedState: pluginRecordHash(f.installed.get('sample')), confirm: true };
    f.enable(true);
    await expect(f.market.uninstall(request)).rejects.toThrow();
    f.enable(false); f.stop(false);
    await expect(f.market.uninstall(request)).rejects.toThrow();
    f.stop(true);
    await expect(f.market.uninstall({ ...request, version: '0.1.0' })).rejects.toThrow();
    expect(f.deps.uninstall).not.toHaveBeenCalled();
    await f.market.uninstall(request);
    expect(f.installed.size).toBe(0);
  });
  it('rejects missing confirmation or unknown plugins for uninstall', async () => {
    const f = fixture();
    await expect(f.market.uninstall({ id: 'sample', version: '1.2.3' })).rejects.toThrow();
    await expect(f.market.uninstall({ id: 'sample', version: '1.2.3', confirm: true })).rejects.toThrow();
    expect(f.deps.uninstall).not.toHaveBeenCalled();
  });
  it('validates exact archive integrity and all package identities before invoking the installer', () => {
    const plan: PluginInstallPlan = { nonce: 'nonce', id: 'sample', packageName: entry.package, version: '1.2.3', integrity, expiresAt: 9999, expectedState: null, expectedRevision: '0'.repeat(64) };
    expect(() => verifyPluginArchive(bytes, manifest, plan)).not.toThrow();
    expect(() => verifyPluginArchive(Buffer.from('tampered'), manifest, plan)).toThrow();
    expect(() => verifyPluginArchive(bytes, { ...manifest, name: '@other/name' }, plan)).toThrow();
    expect(() => verifyPluginArchive(bytes, { ...manifest, version: '2.0.0' }, plan)).toThrow();
    expect(() => verifyPluginArchive(bytes, { ...manifest, botmux: { ...manifest.botmux, id: 'other' } }, plan)).toThrow();
  });
});
