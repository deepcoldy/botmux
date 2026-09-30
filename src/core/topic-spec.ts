/**
 * 把一个已解析的话题指令头（{@link ./topic-header.js parseTopicHeader} 的产物）
 * 变成一份可以直接往会话上写的**会话规格**：标题、工作目录、本次 spawn 的模型、
 * 持久化的推理强度。
 *
 * 形状对齐 `resolveScheduleModelOverride`（core/schedule-model-override.ts），但策略
 * 相反：定时任务在**没人在场**时触发，模型名过期就降级并警告（fail soft）；指令头是
 * 人刚敲完回车的那一刻，改完重发的成本远低于半截状态，所以任一项校验失败就整条拒绝、
 * 零副作用（决策 D5）。
 *
 * 除仓库目录 `stat`（resolveRepoSelection）之外无 I/O，不读会话、不写任何状态。
 */
import type { BackendType } from '../adapters/backend/types.js';
import type { CliId } from '../adapters/cli/types.js';
import {
  cliModelSupportsReasoningEffort,
  isConfigurableReasoningCliId,
  isCodexReasoningEffort,
  type CodexReasoningEffort,
} from '../services/codex-reasoning-effort.js';
import { botAcceptsLaunchModel } from './launch-model-capability.js';
import { resolveRepoSelection } from './repo-selection.js';
import type { TopicHeader } from './topic-header.js';

/**
 * 模型名的**语法**边界。刻意不拿 `modelChoices` 当白名单：那是 setup / dashboard 的
 * 策展列表，网关映射名（`model_hub/…`）和刚发布的新模型都不在里面，按白名单校验会把
 * 合法用法拒掉。这里只要求它长得像一个模型 id —— ASCII、不含空白、限长。
 *
 * 这条规则同时兜住设计文档里那个「正文恰好以白名单词开头」的边界：
 * `/t /repo botmux /model 命令为啥坏了` 会把 `命令为啥坏了` 吃成模型名，非 ASCII →
 * 校验失败 → 拒绝，而不是静默拿一个荒谬的模型去启动。
 */
const MODEL_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*(\[[A-Za-z0-9_.-]+\])?$/;
const MODEL_TOKEN_MAX = 64;

export type TopicSpecError =
  /** `/repo 2` —— 数字形式只对选仓卡片有意义，头部里没有卡片。 */
  | { kind: 'repo_numeric'; arg: string }
  /** `/repo X` 没解析出任何存在的目录。 */
  | { kind: 'repo_not_found'; arg: string }
  /** `/repo wt …` —— 建 worktree 是会话内的 `/repo wt` 子命令，头部里吃不下它的多个参数。 */
  | { kind: 'repo_worktree_unsupported'; arg: string }
  /** 模型名不像模型名（含空白/非 ASCII/超长）。 */
  | { kind: 'model_invalid'; arg: string }
  /** 这个 bot 的启动路径根本带不动模型（见 launch-model-capability）。 */
  | { kind: 'model_unsupported_cli'; cliId?: CliId; backendType?: BackendType }
  /** `/effort X` 不是合法档位。 */
  | { kind: 'effort_invalid'; arg: string }
  /** 这个 CLI 没有显式推理控制。 */
  | { kind: 'effort_unsupported_cli'; cliId?: CliId }
  /** 档位合法但本次要用的模型不支持它。 */
  | { kind: 'effort_unsupported_model'; effort: CodexReasoningEffort; model?: string };

export interface TopicSpec {
  ok: true;
  /** 会话标题，来源 `user`（`updateSessionTitle` 会同步 CLI 原生会话名）。 */
  title?: string;
  /** 已解析的绝对目录；缺席表示头部没写 `/repo`，按 bot 现有的钉目录/选仓逻辑走。 */
  workingDir?: string;
  /** 头部里写的是裸 `/repo`（不带参数）：沿用它今天的语义 —— 不弹选仓卡，直接在默认
   *  工作目录起会话（选仓卡上「直接开始」按钮的文本孪生）。与 `workingDir` 互斥。 */
  repoStartInDefaultDir?: true;
  /** 仓库展示名，用于确认回复。 */
  repoDisplayName?: string;
  /** 本次 spawn 的模型（落 `DaemonSession.spawnModelOverride`，内存态、不持久化）。 */
  model?: string;
  /** 推理强度（落 `session.reasoningEffort`，与 trigger 一致地持久化）。 */
  reasoningEffort?: CodexReasoningEffort;
}

export type TopicSpecResult = TopicSpec | { ok: false; errors: TopicSpecError[] };

export interface TopicSpecContext {
  /** 活的 bot 配置：决定模型/推理强度的能力门与「本次会用哪个模型」。 */
  botCfg: { cliId?: CliId; model?: string; backendType?: BackendType };
  /** `/repo <名字>` 的搜索根（与选仓卡片同一套 `getProjectScanDirs(ds)`）。 */
  scanDirs: string[];
}

/**
 * 校验并落实一份指令头。**收集全部错误**再一次性返回：用户一条消息里可能同时写错
 * 仓库名和模型名，一次告诉他两条比让他改一条再撞一次墙好。
 */
export function resolveTopicSpec(header: TopicHeader, ctx: TopicSpecContext): TopicSpecResult {
  const errors: TopicSpecError[] = [];
  const spec: TopicSpec = { ok: true };
  const { botCfg } = ctx;

  if (header.title) spec.title = header.title;

  const repoDirective = header.directives.repo;
  // 裸 `/repo`（写了指令但没带参数）—— 解析器记成 null。既有语义原样保留。
  if (repoDirective === null) spec.repoStartInDefaultDir = true;
  const repoArg = repoDirective?.trim();
  if (repoArg) {
    if (/^\d+$/.test(repoArg)) {
      errors.push({ kind: 'repo_numeric', arg: repoArg });
    } else if (/^wt$/i.test(repoArg)) {
      // 会话中途的 `/repo wt <编号|项目名> [分支]` 吃整行；头部里的 `/repo` 只吃一个
      // token（D4/D7），于是 `wt` 会被当成仓库名。多数情况报「找不到仓库 wt」还算能懂，
      // 但只要扫描根下恰好有个叫 `wt` 的目录，它就会**静默开在错误的目录里**。
      // 显式拒绝，并告诉用户先开话题、再在话题内发 `/repo wt …`。
      errors.push({ kind: 'repo_worktree_unsupported', arg: repoArg });
    } else {
      const resolved = resolveRepoSelection(repoArg, ctx.scanDirs);
      if (!resolved) errors.push({ kind: 'repo_not_found', arg: repoArg });
      else {
        spec.workingDir = resolved.path;
        spec.repoDisplayName = resolved.displayName;
      }
    }
  }

  const modelArg = header.directives.model?.trim();
  if (modelArg) {
    if (modelArg.length > MODEL_TOKEN_MAX || !MODEL_TOKEN_RE.test(modelArg)) {
      errors.push({ kind: 'model_invalid', arg: modelArg });
    } else if (!botAcceptsLaunchModel(botCfg)) {
      errors.push({
        kind: 'model_unsupported_cli',
        ...(botCfg.cliId ? { cliId: botCfg.cliId } : {}),
        ...(botCfg.backendType ? { backendType: botCfg.backendType } : {}),
      });
    } else {
      spec.model = modelArg;
    }
  }

  const effortArg = header.directives.effort?.trim().toLowerCase();
  if (effortArg) {
    // 推理强度按**本次真正会用的模型**校验：头部钉了模型就用它，否则用 bot 配置的
    // ——与 sessionAgentConfig 在 spawn 时的口径一致。模型那一项自己校验失败时，
    // 这里退回 bot 配置的模型，好让用户一次看到两条独立的错误而不是连锁误报。
    const effectiveModel = spec.model ?? botCfg.model;
    if (!isCodexReasoningEffort(effortArg)) {
      errors.push({ kind: 'effort_invalid', arg: effortArg });
    } else if (!isConfigurableReasoningCliId(botCfg.cliId)) {
      errors.push({ kind: 'effort_unsupported_cli', ...(botCfg.cliId ? { cliId: botCfg.cliId } : {}) });
    } else if (!cliModelSupportsReasoningEffort(botCfg.cliId, effectiveModel, effortArg)) {
      errors.push({
        kind: 'effort_unsupported_model',
        effort: effortArg,
        ...(effectiveModel ? { model: effectiveModel } : {}),
      });
    } else {
      spec.reasoningEffort = effortArg;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : spec;
}
