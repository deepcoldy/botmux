/**
 * 「这个 bot 的下一次 spawn 能不能带上一个指定模型」——话题指令头里 `/model` 的**能力门**。
 *
 * 与两个相邻但不同的判据分清楚：
 *   - `isConfigurableReasoningCliId`（services/codex-reasoning-effort.ts）是**策略**门：
 *     trigger API / 定时任务只让「有显式推理控制」的 CLI 接受每次触发的模型覆盖。
 *     它比这里窄得多（只有 codex / codex-app / grok / traex / claude-code），拿它当能力门
 *     会把 gemini、cursor、opencode 这些明明吃 `--model` 的 CLI 一并拒掉。
 *   - `CliAdapter.modelChoices` 是 **UI 策展**：`botmux setup` / dashboard / 配置卡要不要
 *     渲染模型下拉。它两头都不准 —— `pi` / `oh-my-pi` 吃 `--model` 却没有候选列表，
 *     而 `dsh-tui` 列了候选却在注释里写明「模型由 TUI 自己的 profile 决定，不注入」。
 *
 * 所以这里维护一张显式清单，判据是**启动路径是否真的把 `model` 带出去**：
 * 适配器 `buildArgs(opts)` 消费 `opts.model`，或者该后端把 `cfg.model` 交给远端
 * （mojo：`buildEffectiveMojoConfig` → `--model`）。清单由
 * `test/launch-model-capability.test.ts` 对每个已注册适配器实跑 `buildArgs`（带 / 不带
 * model 两次取差）来钉住，新增或改动适配器时那条测试会先红。
 *
 * riff 是唯一「cliId 说了不算」的例外：它的模型只从 bot 的 `riff` 配置块取
 * （worker.ts 的 riff 分支从不读 `cfg.model`），所以任何 `backendType: 'riff'` 的会话，
 * 无论跑哪个 cliId，都带不动每次启动的模型覆盖。
 */
import type { BackendType } from '../adapters/backend/types.js';
import type { CliId } from '../adapters/cli/types.js';

/** 启动参数（或远端后端配置）里真的会带上 model 的 CLI。 */
export const LAUNCH_MODEL_CLI_IDS: ReadonlySet<CliId> = new Set<CliId>([
  'claude-code', 'seed', 'relay', 'coco', 'codex', 'codex-app', 'cursor', 'gemini',
  'genius', 'opencode', 'traex', 'pi', 'copilot', 'oh-my-pi', 'kimi', 'grok',
  'reasonix', 'dsh', 'minimax',
  // PTY 之外：MojoBackend 把 botmux 解析出的 model 拼进 `mojo -p --model`。
  'mojo',
]);

/**
 * 这个 bot 起会话时能否接受「本次 spawn 用哪个模型」。
 *
 * 只看 bot 配置：指令头在会话诞生**之前**求值，此时 `session.cliId` 还没冻结，
 * 冻结值就是 `botCfg.cliId`（见 worker-pool 的 sessionAgentConfig）。
 */
export function botAcceptsLaunchModel(
  botCfg: { cliId?: CliId; backendType?: BackendType } | undefined,
): boolean {
  if (!botCfg?.cliId) return false;
  if (botCfg.backendType === 'riff') return false;
  return LAUNCH_MODEL_CLI_IDS.has(botCfg.cliId);
}
