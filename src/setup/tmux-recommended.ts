/**
 * The ONE place that says which tmux botmux recommends.
 *
 * Everything that talks about "your tmux is too old" — the owner DM card, the
 * one-click upgrade's success check, the `botmux start`/`restart` dependency
 * report and `botmux status` — reads `TMUX_RECOMMENDED_MIN` from here. To raise
 * the bar later, change `version` and rewrite `why` to the new reason; nothing
 * else needs to move.
 *
 * This is a RECOMMENDATION, not a gate: a tmux that passes the functional probe
 * keeps working below it (ensure-tmux.ts never refuses to start over it).
 *
 * Why 3.4 (facts checked 2026-11-19 against tmux CHANGES and the package
 * indexes; keep this note in sync when bumping):
 *  - tmux ≤ 3.3a dereferences a NULL event when `paste-buffer` targets a pane
 *    whose program already exited (remain-on-exit keeps the pane), so the
 *    SHARED server dies with SIGSEGV and every session on it goes down. Fixed
 *    upstream by 4bdb855 ("Don't allow paste-buffer into dead panes"), first
 *    released in 3.4. botmux ≥ 3.59.21 also guards its own pastes atomically,
 *    but a server that crashes on one stray command is still a liability.
 *  - Nothing in 3.5 … 3.8 fixes a crash on a path botmux drives (paste, send-
 *    keys, pipe-pane, capture-pane, display-message, remain-on-exit). 3.5 even
 *    regressed run-shell/if-shell onto `default-shell` (reverted in 3.5a), so
 *    "newer" is not automatically "safer" for us.
 *  - Ubuntu 24.04 LTS ships exactly 3.4 and Alpine 3.20 ships 3.4: recommending
 *    3.5a+ would nag the most common LTS hosts about something their package
 *    manager cannot deliver. Hosts that stay below 3.4 even after a package
 *    upgrade: Debian 12 (3.3a; bookworm-backports has 3.5a), Ubuntu 22.04
 *    (3.2a), RHEL/Rocky/Alma 9 (3.2a), CentOS Stream 10 (3.3a), openEuler
 *    24.03 LTS (3.3a). Homebrew / conda-forge / Arch are on 3.8.
 */
import type { Locale } from '../i18n/types.js';

export interface TmuxRecommendation {
  /** Minimum recommended release, exactly as `tmux -V` prints it (no "tmux "). */
  version: string;
  /** One plain-language sentence per locale: what goes wrong below it. */
  why: Record<Locale, string>;
}

export const TMUX_RECOMMENDED_MIN: TmuxRecommendation = {
  version: '3.4',
  why: {
    zh: 'tmux 3.4 之前的版本有一个已知缺陷：往一个程序已经退出的终端窗口里粘贴内容时，整个 tmux 服务会直接崩溃，跑在上面的所有 botmux 会话会一起中断。tmux 3.4 修复了这个问题。',
    en: 'tmux releases before 3.4 have a known bug: pasting into a terminal pane whose program has already exited crashes the whole tmux server, and every botmux session running on it goes down at once. tmux 3.4 fixes it.',
  },
};

/** A tmux release as `tmux -V` reports it: `3.3a` → {3, 3, 'a'}. */
export interface TmuxRelease {
  major: number;
  minor: number;
  /** Letter suffix of a point release (`a`, `b`, …); '' for none. */
  suffix: string;
}

/**
 * Parse `tmux -V` output (`tmux 3.3a`, `tmux next-3.6`, `tmux 3.8`) or a bare
 * version (`3.5a`). Distro packaging noise after the release (`3.3a_git…`,
 * `-rc`) is ignored. Builds that print no release number (`tmux master`)
 * return null — unknown, never "too old".
 */
export function parseTmuxRelease(raw: string | null | undefined): TmuxRelease | null {
  const match = /(\d+)\.(\d+)([a-z]?)/.exec(String(raw ?? ''));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), suffix: match[3] ?? '' };
}

/** -1 / 0 / 1 ordering; `3.3` < `3.3a` < `3.3b` < `3.4`. */
export function compareTmuxRelease(a: TmuxRelease, b: TmuxRelease): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.suffix === b.suffix) return 0;
  return a.suffix < b.suffix ? -1 : 1;
}

/** Release label without the `tmux ` prefix (`tmux 3.3a` → `3.3a`). */
export function tmuxReleaseLabel(raw: string | null | undefined): string | null {
  const parsed = parseTmuxRelease(raw);
  return parsed ? `${parsed.major}.${parsed.minor}${parsed.suffix}` : null;
}

/**
 * True only for a KNOWN release strictly below the recommendation. An
 * unreadable / unparseable version is never reported as too old: nagging the
 * owner about a version we could not read would be a false alarm.
 */
export function isTmuxBelowRecommended(
  raw: string | null | undefined,
  recommendation: TmuxRecommendation = TMUX_RECOMMENDED_MIN,
): boolean {
  const current = parseTmuxRelease(raw);
  const minimum = parseTmuxRelease(recommendation.version);
  if (!current || !minimum) return false;
  return compareTmuxRelease(current, minimum) < 0;
}

/**
 * The console line `botmux start` / `restart` / `status` print for a tmux
 * below the recommendation, or null when there is nothing to say. Advisory
 * only — callers must not refuse to start over it.
 */
export function tmuxRecommendationWarning(
  rawVersion: string | null | undefined,
  locale: Locale = 'zh',
  recommendation: TmuxRecommendation = TMUX_RECOMMENDED_MIN,
): string | null {
  if (!isTmuxBelowRecommended(rawVersion, recommendation)) return null;
  const current = tmuxReleaseLabel(rawVersion) ?? String(rawVersion);
  return locale === 'en'
    ? `⚠️  tmux ${current} is below the recommended ${recommendation.version} (botmux keeps working). ${recommendation.why.en} The primary bot's owner gets a Feishu card with a one-click upgrade.`
    : `⚠️  tmux ${current} 低于推荐版本 ${recommendation.version}（不影响启动）。${recommendation.why.zh} 主 bot 的 owner 会在飞书收到一张可一键升级的提醒卡片。`;
}
