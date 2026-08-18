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
 * UNLESS the file sandbox is enabled, in which case the failure is fail-closed
 * (see {@link AutoWorktreeFailClosedError}): falling back to the real default dir
 * would let the agent's writes land in the real project, defeating the isolation
 * the sandbox promises. The riff REMOTE backend is exempt: it has no local CLI
 * process (the agent runs in riff's own remote sandbox), so the local-escape
 * rationale does not apply and it keeps degrading — matching the worker's
 * `sandboxRequested = !riffRemoteBackend && …`.
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
import { createRepoWorktree, isGitWorkTree, pushWorktreeBranch } from './git-worktree.js';
import { worktreeSlugFromContextAI } from './worktree-slug-ai.js';
import { t } from '../i18n/index.js';
import type { Locale } from '../i18n/types.js';
import { logger } from '../utils/logger.js';

/**
 * Raised when auto-worktree cannot be created AND the file sandbox is enabled
 * on a LOCAL backend. The riff remote backend is exempt (no local CLI process
 * — the agent's writes land in riff's own remote sandbox, never the real local
 * dir), matching the worker's `sandboxRequested = !riffRemoteBackend && …`.
 *
 * The file sandbox (bwrap/Seatbelt DIRECT mode) binds `workingDir` read-write
 * to the REAL host directory — the auto-worktree is the only thing keeping a
 * session's writes out of the real project. Degrading to the base dir on a
 * worktree failure would silently defeat that isolation (the agent's new files
 * would land in the real project — a sandbox escape), so the spawn is refused
 * instead. The caller ({@link import('../im/lark/card-handler.js').runAutoWorktreeCommit})
 * closes the pending session and surfaces `reason` to the chat.
 */
export class AutoWorktreeFailClosedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'AutoWorktreeFailClosedError';
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
 * Never throws on a non-git dir / git failure UNLESS the file sandbox is on
 * (local backend only — riff is exempt, see below): with the sandbox enabled,
 * a fallback to the real default dir would let the agent's writes land in the
 * real project (the sandbox binds workingDir read-write to the host), so the
 * spawn is refused instead of degrading.
 */
export async function maybeCreateDefaultWorktree(
  larkAppId: string,
  baseDir: string,
  ctx: MaybeCreateWorktreeCtx,
): Promise<AutoWorktreeResult> {
  if (!ctx.isBotDefaultDir || !botAutoWorktreeEnabled(larkAppId)) {
    return { dir: baseDir };
  }
  // Fail-closed when the FILE SANDBOX is on: the sandbox wraps the CLI with
  // workingDir bound read-write to the real host dir (DIRECT mode — the sandbox
  // protects everything OUTSIDE the whitelist, not the project itself). The
  // auto-worktree is therefore the only barrier between the agent and the real
  // project; a silent fallback to baseDir on failure would be a sandbox escape.
  //
  // Match the worker's sandboxRequested union EXACTLY (worker.ts):
  //   sandboxRequested = !riffRemoteBackend && (sandbox || readIsolation || BOTMUX_SANDBOX)
  // - `readIsolation` is in the union because the worker still honors it for an
  //   unmigrated BOTS_CONFIG (it's auto-migrated to `sandbox` at daemon startup,
  //   but a read-only config can still carry the legacy flag).
  // - The riff exemption MUST wrap the WHOLE union: riff has no local CLI process
  //   (the agent runs in riff's own remote sandbox, its writes never touch the
  //   real local dir), so the escape rationale does not apply and the old graceful
  //   fallback must keep working for riff bots — even when BOTMUX_SANDBOX=1.
  const failClosed = (() => {
    try {
      const c = getBot(larkAppId).config;
      const riff = resolvePairedSpawnBackendType(
        c.cliId, undefined, c.backendType, config.daemon.backendType,
      ) === 'riff';
      if (riff) return false;
      return c.sandbox === true || c.readIsolation === true || process.env.BOTMUX_SANDBOX === '1';
    } catch { return false; }
  })();
  const notify = async (msg: string) => {
    if (!ctx.notify) return;
    try { await ctx.notify(msg); } catch { /* notices are best-effort — never fail a session start */ }
  };

  // Cheap, network-free precheck: a non-git default dir fails instantly. Post the
  // fallback directly WITHOUT a preceding "creating…" (which would be misleading),
  // and skip the doomed createRepoWorktree call entirely.
  if (!(await isGitWorkTree(baseDir))) {
    const reason = t('worktree.err_not_git', undefined, ctx.locale);
    logger.warn(`[auto-worktree:${larkAppId}] default dir is not a git work tree${failClosed ? ' (fail-closed, refusing base dir)' : ', using it as-is'}: ${baseDir}`);
    if (failClosed) throw new AutoWorktreeFailClosedError(reason);
    await notify(t('worktree.auto_fallback', { dir: baseDir, error: reason }, ctx.locale));
    return { dir: baseDir };
  }

  await notify(t('worktree.auto_creating', undefined, ctx.locale));
  try {
    const slug = await worktreeSlugFromContextAI(ctx.title, ctx.prompt);
    const creation = await createRepoWorktree(baseDir, { slug });
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
    logger.warn(`[auto-worktree:${larkAppId}] failed for ${baseDir}${failClosed ? ' (fail-closed, refusing base dir)' : ', falling back to base dir'}: ${error}`);
    if (failClosed) throw new AutoWorktreeFailClosedError(error);
    await notify(t('worktree.auto_fallback', { dir: baseDir, error }, ctx.locale));
    return { dir: baseDir };
  }
}
