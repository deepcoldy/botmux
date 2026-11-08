import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPiAdapter } from '../src/adapters/cli/pi.js';
import { createModelCatalog, buildModelChoicesResponse } from '../src/services/model-catalog.js';
import { modelCatalogProbeContext } from '../src/dashboard/model-catalog-request.js';
import type { BotConfig } from '../src/bot-registry.js';

const { processProbe } = vi.hoisted(() => ({ processProbe: vi.fn(() => { throw new Error('Model discovery must not execute commands'); }) }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: processProbe, spawnSync: processProbe, exec: processProbe,
  execSync: processProbe, execFile: processProbe, execFileSync: processProbe,
}));

const roots: string[] = [];
const bin = join(tmpdir(), 'not-installed-review-pi');
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'pi-local-models-'));
  roots.push(path);
  return path;
}
function models(directory: string, provider: string, id = 'shared'): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'models.json'), JSON.stringify({ providers: { [provider]: { models: [{ id }] } } }));
}
const adapter = createPiAdapter(bin);
beforeEach(() => { processProbe.mockClear(); });
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.unstubAllEnvs();
  expect(processProbe).not.toHaveBeenCalled();
});

describe('Pi explicit local model discovery', () => {
  it('keeps provider-qualified nested ids, deduplicates full ids and skips malformed entries', async () => {
    const dir = root();
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: {
      alpha: { models: [{ id: 'shared' }, { id: 'vendor/model' }, { id: 'shared' }, { id: 'qwen:7b' },
        null, { id: 1 }, { id: '' }, { id: 'bad model' }, { id: 'image', type: 'image' }] },
      beta: { models: [{ id: 'shared' }] }, invalid: null, 'bad/provider': { models: [{ id: 'skip' }] },
    } }));
    expect(await adapter.detectModels!({ env: { PI_CODING_AGENT_DIR: dir } }))
      .toEqual(['alpha/shared', 'alpha/vendor/model', 'alpha/qwen:7b', 'beta/shared']);
  });

  it('reads target HOME and explicit/tilde agent directories instead of ambient configuration', async () => {
    const home = root(), overlay = root(), ambient = root();
    models(join(home, '.pi', 'agent'), 'home'); models(overlay, 'overlay'); models(ambient, 'ambient');
    vi.stubEnv('PI_CODING_AGENT_DIR', ambient);
    expect(await adapter.detectModels!({ env: { HOME: home } })).toEqual(['home/shared']);
    expect(await adapter.detectModels!({ env: { HOME: home, PI_CODING_AGENT_DIR: '~/.pi/agent' } })).toEqual(['home/shared']);
    expect(await adapter.detectModels!({ env: { HOME: home, PI_CODING_AGENT_DIR: overlay } })).toEqual(['overlay/shared']);
    expect(await adapter.detectModels!()).toEqual(['ambient/shared']);
  });

  it('accepts Pi line comments, BOM and trailing commas without touching strings or credentials', async () => {
    const dir = root(), marker = join(dir, 'helper-ran');
    const id = 'vendor/escaped-"-\\-//-,}';
    const source = '\uFEFF' + `{
      // local custom endpoint
      "providers": { "custom": {
        "baseUrl": "https://example.invalid/a//b", "apiKey": "!touch ${marker}",
        "headers": { "Authorization": "private-header" },
        "models": [{ "id": ${JSON.stringify(id)}, },],
      }, },
    }`;
    writeFileSync(join(dir, 'models.json'), source);
    expect(await adapter.detectModels!({ env: { PI_CODING_AGENT_DIR: dir } })).toEqual([`custom/${id}`]);
    expect(readFileSync(join(dir, 'models.json'), 'utf8')).toBe(source);
  });

  it.each([undefined, '', '{broken', 'null', '[]', '{"providers":{}}',
    '{"providers":{"alpha":{"models":[,]}}}', '{"providers":{"alpha":{"models":[{"id":"x"},,]}}}',
    '{"providers":{/* block comment */"alpha":{"models":[{"id":"x"}]}}}',
    '{"providers":{"alpha":{"models":[{"id":1 2}]}}}'])
  ('fails soft for missing/empty/malformed metadata (%s)', async text => {
    const dir = root();
    if (text !== undefined) writeFileSync(join(dir, 'models.json'), text);
    expect(await adapter.detectModels!({ env: { PI_CODING_AGENT_DIR: dir } })).toBeNull();
  });

  it('does not invent built-in models from auth or environment variables', async () => {
    const dir = root();
    writeFileSync(join(dir, 'auth.json'), '{"openai":{"type":"oauth","access":"private-token"}}');
    expect(await adapter.detectModels!({ env: { PI_CODING_AGENT_DIR: dir, OPENAI_API_KEY: 'private-key' } })).toBeNull();
  });

  it('rejects a directory in place of models.json', async () => {
    const dir = root(); mkdirSync(join(dir, 'models.json'));
    expect(await adapter.detectModels!({ env: { PI_CODING_AGENT_DIR: dir } })).toBeNull();
  });

  it('feeds Bot-specific discovery through the existing model service and separates environment caches', async () => {
    const first = root(), second = root(); models(first, 'first'); models(second, 'second');
    const bot = { larkAppId: `pi-local-${first}`, cliId: 'pi', cliPathOverride: bin,
      env: { PI_CODING_AGENT_DIR: first } } as BotConfig;
    const probe = modelCatalogProbeContext('pi', bot, { HOME: root() });
    const response = await buildModelChoicesResponse('pi', probe);
    expect(response.models).toEqual(['first/shared']);
    expect(response.source).toBe('live');
    expect(JSON.stringify(response)).not.toContain(first);
    const catalog = createModelCatalog();
    const options = { runtimeExecutable: bin };
    vi.stubEnv('PI_CODING_AGENT_DIR', first);
    expect(await catalog.detectModels('pi', options)).toEqual(['first/shared']);
    vi.stubEnv('PI_CODING_AGENT_DIR', second);
    expect(await catalog.detectModels('pi', options)).toEqual(['second/shared']);
    expect(await catalog.detectModels('pi', { ...options, probeEnv: { PI_CODING_AGENT_DIR: first } })).toEqual(['first/shared']);
  });
});
