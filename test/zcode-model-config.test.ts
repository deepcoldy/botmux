import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareZcodeSessionModel } from '../src/services/zcode-model-config.js';
import { resolveZcodeModelReference, readZcodeModelChoices } from '../src/services/zcode-models.js';

const source = process.env.BOTMUX_ZCODE_SOURCE_DIR || join(homedir(), 'zcode-src');
const canUseNativeCodec = existsSync(join(source, 'packages/provider-node/src/index.ts'));
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-zcode-model-')); directories.push(root);
  const config = join(root, 'providers.json');
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, config: {
    providerConfigRules: { providerRules: [{ providerId: 'fixture-provider', providerName: 'Fixture', config: {
      group: 'standard-personal', access: { type: 'api-key', apiKey: 'test-placeholder' },
      api: { type: 'openai-chat-completions', baseUrl: 'https://api.xiaomimimo.com/v1' },
      personalModelIds: ['mimo-v2.6-pro', 'mimo-v2.6-flash'], modelOrder: ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
    } }] },
    modelConfigRules: { manualProviderModelRules: [], providerModelRules: [] },
  } }));
  const env = { ...process.env, BOTMUX_ZCODE_SOURCE_DIR: source, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: config };
  return { root, config, env, helperPath: resolve('scripts/zcode-provider-helper.mjs') };
}

describe('ZCode model identities', () => {
  it('persists stable provider ids while accepting an unambiguous legacy label', () => {
    const f = fixture();
    expect(readZcodeModelChoices(f.env)).toContain('fixture-provider/mimo-v2.6-pro');
    expect(resolveZcodeModelReference('Fixture/mimo-v2.6-pro', f.env)).toEqual({ providerId: 'fixture-provider', modelId: 'mimo-v2.6-pro' });
  });
  it('rejects ambiguous provider names instead of selecting the first', () => {
    const f = fixture(); const c = JSON.parse(readFileSync(f.config, 'utf8'));
    c.config.providerConfigRules.providerRules.push({ ...c.config.providerConfigRules.providerRules[0], providerId: 'second-provider' });
    writeFileSync(f.config, JSON.stringify(c));
    expect(() => resolveZcodeModelReference('Fixture/mimo-v2.6-pro', f.env)).toThrow(/ambiguous/);
  });
});

describe.skipIf(!canUseNativeCodec)('ZCode native codec model preparation', () => {
  it('isolates concurrent topic defaults and leaves the desktop configuration untouched', async () => {
    const f = fixture(); const before = readFileSync(f.config, 'utf8');
    const models = ['mimo-v2.6-pro', 'mimo-v2.6-flash'];
    const results = await Promise.all(models.map(model => prepareZcodeSessionModel({
      sessionId: randomUUID(), dataDir: f.root, model: `Fixture/${model}`, env: f.env, resume: false, helperPath: f.helperPath,
    })));
    expect(results[0].ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).not.toBe(results[1].ZCODE_PERSONAL_PROVIDER_CONFIG_FILE);
    for (let i = 0; i < results.length; i++) {
      const file = results[i].ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
      const selection = JSON.parse(readFileSync(file, 'utf8')).config.defaultModelSelection;
      expect(selection).toMatchObject({ providerId: 'fixture-provider', modelId: models[i] });
      expect(selection.options.reasoningLevel).toBeTruthy();
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(f.config, 'utf8')).toBe(before);
  }, 30_000);
  it('keeps the chosen model when the requested level is unsupported', async () => {
    // The invariant that matters: an over-ambitious level must never move the
    // request onto a different model. It is narrowed to this model's own
    // closest level instead (see the per-model matrix in zcode-effort-downgrade).
    const f = fixture();
    const result = await prepareZcodeSessionModel({ sessionId: randomUUID(), dataDir: f.root,
      model: 'Fixture/mimo-v2.6-pro', reasoningEffort: 'max', env: f.env, resume: false, helperPath: f.helperPath,
    });
    const selection = JSON.parse(readFileSync(result.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, 'utf8')).config.defaultModelSelection;
    expect(selection).toMatchObject({ providerId: 'fixture-provider', modelId: 'mimo-v2.6-pro' });
    expect(selection.options.reasoningLevel).toBe('enabled');
  }, 30_000);
  it('does not override the saved model on a cold resume', async () => {
    const f = fixture();
    const result = await prepareZcodeSessionModel({ sessionId: randomUUID(), dataDir: f.root,
      model: 'Fixture/mimo-v2.6-flash', env: f.env, resume: true, helperPath: f.helperPath,
    });
    expect(JSON.parse(readFileSync(result.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, 'utf8')).config.defaultModelSelection).toBeUndefined();
  }, 30_000);
});

describe('ensureZcodeProviderHelper', () => {
  it('materialises the embedded bridge and is idempotent', async () => {
    const { ensureZcodeProviderHelper } = await import('../src/services/zcode-model-config.js');
    const { ZCODE_PROVIDER_HELPER_SOURCE } = await import('../src/services/zcode-provider-helper-data.js');
    const root = mkdtempSync(join(tmpdir(), 'botmux-zcode-helper-')); directories.push(root);
    const target = join(root, 'bin', 'zcode-provider-helper.mjs');

    // 干净安装：文件不存在 → 必须写出来，否则 fail-closed 的 provider 准备会 ENOENT。
    expect(existsSync(target)).toBe(false);
    expect(ensureZcodeProviderHelper(target)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe(ZCODE_PROVIDER_HELPER_SOURCE);

    // 幂等：内容一致时不动 mtime，热 spawn 不该反复写盘。
    const before = statSync(target).mtimeMs;
    ensureZcodeProviderHelper(target);
    expect(statSync(target).mtimeMs).toBe(before);

    // 内容漂移（旧版本残留）→ 覆盖回内嵌真源。
    writeFileSync(target, '# stale\n');
    ensureZcodeProviderHelper(target);
    expect(readFileSync(target, 'utf8')).toBe(ZCODE_PROVIDER_HELPER_SOURCE);
  });

  // 干净机器上没有 zcode-src 也没有 bun。原先这里 fail-closed，导致「一条 zcode
  // 话题都起不来」。正确行为是降级：不覆盖模型，让 ZCode 用它自己保存的选择启动。
  it('degrades to no model override when the ZCode codec is unavailable', async () => {
    const { prepareZcodeSessionModel } = await import('../src/services/zcode-model-config.js');
    const root = mkdtempSync(join(tmpdir(), 'botmux-zcode-missing-')); directories.push(root);
    const result = await prepareZcodeSessionModel({
      sessionId: randomUUID(),
      dataDir: root,
      env: { BOTMUX_ZCODE_SOURCE_DIR: join(root, 'no-such-tree'), BOTMUX_ZCODE_BUN: join(root, 'no-bun') },
      resume: false,
      helperPath: join(root, 'helper.mjs'),
    });
    expect(result).toEqual({});
  });

  // The helper is only useful once the codec exists, and writing it can fail in
  // ordinary deployments (read-only HOME, ~/.botmux/bin occupied by a file,
  // unwritable custom BOTMUX_ZCODE_PROVIDER_HELPER). A write failure must
  // degrade like a missing codec instead of aborting the topic launch.
  it('degrades to no model override when the helper cannot be written', async () => {
    const { prepareZcodeSessionModel } = await import('../src/services/zcode-model-config.js');
    const root = mkdtempSync(join(tmpdir(), 'botmux-zcode-unwritable-')); directories.push(root);
    // A fake source tree so the codec check passes; bun only has to exist.
    mkdirSync(join(root, 'src', 'packages/provider-node/src'), { recursive: true });
    writeFileSync(join(root, 'src', 'packages/provider-node/src/index.ts'), 'export {};\n');
    // The helper's parent path is a regular file → mkdirSync throws ENOTDIR.
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'not a directory\n');
    const result = await prepareZcodeSessionModel({
      sessionId: randomUUID(),
      dataDir: root,
      // No explicit helperPath: the default path is resolved from this env, so
      // the embedded bridge actually has to be materialised (and fails).
      env: {
        BOTMUX_ZCODE_SOURCE_DIR: join(root, 'src'),
        BOTMUX_ZCODE_BUN: process.execPath,
        BOTMUX_ZCODE_PROVIDER_HELPER: join(blocked, 'bin', 'zcode-provider-helper.mjs'),
      },
      resume: false,
    });
    expect(result).toEqual({});
  });
});
