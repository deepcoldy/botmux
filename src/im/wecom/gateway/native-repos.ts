/**
 * The repositories `/repo` offers: the git projects under the connection's
 * working root, found the way the Feishu `/repo` finds them (project-scanner,
 * depth 3, the machine's repo-picker options and the scanner's own directory
 * and time budgets). Only projects whose real path is inside the real working
 * root count: a symlink or a linked worktree that leads outside it is left out.
 * Replies name a repository by its path relative to the root, never by a host
 * path.
 */
import { realpathSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describeProjectDir, scanMultipleProjects, type ProjectScanOptions } from '../../../services/project-scanner.js';
import { repoPickerScanOptions } from '../../../global-config.js';
import { clipWecomStream } from './text-chunks.js';
import { wecomPathInside } from './path-inside.js';

export interface WecomRepository {
  name: string;
  branch: string;
  /** Relative to the real working root; `.` is the root itself. */
  path: string;
  /** Real path. Stays in the gateway, never in a reply. */
  directory: string;
}

export type WecomRepositoryScan =
  /** No working root is configured, or it is missing or not a directory. */
  | { ok: false }
  /** `incomplete`: a scan budget ran out, so repositories may be missing. */
  | { ok: true; repositories: WecomRepository[]; incomplete: boolean };

function realRoot(root: string | undefined): string | undefined {
  if (!root) {
    return;
  }
  try {
    const base = realpathSync(root);
    return statSync(base).isDirectory() ? base : undefined;
  } catch {
    return;
  }
}

/** `budget` (tests) overrides the scanner's directory / time budget. */
export function scanWecomRepositories(
  root: string | undefined,
  budget: Pick<ProjectScanOptions, 'maxScanDirs' | 'maxScanMs'> = {},
): WecomRepositoryScan {
  const base = realRoot(root);
  if (!base) {
    return { ok: false };
  }
  let incomplete = false;
  const projects = scanMultipleProjects([base], 3, {
    ...repoPickerScanOptions(),
    ...budget,
    onBudgetExceeded: () => {
      incomplete = true;
    },
  });
  const repositories: WecomRepository[] = [];
  for (const project of projects) {
    let directory: string;
    try {
      directory = realpathSync(project.path);
    } catch {
      continue;
    }
    if (!wecomPathInside(base, directory) || repositories.some(repo => repo.directory === directory)) {
      continue;
    }
    repositories.push({
      name: project.name,
      branch: project.branch,
      path: relative(base, directory) || '.',
      directory,
    });
  }
  return { ok: true, repositories, incomplete };
}

/** Listing replies stay well inside one stream frame (20480 bytes). */
const LISTING_BYTES = 16000;

/** The reply to a bare `/repo`. */
export function wecomRepositoryListing(scan: WecomRepositoryScan): string {
  if (!scan.ok) {
    return '工作目录不可用，无法列出仓库。';
  }
  if (!scan.repositories.length) {
    return scan.incomplete
      ? '工作目录过大，扫描在上限内没有找到 git 仓库；请缩小工作目录范围。'
      : '工作目录下没有找到 git 仓库。';
  }
  const lines = ['可选仓库（发送 /repo 序号、名称或相对路径选择）：'];
  let shown = 0;
  for (const [index, repo] of scan.repositories.entries()) {
    const line = `${index + 1}. ${repo.name}（${repo.branch}）· ${repo.path}`;
    if (Buffer.byteLength([...lines, line].join('\n')) > LISTING_BYTES) {
      break;
    }
    lines.push(line);
    shown++;
  }
  if (shown < scan.repositories.length) {
    lines.push(`另有 ${scan.repositories.length - shown} 个未列出，可按名称或相对路径选择。`);
  }
  if (scan.incomplete) {
    lines.push('工作目录较大，扫描已达上限，列表可能不全。');
  }
  return clipWecomStream(lines.join('\n'));
}

/**
 * The repositories `/repo <name|relative path>` names in `scan`: a repository
 * whose name is `arg`, and the one whose real path is `arg` resolved against the
 * root. More than one means the argument is ambiguous.
 */
export function wecomRepositoryMatches(scan: WecomRepositoryScan, root: string | undefined, arg: string): WecomRepository[] {
  const base = realRoot(root);
  if (!scan.ok || !base) {
    return [];
  }
  let target: string | undefined;
  try {
    target = realpathSync(resolve(base, arg));
  } catch { /* not a path under the root */ }
  return scan.repositories.filter(repo => repo.name === arg || repo.directory === target);
}

/**
 * Whether `repo`, found by an earlier scan, is still a git project at the same
 * real path inside the real working root — checked when it is selected, and
 * again when a new session is about to be created in it.
 */
export function wecomRepositoryStillValid(repo: Pick<WecomRepository, 'directory'>, root: string | undefined): boolean {
  const base = realRoot(root);
  if (!base) {
    return false;
  }
  try {
    const directory = realpathSync(repo.directory);
    return directory === repo.directory
      && wecomPathInside(base, directory)
      && statSync(directory).isDirectory()
      && describeProjectDir(directory) !== null;
  } catch {
    return false;
  }
}
