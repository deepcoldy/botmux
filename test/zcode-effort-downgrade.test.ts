import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareZcodeSessionModel } from '../src/services/zcode-model-config.js';
import { isConfigurableReasoningCliId, reasoningEffortsForCliModel } from '../src/services/codex-reasoning-effort.js';

/**
 * ZCode declares reasoning levels PER MODEL in its own provider catalog:
 * grok-4.6 tops out at `xhigh`, GLM/Opus reach `max`, and Xiaomi MiMo exposes a
 * toggle (`disabled`/`enabled`) rather than a ladder. Asking for a level the
 * chosen model does not offer must not brick the topic — the launch path takes
 * the closest level that model supports and reports the adjustment.
 */
const source = process.env.BOTMUX_ZCODE_SOURCE_DIR || join(homedir(), 'zcode-src');
/** The provider bridge imports ZCode's own TypeScript codec from a source
 *  checkout, so these cases cannot run on a machine without one. */
const canUseNativeCodec = existsSync(join(source, 'packages/provider-node/src/index.ts'));
const providers = [
  { providerName: '小米MiMo', apiType: 'openai-chat-completions', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash' },
  { providerName: 'GLM', apiType: 'openai-responses', baseUrl: 'https://gateway.example.com', model: 'glm-5.3-flash' },
  { providerName: 'Opus', apiType: 'anthropic-messages', baseUrl: 'https://gateway.example.com', model: 'claude-opus-5-5' },
] as const;

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-zcode-effort-'));
  directories.push(root);
  const config = join(root, 'providers.json');
  writeFileSync(config, JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: providers.map(({ providerName, apiType, baseUrl, model }) => ({
          providerId: `fixture-${providerName}`,
          providerName,
          config: {
            group: 'standard-personal',
            access: { type: 'api-key', apiKey: 'test-placeholder-key' },
            api: { type: apiType, baseUrl },
            personalModelIds: [model],
            modelOrder: [model],
          },
        })),
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  }));
  const env = { ...process.env, BOTMUX_ZCODE_SOURCE_DIR: source, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: config };
  return { root, config, env, helperPath: resolve('scripts/zcode-provider-helper.mjs') };
}

async function selectionFor(model: string, reasoningEffort: string) {
  const f = fixture();
  const result = await prepareZcodeSessionModel({
    sessionId: randomUUID(), dataDir: f.root, model, reasoningEffort,
    env: f.env, resume: false, helperPath: f.helperPath,
  });
  const saved = JSON.parse(readFileSync(result.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, 'utf8'));
  return saved.config.defaultModelSelection as { providerId: string; modelId: string; options: { reasoningLevel: string } };
}

describe.skipIf(!canUseNativeCodec)('ZCode reasoning levels differ per model', () => {
  it('stays in the control plane and offers the shared vocabulary', () => {
    expect(isConfigurableReasoningCliId('zcode')).toBe(true);
    expect(reasoningEffortsForCliModel('zcode', 'anything')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });

  it('maps an unsupported level onto a toggle model instead of failing', async () => {
    // MiMo declares disabled/enabled only: any requested level must land on the
    // model's real switch, never on another model.
    const selection = await selectionFor('小米MiMo/mimo-v2.6-flash', 'max');
    expect(selection).toMatchObject({ providerId: 'fixture-小米MiMo', modelId: 'mimo-v2.6-flash' });
    expect(selection.options.reasoningLevel).toBe('enabled');
  }, 30_000);

  it('keeps a level the model supports untouched', async () => {
    const selection = await selectionFor('Opus/claude-opus-5-5', 'xhigh');
    expect(selection.options.reasoningLevel).toBe('xhigh');
  }, 30_000);

  it('lowers an over-max request to the model ceiling', async () => {
    // GLM reaches max but not ultra.
    const selection = await selectionFor('GLM/glm-5.3-flash', 'ultra');
    expect(selection.modelId).toBe('glm-5.3-flash');
    expect(selection.options.reasoningLevel).toBe('max');
  }, 30_000);
});
