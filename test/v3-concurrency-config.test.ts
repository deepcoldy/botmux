import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import {
  globalConfigPath,
  invalidateGlobalConfigCache,
  mergeGlobalConfig,
  readGlobalConfig,
  workflowConcurrencyConfig,
} from '../src/global-config.js';
import { resolveV3Concurrency } from '../src/workflows/v3/concurrency-config.js';
import { applySettingsWrite, type SettingsWriteApplierDeps } from '../src/dashboard/settings-write-applier.js';
import { formatV3Concurrency, parseArgs } from '../src/workflows/v3/cli-run.js';
import { validateDag } from '../src/workflows/v3/dag.js';
import { runWorkflow, type V3RuntimeDeps, type V3RuntimeOptions } from '../src/workflows/v3/runtime.js';
import { readAndValidateManifest, ManifestValidationError } from '../src/workflows/v3/manifest.js';
import { GOAL_ENV, type BotSnapshot, type RunNode, type ValidateManifest } from '../src/workflows/v3/contract.js';

describe('workflow.concurrency in ~/.botmux/config.json', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-v3-concurrency-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', join(home, 'config.json'));
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
    invalidateGlobalConfigCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(home, { recursive: true, force: true });
  });

  const write = (workflow: unknown): void => {
    writeFileSync(globalConfigPath(), JSON.stringify({ workflow }));
    invalidateGlobalConfigCache();
  };

  it('缺省时没有任何配置，runtime 保持代码默认值', () => {
    expect(workflowConcurrencyConfig()).toBeUndefined();
    expect(resolveV3Concurrency(workflowConcurrencyConfig())).toEqual({});
  });

  it('读取合法的 global / perBot / perCli / perCliById', () => {
    write({ concurrency: { global: 16, perBot: 4, perCli: 3, perCliById: { 'claude-code': 8, codex: 2 } } });
    expect(workflowConcurrencyConfig()).toEqual({
      global: 16, perBot: 4, perCli: 3, perCliById: { 'claude-code': 8, codex: 2 },
    });
  });

  it('丢弃非法值：非整数、<1、超过 64、字符串、数组', () => {
    write({
      concurrency: {
        global: 0, perBot: 2.5, perCli: '8',
        perCliById: { 'claude-code': 65, codex: -1, traex: 4, '': 3 },
      },
    });
    expect(workflowConcurrencyConfig()).toEqual({ perCliById: { traex: 4 } });
    write({ concurrency: [1, 2] });
    expect(workflowConcurrencyConfig()).toBeUndefined();
  });

  it('Dashboard 切换 workflow.enabled / nodeExecutor 时 concurrency 不被抹掉（走真实 applier）', async () => {
    write({ enabled: false, concurrency: { perBot: 4, perCliById: { 'claude-code': 8 } } });
    const deps = { readGlobalConfig, mergeGlobalConfig, resolveDashboardSettings: () => ({}) } as unknown as SettingsWriteApplierDeps;
    expect(await applySettingsWrite({ workflow: { enabled: true } }, deps)).toMatchObject({ ok: true });
    invalidateGlobalConfigCache();
    expect(await applySettingsWrite({ workflow: { nodeExecutor: 'bot' } }, deps)).toMatchObject({ ok: true });
    invalidateGlobalConfigCache();
    expect(readGlobalConfig().workflow).toEqual({
      enabled: true, nodeExecutor: 'bot', concurrency: { perBot: 4, perCliById: { 'claude-code': 8 } },
    });
  });
});

describe('resolveV3Concurrency 优先级', () => {
  it('显式覆盖 > 配置 > 代码默认（缺省字段不输出）', () => {
    expect(resolveV3Concurrency({ global: 8, perBot: 3 }, { global: 2 })).toEqual({
      globalConcurrency: 2, perBotConcurrency: 3,
    });
  });

  it('配置的 perCli 与 perCliById 一起透传', () => {
    expect(resolveV3Concurrency({ perCli: 3, perCliById: { 'claude-code': 8 } })).toEqual({
      perCliConcurrency: 3, perCliConcurrencyById: { 'claude-code': 8 },
    });
  });

  it('显式 perCli 覆盖整张 perCliById 表，--max-per-cli 1 必须对所有 CLI 生效', () => {
    expect(resolveV3Concurrency({ perCli: 3, perCliById: { 'claude-code': 8 } }, { perCli: 1 })).toEqual({
      perCliConcurrency: 1,
    });
  });
});

describe('botmux v3 run 并发参数', () => {
  it('解析 --max-parallel / --max-per-bot / --max-per-cli', () => {
    const a = parseArgs(['dag.json', '--max-parallel', '8', '--max-per-bot', '4', '--max-per-cli', '6']);
    expect(a).toMatchObject({ maxParallel: 8, maxPerBot: 4, maxPerCli: 6 });
    expect(a.dagPath.endsWith('dag.json')).toBe(true);
  });

  it('拒绝非正整数和超过 64 的 per 上限；--max-parallel 保持原有无上限语义', () => {
    expect(() => parseArgs(['dag.json', '--max-per-cli', '0'])).toThrow(/--max-per-cli 必须是正整数/);
    expect(() => parseArgs(['dag.json', '--max-per-bot', '1.5'])).toThrow(/--max-per-bot 必须是正整数/);
    expect(() => parseArgs(['dag.json', '--max-per-cli', '65'])).toThrow(/不能超过 64/);
    expect(parseArgs(['dag.json', '--max-parallel', '100']).maxParallel).toBe(100);
  });

  it('启动时打印的上限摘要包含每层的实际值', () => {
    expect(formatV3Concurrency({})).toBe('全局 4 / 每 bot 1 / 每种 CLI 2');
    expect(formatV3Concurrency({
      globalConcurrency: 16, perBotConcurrency: 4, perCliConcurrency: 3, perCliConcurrencyById: { 'claude-code': 8 },
    })).toBe('全局 16 / 每 bot 4 / 每种 CLI 3（claude-code=8）');
  });
});

describe('runtime 按 CLI 类型分别限流', () => {
  const validateManifest: ValidateManifest = async (manifestPath, outputDir) => {
    try {
      return { ok: true, manifest: await readAndValidateManifest(manifestPath, outputDir) };
    } catch (e) {
      return { ok: false, problems: e instanceof ManifestValidationError ? e.problems : [String(e)] };
    }
  };

  // Each node gets its own bot (distinct larkAppId) so the per-bot cap never
  // binds; the CLI type comes from the selector prefix.
  const resolveBotSnapshot = (bot: string | undefined): BotSnapshot => ({
    larkAppId: `cli_${bot}`,
    cliId: bot!.startsWith('cx') ? 'codex' : 'claude-code',
    workingDir: '/tmp',
  });

  async function peakByCli(opts: Partial<V3RuntimeOptions>): Promise<Record<string, number>> {
    const base = mkdtempSync(join(tmpdir(), 'v3-percli-'));
    try {
      const nodes = [
        ...Array.from({ length: 6 }, (_, i) => ({ id: `cc${i}`, type: 'goal', goal: 'g', bot: `cc${i}` })),
        ...Array.from({ length: 6 }, (_, i) => ({ id: `cx${i}`, type: 'goal', goal: 'g', bot: `cx${i}` })),
      ];
      const dag = validateDag({ runId: 'percli', nodes });
      const live: Record<string, number> = {};
      const peak: Record<string, number> = {};
      const runNode: RunNode = async (req) => {
        const cli = req.node.id.startsWith('cx') ? 'codex' : 'claude-code';
        live[cli] = (live[cli] ?? 0) + 1;
        peak[cli] = Math.max(peak[cli] ?? 0, live[cli]!);
        await new Promise((r) => setTimeout(r, 30));
        live[cli]!--;
        const body = `# ${req.node.id}`;
        writeFileSync(join(req.outputDir, 'out.md'), body);
        const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH]!;
        writeFileSync(manifestPath, JSON.stringify({
          schemaVersion: 1, status: 'ok', summary: 'ok',
          files: [{
            name: 'out.md', path: 'out.md', kind: 'markdown', mime: 'text/markdown',
            bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'),
          }],
        }));
        return { status: 'ok', manifestPath };
      };
      const outcome = await runWorkflow(
        dag,
        { runNode, validateManifest, resolveBotSnapshot } satisfies V3RuntimeDeps,
        { baseDir: base, globalConcurrency: 64, ...opts },
      );
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      return peak;
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  it('不配置时每种 CLI 最多 2 个（现有默认不变）', async () => {
    expect(await peakByCli({})).toEqual({ 'claude-code': 2, codex: 2 });
  });

  it('perCliConcurrencyById 只放开指定的 CLI，其余仍走 perCliConcurrency', async () => {
    expect(await peakByCli(resolveV3Concurrency({ perCli: 1, perCliById: { 'claude-code': 5 } })))
      .toEqual({ 'claude-code': 5, codex: 1 });
  });
});
