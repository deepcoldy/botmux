/**
 * `/repo <arg>` 的仓库解析 —— 从「路径或项目名」得到一个具体目录 + 展示名。
 *
 * 独立成 leaf 模块（原本长在 command-handler.ts 里）：话题指令头的规格解析器
 * `topic-spec.ts` 需要它，而 command-handler 会把整张 daemon 依赖图拖进来，纯函数
 * 单测就得先铺几百行 mock。沿用 `validateWorkingDir` → working-dir.ts 的既有惯例：
 * 真身放 leaf，command-handler 重新导出给存量调用方。
 */
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { scanMultipleProjects, describeProjectDir } from '../services/project-scanner.js';
import { expandHome } from './working-dir.js';

/**
 * Resolve a non-numeric `/repo <arg>` into a concrete repo path + display name.
 * `arg` is either a path (absolute or relative) or a first-level project name
 * under one of the bot's scan dirs — letting the user skip the selection card.
 *
 * Resolution:
 *   1. Build candidate absolute paths — absolute / `~` taken as-is; relative or
 *      bare names resolved against each scan dir, then the daemon cwd (mirrors
 *      how the card's project list is rooted).
 *   2. Return the first directly existing candidate, describing its git ref
 *      without scanning unrelated roots. This is lenient like `/cd`, whose trust
 *      model is "owner explicitly chose a dir"; the CLI already runs with full
 *      FS access.
 *   3. Only for a bare name that did not directly resolve, scan projects and
 *      match by basename (covers projects nested deeper than the scan-dir top
 *      level).
 * Returns null when nothing resolves to an existing directory.
 */
export function resolveRepoSelection(
  repoArg: string,
  scanDirs: string[],
): { path: string; displayName: string } | null {
  const isExplicitPath =
    repoArg.startsWith('/') ||
    repoArg.startsWith('~') ||
    repoArg.startsWith('.') ||
    repoArg.includes('/');

  const candidates: string[] = [];
  if (repoArg.startsWith('/') || repoArg.startsWith('~')) {
    candidates.push(resolve(expandHome(repoArg)));
  } else {
    for (const d of scanDirs) candidates.push(resolve(d, repoArg));
    candidates.push(resolve(expandHome(repoArg))); // daemon-cwd fallback (matches /cd)
  }

  // Direct candidates must win before any recursive scan. Besides avoiding
  // unnecessary traversal (especially a legacy HOME fallback), describing just
  // the selected directory preserves the same "name (branch)" label for repos.
  for (const cand of candidates) {
    try {
      if (!statSync(cand).isDirectory()) continue;
    } catch {
      continue; // missing / not a dir — try next candidate
    }
    const desc = describeProjectDir(cand);
    return desc
      ? { path: cand, displayName: `${desc.name} (${desc.branch})` }
      : { path: cand, displayName: basename(cand) };
  }

  // Explicit and relative paths have no basename-search semantics: when their
  // concrete candidates do not exist, a recursive project scan cannot resolve
  // them. Bare names alone may refer to a repo nested below a scan root.
  if (isExplicitPath) return null;

  const existingScanDirs = scanDirs.filter((d) => existsSync(d));
  const projects = existingScanDirs.length > 0 ? scanMultipleProjects(existingScanDirs) : [];
  const byName = projects.find((p) => p.name === repoArg);
  if (byName) return { path: byName.path, displayName: `${byName.name} (${byName.branch})` };

  return null;
}
