/** Antigravity account catalogue parsing, adapter wiring and Dashboard fallback behavior. */
import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAntigravityModels } from '../src/adapters/cli/antigravity-models.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { createAntigravityAcpAdapter } from '../src/adapters/cli/antigravity-acp.js';
import { buildModelChoicesResponse, staticModelChoices } from '../src/services/model-catalog.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: vi.fn(),
}));
const execFileMock = vi.mocked(execFile);
const CATALOG = 'Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n';

/** Simulate CLI completion without launching a native CLI or model request. */
function complete(stdout: string, error: Error | null = null): void {
  execFileMock.mockImplementation(((...args: unknown[]) => {
    const callback = args.find((arg): arg is (...values: unknown[]) => void => typeof arg === 'function')!;
    if (callback) callback(error, { stdout, stderr: '' });
    else return error ? Promise.reject(error) : Promise.resolve({ stdout, stderr: '' });
  }) as typeof execFile);
}

beforeEach(() => execFileMock.mockReset());
afterEach(() => vi.unstubAllEnvs());

describe('Antigravity model discovery', () => {
  it('parses model IDs in order, removes duplicates and ignores progress or malformed rows', () => {
    expect(parseAntigravityModels(CATALOG + [
      'gemini-4-argon-high\tDuplicate', 'invalid model\tLabel', '\tMissing ID',
      'no-label\t', 'error: authentication required', 'three\tcolumns\tbad', '',
    ].join('\r\n'))).toEqual(['gemini-4-argon-high', 'claude-opus-5-5-high']);
    expect(parseAntigravityModels('Fetching available models...\n')).toEqual([]);
  });

  for (const transport of ['terminal', 'acp'] as const) {
    it(`${transport} probes the configured native executable with the effective environment`, async () => {
      complete(CATALOG);
      const adapter = transport === 'terminal'
        ? createCliAdapterSync('antigravity', process.execPath)
        : createAntigravityAcpAdapter(process.execPath);
      const env = Object.freeze({ HOME: '/test-only-account', PATH: '/test-only-bin', AGY_CLI_DISABLE_AUTO_UPDATE: 'false' });
      await expect(adapter.detectModels?.({ env }))
        .resolves.toEqual(['gemini-4-argon-high', 'claude-opus-5-5-high']);
      expect(execFileMock.mock.calls[0]?.slice(0, 3)).toEqual([
        process.execPath, ['models'], expect.objectContaining({
          env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, timeout: expect.any(Number), maxBuffer: expect.any(Number), windowsHide: true,
        }),
      ]);
    });

    it(`${transport} preserves the inherited environment and disables probe updates`, async () => {
      complete(CATALOG);
      vi.stubEnv('AGY_CLI_DISABLE_AUTO_UPDATE', 'false');
      vi.stubEnv('BOTMUX_TEST_MODEL_PROBE', 'inherited');
      const adapter = transport === 'terminal'
        ? createCliAdapterSync('antigravity', process.execPath)
        : createAntigravityAcpAdapter(process.execPath);
      await expect(adapter.detectModels?.())
        .resolves.toEqual(['gemini-4-argon-high', 'claude-opus-5-5-high']);
      expect(execFileMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
        env: expect.objectContaining({
          BOTMUX_TEST_MODEL_PROBE: 'inherited',
          AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
        }),
      }));
      expect(process.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('false');
    });
  }

  it('Dashboard uses live IDs exclusively and reuses successful probes within the existing cache', async () => {
    complete(CATALOG);
    const opts = { runtimeContext: 'agy-models-live-test',
      adapterFactory: () => createCliAdapterSync('antigravity', process.execPath) };
    const first = await buildModelChoicesResponse('antigravity', opts);
    expect(first.source).toBe('live');
    expect(first.models).toEqual(['gemini-4-argon-high', 'claude-opus-5-5-high']);
    expect((await buildModelChoicesResponse('antigravity', opts)).models).toEqual(first.models);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('failed or empty probes fall back to static candidates and retry on the next request', async () => {
    const opts = { runtimeContext: 'agy-models-retry-test',
      adapterFactory: () => createCliAdapterSync('antigravity', process.execPath) };
    for (const error of [new Error('unsupported command / timeout / login failed'), null]) {
      complete('Fetching available models...\n', error);
      const result = await buildModelChoicesResponse('antigravity', opts);
      expect(result.source).toBe('static');
      expect(result.models).toEqual(staticModelChoices('antigravity'));
    }
    complete(CATALOG);
    expect((await buildModelChoicesResponse('antigravity', opts)).source).toBe('live');
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });
});
