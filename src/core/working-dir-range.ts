/**
 * A bot's configured directory range (design 2026-11-03 §15.4): the
 * directories its configuration names for sessions — the effective default
 * working dir (`defaultWorkingDir`, or the Oncall-mode `defaultOncall.workingDir`)
 * plus the repo roots (`workingDir` / `workingDirs`). A directory is in range
 * when it is one of them or lies below one.
 *
 * This is the ONE place that answers "may this bot be asked to work in that
 * directory": Gate-2 (`approve-dag --working-dir` for bot-executed nodes, in
 * the CLI) and the executing bot's daemon (when it starts the node session,
 * against its configuration at that moment) both call it.
 *
 * Normalisation follows the existing working-dir rules: `~` expansion and
 * `resolve` as {@link validateWorkingDir} / `configuredWorkingDirs` do (so a
 * trailing slash or `..` makes no difference), existence + is-a-directory as
 * {@link validateWorkingDir} checks (never created), and symlinks resolved on
 * both sides (`realpath`, as the sandbox's own path checks do) before the
 * containment test — a link inside the range that points outside it is out of
 * range, and macOS's `/tmp` → `/private/tmp` style links compare equal.
 *
 * An accepted directory is returned as its realpath, and that is what gets
 * frozen and started in: a symlink is followed once, here, and its target is
 * used from then on. Keeping the link itself would let whoever controls the
 * link retarget it after the check — and a session restart, cold resume or
 * `/restart` starts the CLI in the stored path without checking it again.
 */

import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { coversPath, normalizeFsPath } from '../adapters/cli/fs-policy.js';
import { effectiveDefaultWorkingDir, type BotConfig } from '../bot-registry.js';
import { configuredWorkingDirs, expandHomePath } from '../utils/working-dir.js';

export type BotWorkingDirConfig = Pick<BotConfig, 'defaultWorkingDir' | 'defaultOncall' | 'workingDir' | 'workingDirs'>;

export type BotWorkingDirVerdict =
  /** `path` is the directory's realpath: what to freeze and start in. */
  | { ok: true; path: string }
  /** `path` is the directory as given (absolute, lexical), for the message. */
  | { ok: false; path: string; reason: 'missing' | 'not_directory' | 'no_range' | 'outside_range' };

/** The configured roots, as written in the config (`~` not expanded). */
function botWorkingDirRoots(cfg: BotWorkingDirConfig): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const raw of [effectiveDefaultWorkingDir(cfg as BotConfig), ...configuredWorkingDirs(cfg)]) {
    if (!raw) continue;
    const key = resolve(expandHomePath(raw));
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(raw);
  }
  return roots;
}

/** `path` (absolute) with every symlink resolved; a path that cannot be
 *  resolved (gone, unreadable) stays as it is. The same comparison form the
 *  range check uses. */
export function realWorkingDir(path: string): string {
  let real: string;
  try { real = realpathSync(path); } catch { real = path; }
  return normalizeFsPath(real) ?? real;
}

/** Is `dir` an existing directory inside `cfg`'s configured range? */
export function checkBotWorkingDir(cfg: BotWorkingDirConfig, dir: string): BotWorkingDirVerdict {
  const path = resolve(expandHomePath(dir));
  try {
    if (!statSync(path).isDirectory()) return { ok: false, path, reason: 'not_directory' };
  } catch {
    return { ok: false, path, reason: 'missing' };
  }
  const roots = botWorkingDirRoots(cfg);
  if (roots.length === 0) return { ok: false, path, reason: 'no_range' };
  const target = realWorkingDir(path);
  const inside = roots.some((root) => coversPath(realWorkingDir(resolve(expandHomePath(root))), target));
  return inside ? { ok: true, path: target } : { ok: false, path, reason: 'outside_range' };
}

const REASON_TEXT: Record<Exclude<BotWorkingDirVerdict, { ok: true }>['reason'], string> = {
  missing: '目录不存在',
  not_directory: '不是目录',
  no_range: '这个 Bot 没有配置目录范围（默认工作目录 / 仓库目录）',
  outside_range: '不在这个 Bot 配置的目录范围内（默认工作目录 / 仓库目录）',
};

/** One user-facing reason for a refused directory (no other bot's paths). */
export function describeBotWorkingDirRefusal(verdict: Exclude<BotWorkingDirVerdict, { ok: true }>): string {
  return REASON_TEXT[verdict.reason];
}

/** A session's working directory in the form a node's frozen directory is
 *  compared with (`~` expanded, resolved, symlinks resolved). */
export function comparableSessionDir(dir: string): string {
  return realWorkingDir(resolve(expandHomePath(dir)));
}

/** The bot turns its default working dir into a per-session worktree BASE
 *  (`defaultWorkingDirAutoWorktree`), so that dir is never a launch dir. */
export function botConfigUsesAutoWorktree(cfg: Pick<BotConfig, 'defaultWorkingDir' | 'defaultWorkingDirAutoWorktree'>): boolean {
  return cfg.defaultWorkingDirAutoWorktree === true && !!cfg.defaultWorkingDir;
}

/**
 * Where a session of this bot that never pinned a directory runs (not yet
 * `~`-expanded): the effective default working dir — unless it is an
 * auto-worktree base — else the legacy `workingDir`, else `~`. The one rule
 * `getSessionWorkingDir` (daemon) and the workflow Gate-2 main-session check
 * (a CLI process, from bots.json) both apply.
 */
export function unpinnedSessionWorkingDir(cfg: BotConfig, autoWorktree: boolean = botConfigUsesAutoWorktree(cfg)): string {
  if (!autoWorktree) {
    const botDefault = effectiveDefaultWorkingDir(cfg);
    if (botDefault) return botDefault;
  }
  return cfg.workingDir ?? '~';
}

/** The operate answer {@link checkNodeWorkingDir} is given (kept literal so
 *  this module needs no workflow imports). */
export type NodeWorkingDirOperate = 'yes' | 'no' | { unknown: string };

/** A {@link checkBotWorkingDir} verdict for a workflow node; a range refusal
 *  may carry why the initiator's operate right could not be confirmed. */
export type NodeWorkingDirVerdict =
  | Extract<BotWorkingDirVerdict, { ok: true }>
  | (Extract<BotWorkingDirVerdict, { ok: false }> & { operateUnknown?: string });

/**
 * A workflow node's Gate-2 directory on its executing bot (design §15.4):
 * when the run's initiator may operate that bot — may use `/cd` there, so
 * could move a session anywhere themselves — the directory only has to exist
 * (as for `/cd` and `/repo <路径>`); otherwise it must lie in the bot's
 * configured range ({@link checkBotWorkingDir}). Gate-2 and the executing
 * bot's daemon both decide through this one function.
 *
 * `initiatorOperates` is asked only when the range alone refuses an existing
 * directory (it may need a Lark lookup or daemon IPC). An `unknown` answer
 * decides like `no` (the range applies) but is kept on the refusal, so the
 * message can say it could not be confirmed. An accepted directory is its
 * realpath, as always.
 */
export async function checkNodeWorkingDir(
  cfg: BotWorkingDirConfig,
  dir: string,
  initiatorOperates: () => Promise<NodeWorkingDirOperate>,
): Promise<NodeWorkingDirVerdict> {
  const verdict = checkBotWorkingDir(cfg, dir);
  if (verdict.ok || verdict.reason === 'missing' || verdict.reason === 'not_directory') return verdict;
  let operates: NodeWorkingDirOperate;
  try { operates = await initiatorOperates(); } catch { operates = { unknown: '查询出错' }; }
  if (operates === 'yes') return { ok: true, path: realWorkingDir(verdict.path) };
  if (operates === 'no') return verdict;
  return { ...verdict, operateUnknown: typeof operates === 'object' && operates?.unknown ? operates.unknown : '查询结果无效' };
}
