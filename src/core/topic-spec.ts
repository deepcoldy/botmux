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
 * I/O 只有仓库目录 `stat`（resolveRepoSelection）与 `/repo wt` 的两次本地 git 查询
 * （`check-ref-format`、`worktree list`，不联网、毫秒级）——后者是 async 的唯一原因。
 * 不读会话、不写任何状态。
 */
import { existsSync } from 'node:fs';
import type { BackendType } from '../adapters/backend/types.js';
import type { CliId } from '../adapters/cli/types.js';
import {
  cliModelSupportsReasoningEffort,
  isConfigurableReasoningCliId,
  isCodexReasoningEffort,
  type CodexReasoningEffort,
} from '../services/codex-reasoning-effort.js';
import { isGitWorkTree, isValidBranchName, resolveWorktreePathForBranch } from '../services/git-worktree.js';
import { botAcceptsLaunchModel } from './launch-model-capability.js';
import { resolveRepoSelection } from './repo-selection.js';
import type { TopicHeader, TopicLifecycle } from './topic-header.js';

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
  /** `/th` `/tw`（`/t here|worktree`）已经指定「当前目录」，又写了 `/repo …`——相斥，不做静默优先级。 */
  | { kind: 'lifecycle_conflicts_repo'; lifecycle: TopicLifecycle }
  /** `/repo 2` —— 数字形式只对选仓卡片有意义，头部里没有卡片。 */
  | { kind: 'repo_numeric'; arg: string }
  /** `/repo X` 没解析出任何存在的目录。 */
  | { kind: 'repo_not_found'; arg: string }
  /** `/repo wt X`：目标解析到了，但那不是 git 仓库，建不了 worktree。 */
  | { kind: 'repo_not_git'; arg: string }
  /** `/repo wt X <分支>`：分支名过了粗模式，却过不了 `git check-ref-format`。 */
  | { kind: 'branch_invalid'; arg: string }
  /** `/repo wt X <分支>`：createRepoWorktree 会用的目标目录已经存在。 */
  | { kind: 'worktree_target_exists'; path: string }
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

/** 头部 `/repo wt` 落到 daemon 的创建请求：目录在建好之后才确定，这里只带仓库与分支。 */
export interface TopicSpecWorktree {
  /** 已解析的仓库绝对路径（任一 checkout；createRepoWorktree 会归一到主 checkout）。 */
  repoPath: string;
  branch?: string;
  /** 显式分支时预先算出的目标目录（已校验不存在）；自动命名时缺席。 */
  targetPath?: string;
}

export interface TopicSpec {
  ok: true;
  /** 生命周期变体：`here` 从当前群会话目录起，`worktree` 先从该目录建话题 worktree。
   *  目录本身由 daemon 按群/会话状态解析（这里没有会话），与 `workingDir` / `worktree` 互斥。 */
  lifecycle?: TopicLifecycle;
  /** 会话标题，来源 `user`（`updateSessionTitle` 会同步 CLI 原生会话名）。 */
  title?: string;
  /** 已解析的绝对目录；缺席表示头部没写 `/repo`，按 bot 现有的钉目录/选仓逻辑走。 */
  workingDir?: string;
  /** 头部里写的是裸 `/repo`（不带参数）：沿用它今天的语义 —— 不弹选仓卡，直接在默认
   *  工作目录起会话（选仓卡上「直接开始」按钮的文本孪生）。与 `workingDir` 互斥。 */
  repoStartInDefaultDir?: true;
  /** 仓库展示名，用于确认回复。 */
  repoDisplayName?: string;
  /** 头部写了 `/repo wt …`：会话以 pendingRepo 建立，由 daemon 在话题建好后建 worktree 再 fork。
   *  与 `workingDir` / `repoStartInDefaultDir` 互斥。 */
  worktree?: TopicSpecWorktree;
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
export async function resolveTopicSpec(header: TopicHeader, ctx: TopicSpecContext): Promise<TopicSpecResult> {
  const errors: TopicSpecError[] = [];
  const spec: TopicSpec = { ok: true };
  const { botCfg } = ctx;

  if (header.title) spec.title = header.title;
  if (header.lifecycle) {
    spec.lifecycle = header.lifecycle;
    // 主干曾对 `/th /repo x` 静默让生命周期目录优先、把 `/repo` 丢掉；指令头是 fail closed 的
    //（D5），相斥就拒，其余错误照常一并收齐。
    if (header.directives.repo !== undefined || header.worktree) {
      errors.push({ kind: 'lifecycle_conflicts_repo', lifecycle: header.lifecycle });
    }
  }

  const repoDirective = header.directives.repo;
  // 裸 `/repo`（写了指令但没带参数）—— 解析器记成 null。既有语义原样保留。
  if (repoDirective === null) spec.repoStartInDefaultDir = true;
  const repoArg = repoDirective?.trim();
  if (repoArg) {
    if (/^\d+$/.test(repoArg)) {
      errors.push({ kind: 'repo_numeric', arg: repoArg });
    } else {
      const resolved = resolveRepoSelection(repoArg, ctx.scanDirs);
      if (!resolved) errors.push({ kind: 'repo_not_found', arg: repoArg });
      else {
        spec.workingDir = resolved.path;
        spec.repoDisplayName = resolved.displayName;
      }
    }
  }

  // `/repo wt <目标> [分支]`：能提前查的全部 fail closed（设计 R9 / §8）——目标可解析、
  // 是 git 仓库、分支名合法、显式分支的目标目录不存在。自动命名（无分支）遇到已存在目录
  // 是换下一个候选，不需要前置查目录。
  if (header.worktree) {
    const target = header.worktree.target.trim();
    if (/^\d+$/.test(target)) {
      errors.push({ kind: 'repo_numeric', arg: target });
    } else {
      const resolved = resolveRepoSelection(target, ctx.scanDirs);
      if (!resolved) {
        errors.push({ kind: 'repo_not_found', arg: target });
      } else {
        const branch = header.worktree.branch;
        const wt: TopicSpecWorktree = { repoPath: resolved.path, ...(branch ? { branch } : {}) };
        let ok = true;
        if (branch) {
          if (!(await isValidBranchName(branch))) {
            errors.push({ kind: 'branch_invalid', arg: branch });
            ok = false;
          } else {
            try {
              const targetPath = await resolveWorktreePathForBranch(resolved.path, branch);
              if (existsSync(targetPath)) {
                errors.push({ kind: 'worktree_target_exists', path: targetPath });
                ok = false;
              } else {
                wt.targetPath = targetPath;
              }
            } catch {
              errors.push({ kind: 'repo_not_git', arg: target });
              ok = false;
            }
          }
        } else if (!(await isGitWorkTree(resolved.path))) {
          errors.push({ kind: 'repo_not_git', arg: target });
          ok = false;
        }
        if (ok) {
          spec.worktree = wt;
          spec.repoDisplayName = resolved.displayName;
        }
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
