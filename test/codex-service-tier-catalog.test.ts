import { execFile } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkCodexServiceTierSupport,
  clearCodexServiceTierCatalogCache,
  loadCodexServiceTierCatalog,
} from '../src/services/codex-service-tier-catalog.js';

const { CODEX_SERVICE_TIER_CATALOG_TTL_MS } = await import('../src/services/codex-service-tier-catalog.js');

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const execFileMock = vi.mocked(execFile);
const CATALOG = JSON.stringify({
  models: [{ slug: 'gpt-6.1-sol', visibility: 'list', service_tiers: [{ id: 'priority' }] }],
});

function succeed(stdout = CATALOG): void {
  execFileMock.mockImplementation(((...args: unknown[]) => {
    const callback = args.find((arg): arg is (...cbArgs: unknown[]) => void => typeof arg === 'function')!;
    callback(null, { stdout, stderr: '' });
  }) as typeof execFile);
}

describe('codex service tier catalog', () => {
  beforeEach(() => {
    clearCodexServiceTierCatalogCache();
    execFileMock.mockReset();
  });

  it('executes debug models with bounded output and caches only successful catalogs', async () => {
    succeed();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const env = { PATH: '/codex-bin' };
    const first = await loadCodexServiceTierCatalog({ cliBin: '/codex', env });
    const second = await loadCodexServiceTierCatalog({ cliBin: '/codex', env });
    expect(first).toEqual([{ slug: 'gpt-6.1-sol', serviceTiers: ['priority'] }]);
    expect(second).toBe(first);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.slice(0, 3)).toEqual(['/codex', ['debug', 'models'], {
      env,
      timeout: 8_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }]);
    const rerun = await loadCodexServiceTierCatalog({
      cliBin: '/codex',
      env: { ...env, BOTMUX_SESSION_ID: 'session-2' },
    });
    expect(rerun).toBe(first);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000 + CODEX_SERVICE_TIER_CATALOG_TTL_MS);
    await loadCodexServiceTierCatalog({ cliBin: '/codex', env });
    expect(execFileMock).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('separates caches by environment and fail-softs probe failures', async () => {
    succeed();
    await loadCodexServiceTierCatalog({ cliBin: '/codex', env: { PATH: '/a' } });
    execFileMock.mockImplementation(((...args: unknown[]) => {
      const callback = args.find((arg): arg is (...cbArgs: unknown[]) => void => typeof arg === 'function')!;
      callback(new Error('offline'));
    }) as typeof execFile);
    expect(await loadCodexServiceTierCatalog({ cliBin: '/codex', env: { PATH: '/b' } })).toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('requires proof for accelerated tiers but not default', () => {
    const catalog = [{ slug: 'gpt-6.1-sol', serviceTiers: ['priority'] }];
    expect(checkCodexServiceTierSupport(catalog, undefined, 'default')).toEqual({ ok: true });
    expect(checkCodexServiceTierSupport(catalog, undefined, 'priority')).toEqual({ ok: false, error: 'model_required' });
    expect(checkCodexServiceTierSupport(null, 'gpt-6.1-sol', 'priority')).toEqual({ ok: false, error: 'catalog_unavailable' });
    expect(checkCodexServiceTierSupport(catalog, 'gpt-6.1-sol', 'priority')).toEqual({ ok: true });
    expect(checkCodexServiceTierSupport(catalog, 'GPT-6.1-Sol', 'priority')).toEqual({ ok: true });
    expect(checkCodexServiceTierSupport(catalog, 'gpt-6.1-sol', 'ultrafast')).toEqual({ ok: false, error: 'not_supported_by_model' });
  });
});
