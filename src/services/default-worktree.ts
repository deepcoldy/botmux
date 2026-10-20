/**
 * Auto-create a per-session git worktree when a bot is in「仅默认目录」mode
 * (`defaultWorkingDir` set) AND has `defaultWorkingDirAutoWorktree` enabled.
 *
 * Shared by every NEW-session spawn path that can land in the bot's OWN default
 * dir — interactive new topic (daemon.ts), dashboard「创建会话」(session-manager.ts)
 * and webhook / trigger external events (trigger-session.ts). v3 workflow nodes
 * and HTTP-virtual trigger sessions intentionally opt out (they run many
 * short-lived sessions and would spray never-cleaned worktrees).
 *
 * The caller decides whether the resolved dir came from the bot's own default
 * (`isBotDefaultDir`) — only that layer opts in; oncall-bound / sibling-inherited
 * dirs never auto-worktree. A non-git dir or a creation failure degrades to the
 * base dir so the session STILL starts, with a heads-up notice for the chat —
 * UNLESS the spawn will run under the LOCAL `oncall` file sandbox, in which case
 * the failure is fail-closed (see {@link AutoWorktreeFailClosedError}): oncall
 * binds `workingDir` read-write to the real host dir, so falling back to the
 * real default dir would let the agent's writes land in the real project,
 * defeating the isolation the sandbox promises. Exempt (they keep degrading):
 *   - `scratch` mode — the full-root COW overlay / APFS clone keeps the host
 *     untouched even when cwd is the real default dir;
 *   - remote backends (riff / remote-runner / provably-remote mojo) — no local
 *     CLI process, the worker bypasses the local sandbox entirely.
 * The mode comes from the SAME resolver the worker uses
 * (`resolveLocalSandboxMode`), fed with the session's FROZEN sandbox decision
 * (freezeSessionSandboxDecision), so a dashboard toggle landing during the
 * build can't diverge this gate from the later fork.
 *
 * ALL user-facing notices are posted from here via the caller-supplied `notify`
 * callback (best-effort — a failed send never propagates), so the three spawn
 * paths stay consistent and a Lark hiccup can never kill a session start. A
 * cheap git precheck runs BEFORE the "creating…" notice so a misconfigured
 * non-git default dir fails silently instead of spamming creating→failed pairs.
 *
 * CLI-agnostic: this only changes the spawn cwd, so it works identically for
 * every CLI adapter and both PTY / Tmux backends.
 */
import { getBot } from '../bot-registry.js';
import { config } from '../config.js';
import { resolvePairedSpawnBackendType } from '../core/persistent-backend.js';
import { botInjectedEnv } from '../core/env-policy.js';
import { resolveLocalSandboxMode } from '../adapters/backend/sandbox.js';
import { buildEffectiveMojoConfig, normalizeMojoConfig } from '../adapters/backend/mojo-types.js';
import type { BackendType } from '../adapters/backend/types.js';
import type { Session } from '../types.js';
import { createRepoWorktree, createRepoWorktreeAndCommit, isGitWorkTree, pushWorktreeBranch, type WorktreeCreation } from './git-worktree.js';
import { worktreeSlugFromContextAI } from './worktree-slug-ai.js';
import { t } from '../i18n/index.js';
import type { Locale } from '../i18n/types.js';
import { logger } from '../utils/logger.js';

/**
 * Raised when the auto-worktree cannot be created AND the spawn would run under
 * the LOCAL `oncall` file sandbox. That sandbox (bwrap/Seatbelt DIRECT mode)
 * binds `workingDir` read-write to the REAL host directory — the auto-worktree
 * is the only thing keeping a session's writes out of the real project.
 * Degrading to the base dir would silently defeat that isolation (a sandbox
 * escape), so the spawn is refused instead. The caller
 * (`runAutoWorktreeCommit`, im/lark/card-handler.ts) closes the pending session
 * and surfaces `reason` to the chat.
 */
export class AutoWorktreeFailClosedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'AutoWorktreeFailClosedError';
  }
}

/**
 * The session-scoped inputs of the fail-closed decision. `sandbox` is the
 * session's FROZEN tri-state (freezeSessionSandboxDecision) — the SAME value
 * forkWorker hands the worker; `cliId` / `backendType` are the session's own
 * selection/stamp so a per-session CLI choice resolves the same effective
 * backend the fork will. Omitted (legacy callers/tests) → live bot config.
 */
export interface AutoWorktreeSandboxSnapshot {
  sandbox: Session['sandbox'];
  cliId?: string;
  backendType?: BackendType;
}

/**
 * Whether a failed auto-worktree must fail CLOSED for this spawn, i.e. whether
 * the worker will run it under the LOCAL `oncall` sandbox. Mirrors worker.ts's
 * `sandboxMode` resolution through the shared resolveLocalSandboxMode.
 * Any resolution error (invalid sandbox value / BOTMUX_SANDBOX, bot gone)
 * answers `true`: the worker would refuse such a spawn anyway, and an unknown
 * decision must never permit the real-dir fallback.
 */
export function autoWorktreeMustFailClosed(
  larkAppId: string,
  snapshot?: AutoWorktreeSandboxSnapshot,
): boolean {
  try {
    const c = getBot(larkAppId).config;
    const effectiveBackend = resolvePairedSpawnBackendType(
      snapshot?.cliId ?? c.cliId, snapshot?.backendType, c.backendType, config.daemon.backendType,
    );
    // Build the SAME effective mojo config the worker builds (worker.ts →
    // buildEffectiveMojoConfig): the remote proof needs the merged
    // top-level/mojo env AND the top-level wrapperCli, not just the mojo block —
    // a top-level wrapperCli or a PATH in the merged env voids the cloud proof.
    // An invalid block is treated as "not provably remote" (sandbox applies).
    const mojoValidation = effectiveBackend === 'mojo' ? normalizeMojoConfig(c.mojo) : undefined;
    const effectiveMojo = effectiveBackend === 'mojo'
      ? buildEffectiveMojoConfig(mojoValidation?.ok ? mojoValidation.value : undefined, {
          cliPathOverride: c.cliPathOverride,
          env: c.env ? botInjectedEnv(c.env, c.envPolicy) : undefined,
          wrapperCli: c.wrapperCli,
        })
      : undefined;
    const mode = resolveLocalSandboxMode({
      backendType: effectiveBackend,
      mojoConfig: effectiveMojo,
      // forkWorker hands the worker the FROZEN session tri-state; legacy
      // readIsolation stays live there (its dashboard toggle is fenced on
      // "no active session of this bot", which includes this pending one).
      // An unfrozen snapshot (freeze threw — e.g. an invalid live value) falls
      // back to live config, which then throws here → fail-closed.
      configSandbox: snapshot?.sandbox !== undefined ? snapshot.sandbox : c.sandbox,
      readIsolation: c.readIsolation === true,
      envValue: process.env.BOTMUX_SANDBOX,
    });
    return mode === 'oncall';
  } catch {
    return true;
  }
}

export interface AutoWorktreeResult {
  /** Dir to spawn the session into: the new worktree on success, else `baseDir`
   *  (opt-out / non-git / failure). "A worktree was created" ⇔ `dir !== baseDir`. */
  dir: string;
}

export interface MaybeCreateWorktreeCtx {
  isBotDefaultDir: boolean;
  title?: string;
  prompt?: string;
  locale: Locale;
  /** Best-effort chat notice sink. Omit for silent (e.g. HTTP-virtual sessions). */
  notify?: (message: string) => Promise<unknown> | void;
  /** Explicit user command (for example `/tw`) requested a worktree even when
   *  the bot's default auto-worktree toggle is off. */
  force?: boolean;
  /** Deterministic worktree target for sharing one /tw topic across multiple bots. */
  worktreePath?: string;
  /** Deterministic branch for `worktreePath`. */
  branch?: string;
  /** Reuse an existing linked worktree at `worktreePath`. */
  reuseExisting?: boolean;
  /** Keep a deterministic target lock through caller-side admission/publication. */
  commitCreated?: (creation: WorktreeCreation) => Promise<void>;
  /**
   * The session's FROZEN sandbox decision (see AutoWorktreeSandboxSnapshot),
   * recorded at pending-session establishment BEFORE any await — the SAME
   * snapshot the later fork consumes. A dashboard `PUT /api/bot-sandbox` toggle
   * landing during the up-to-30s build must not let this gate degrade on the
   * old value while the fork isolates on the new one (a fail-open window).
   */
  sandboxSnapshot?: AutoWorktreeSandboxSnapshot;
}

/**
 * Whether this bot opts into auto-worktree on new sessions: it must be in
 * 「仅默认目录」mode (`defaultWorkingDir` set) with the toggle on. Because the
 * toggle is only settable in that mode, this doubles as the "in default mode"
 * check. Callers still gate on the resolved dir actually being the default one.
 */
export function botAutoWorktreeEnabled(larkAppId: string): boolean {
  try {
    const cfg = getBot(larkAppId).config;
    return cfg.defaultWorkingDirAutoWorktree === true && !!cfg.defaultWorkingDir;
  } catch {
    return false;
  }
}

/**
 * Given a resolved spawn dir, create a fresh linked worktree off it when the bot
 * opts in AND `isBotDefaultDir` is true. Otherwise returns `baseDir` unchanged.
 * A non-git dir or git failure degrades to `baseDir` with a notice, EXCEPT:
 *   - `force` (explicit `/tw`): rethrows (the caller keeps the session pending);
 *   - the spawn will run under the LOCAL oncall sandbox: throws
 *     {@link AutoWorktreeFailClosedError} instead of handing back the real dir.
 */
export async function maybeCreateDefaultWorktree(
  larkAppId: string,
  baseDir: string,
  ctx: MaybeCreateWorktreeCtx,
): Promise<AutoWorktreeResult> {
  if (!ctx.force && (!ctx.isBotDefaultDir || !botAutoWorktreeEnabled(larkAppId))) {
    return { dir: baseDir };
  }
  // Decided ONCE, before any await, from the session's frozen snapshot.
  const failClosed = !ctx.force && autoWorktreeMustFailClosed(larkAppId, ctx.sandboxSnapshot);
  const notify = async (msg: string) => {
    if (!ctx.notify) return;
    try { await ctx.notify(msg); } catch { /* notices are best-effort — never fail a session start */ }
  };

  // Cheap, network-free precheck: a non-git default dir fails instantly. Post the
  // fallback directly WITHOUT a preceding "creating…" (which would be misleading),
  // and skip the doomed createRepoWorktree call entirely.
  if (!(await isGitWorkTree(baseDir))) {
    const error = t('worktree.err_not_git', undefined, ctx.locale);
    if (ctx.force) {
      logger.warn(`[auto-worktree:${larkAppId}] explicit worktree refused: ${baseDir} is not a git work tree`);
      await notify(error);
      throw new Error(error);
    }
    if (failClosed) {
      logger.warn(`[auto-worktree:${larkAppId}] default dir is not a git work tree (oncall sandbox → fail-closed, refusing base dir): ${baseDir}`);
      throw new AutoWorktreeFailClosedError(error);
    }
    logger.warn(`[auto-worktree:${larkAppId}] default dir is not a git work tree, using it as-is: ${baseDir}`);
    await notify(t('worktree.auto_fallback', { dir: baseDir, error }, ctx.locale));
    return { dir: baseDir };
  }

  await notify(t('worktree.auto_creating', undefined, ctx.locale));
  try {
    const slug = ctx.branch ? undefined : await worktreeSlugFromContextAI(ctx.title, ctx.prompt);
    const createOpts = {
      slug,
      branch: ctx.branch,
      worktreePath: ctx.worktreePath,
      reuseExisting: ctx.reuseExisting,
    };
    const committed = ctx.commitCreated
      ? await createRepoWorktreeAndCommit(baseDir, createOpts, async creation => {
          await ctx.commitCreated!(creation);
        })
      : undefined;
    const creation = committed?.creation ?? await createRepoWorktree(baseDir, createOpts);
    logger.info(`[auto-worktree:${larkAppId}] ${baseDir} → ${creation.path} (branch ${creation.branch} from ${creation.baseRef})`);
    // riff：远程沙箱从 origin 克隆，本地新分支必须先推送才能被任务钉住。
    // 推送失败不阻塞（会话仍可用，riff 侧回退默认分支并在卡片注入告警）。
    const botCfg = getBot(larkAppId).config;
    if (resolvePairedSpawnBackendType(
      botCfg.cliId,
      undefined,
      botCfg.backendType,
      config.daemon.backendType,
    ) === 'riff') {
      try {
        await pushWorktreeBranch(creation.path, creation.branch);
      } catch (pe) {
        const perr = pe instanceof Error ? pe.message : String(pe);
        logger.warn(`[auto-worktree:${larkAppId}] riff branch push failed (${creation.branch}): ${perr}`);
        await notify(t('card.repo.riff_worktree_push_failed', { branch: creation.branch, error: perr }, ctx.locale));
      }
    }
    await notify(t('worktree.auto_created', {
      path: creation.path, branch: creation.branch, base: creation.baseRef,
    }, ctx.locale));
    return { dir: creation.path };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (ctx.force) {
      logger.warn(`[auto-worktree:${larkAppId}] explicit worktree creation failed for ${baseDir}: ${error}`);
      await notify(error);
      throw e;
    }
    if (failClosed) {
      logger.warn(`[auto-worktree:${larkAppId}] failed for ${baseDir} (oncall sandbox → fail-closed, refusing base dir): ${error}`);
      throw new AutoWorktreeFailClosedError(error);
    }
    logger.warn(`[auto-worktree:${larkAppId}] failed for ${baseDir}, falling back to base dir: ${error}`);
    await notify(t('worktree.auto_fallback', { dir: baseDir, error }, ctx.locale));
    return { dir: baseDir };
  }
}
