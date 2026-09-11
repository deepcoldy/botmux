/**
 * `LAUNCH_MODEL_CLI_IDS` 是一张手工清单，这条测试负责让它**说的是实话**。
 *
 * 判据是可观测的：给适配器的 `buildArgs` 传两次同样的 opts，一次带 `model` 一次不带，
 * argv 有差异就说明这个 CLI 真的会把模型带进启动参数。所以任何一次适配器改动
 *（新增 CLI、给某个 CLI 加上或去掉 `--model`）都会先让这条测试红，而不是让用户在飞书里
 * 发现 `/model` 被静默忽略。
 *
 * 两个 PTY 之外的例外单列并注明来源，避免被后来的人当成清单漏项「顺手修掉」：
 *   - mojo：`buildArgs` 返回空数组，模型经 MojoBackend（buildEffectiveMojoConfig →
 *     `mojo -p --model`）下发，所以在清单里但探测不到；
 *   - riff：`buildArgs` 不带模型，RiffBackend 的 `config.model` 也只来自 bot 的 `riff`
 *     配置块（worker.ts 的 riff 分支从不读 `cfg.model`），所以不在清单里。
 *
 * Run:  bun run vitest run test/launch-model-capability.test.ts
 */
import { describe, it, expect } from 'vitest';

import { ALL_CLI_IDS, createCliAdapterSync } from '../src/adapters/cli/registry.js';
import type { CliId } from '../src/adapters/cli/types.js';
import { LAUNCH_MODEL_CLI_IDS, botAcceptsLaunchModel } from '../src/core/launch-model-capability.js';

/** 只有后端（不是 buildArgs）把模型带出去的 CLI —— 探测看不见，必须显式记账。 */
const BACKEND_CARRIED: ReadonlySet<CliId> = new Set<CliId>(['mojo']);

const PROBE_OPTS = {
  sessionId: 'sid-launch-model-probe',
  initialPrompt: 'hello',
  workingDir: '/tmp',
  sessionDataDir: '/tmp/botmux-launch-model-probe',
  nativeSessionTitle: 'probe',
} as const;

/** `buildArgs` 带 model 与不带 model 的 argv 是否不同。构造/调用失败视为「带不动」。 */
function buildArgsCarriesModel(cliId: CliId): boolean {
  try {
    const adapter = createCliAdapterSync(cliId);
    const without = JSON.stringify(adapter.buildArgs({ ...PROBE_OPTS } as never));
    const withModel = JSON.stringify(adapter.buildArgs({ ...PROBE_OPTS, model: 'ZZ-PROBE-MODEL' } as never));
    return without !== withModel;
  } catch {
    return false;
  }
}

describe('LAUNCH_MODEL_CLI_IDS 与适配器实况一致', () => {
  it('清单成员 = buildArgs 真的吃 model 的 CLI ∪ 后端下发的 CLI', () => {
    const observed = new Set<CliId>(
      ALL_CLI_IDS.filter(id => buildArgsCarriesModel(id) || BACKEND_CARRIED.has(id)),
    );
    expect([...observed].sort()).toEqual([...LAUNCH_MODEL_CLI_IDS].sort());
  });

  it('清单外的 CLI 确实不把 model 带进启动参数', () => {
    for (const cliId of ALL_CLI_IDS) {
      if (LAUNCH_MODEL_CLI_IDS.has(cliId)) continue;
      expect({ cliId, carries: buildArgsCarriesModel(cliId) }).toEqual({ cliId, carries: false });
    }
  });
});

describe('botAcceptsLaunchModel', () => {
  it('清单内的 CLI 放行', () => {
    expect(botAcceptsLaunchModel({ cliId: 'claude-code' })).toBe(true);
    expect(botAcceptsLaunchModel({ cliId: 'mojo' })).toBe(true);
  });

  it('清单外的 CLI 拒绝', () => {
    // dsh-tui 列了 modelChoices（setup 会问模型）却在注释里写明不注入——正是
    // 「modelChoices 不能当能力门」的反例。
    expect(botAcceptsLaunchModel({ cliId: 'dsh-tui' })).toBe(false);
    expect(botAcceptsLaunchModel({ cliId: 'riff' })).toBe(false);
  });

  it('riff 后端一票否决，与 cliId 无关', () => {
    expect(botAcceptsLaunchModel({ cliId: 'codex' })).toBe(true);
    expect(botAcceptsLaunchModel({ cliId: 'codex', backendType: 'riff' })).toBe(false);
  });

  it('没有 cliId（未注册 bot）→ 拒绝', () => {
    expect(botAcceptsLaunchModel(undefined)).toBe(false);
    expect(botAcceptsLaunchModel({})).toBe(false);
  });
});
