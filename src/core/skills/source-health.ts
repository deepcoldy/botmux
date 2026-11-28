import { statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ResolvedSkill, SessionSkillManifest, SkillDiagnostic, SkillPackage, SkillSource } from './types.js';

export type SkillSourceIssueReason =
  | 'missing_root'
  | 'root_not_directory'
  | 'missing_entrypoint'
  | 'unreadable_source';

export interface UnavailableSkillEntry {
  name: string;
  sourceType: SkillSource['type'];
  sourcePath: string;
  rootDir: string;
  reason: SkillSourceIssueReason;
  detail?: string;
}

export type SkillSourceHealth =
  | { ok: true }
  | { ok: false; reason: SkillSourceIssueReason; detail?: string };

const MISSING_ERRNO_CODES = new Set(['ENOENT', 'ENOTDIR']);
const SOURCE_READ_ERRNO_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP']);

function errorCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : undefined;
}

function errorPath(err: unknown): string | undefined {
  return err && typeof err === 'object' && typeof (err as { path?: unknown }).path === 'string'
    ? (err as { path: string }).path
    : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function skillSourcePath(skill: Pick<SkillPackage, 'rootDir' | 'source'>): string {
  if (skill.source.type === 'local-link' && skill.source.path) return skill.source.path;
  return skill.rootDir;
}

/**
 * Check whether a skill's root directory and entrypoint exist and are readable
 * on disk. Uses `statSync` (following valid symlinks) so both deleted directories
 * and broken symlinks surface cleanly as `missing_root` / `missing_entrypoint`.
 */
export function inspectSkillSourceHealth(
  skill: Pick<SkillPackage, 'rootDir' | 'entrypoint' | 'source'>,
): SkillSourceHealth {
  try {
    const rootStat = statSync(skill.rootDir);
    if (!rootStat.isDirectory()) {
      return { ok: false, reason: 'root_not_directory' };
    }
  } catch (err) {
    const code = errorCode(err);
    if (code && MISSING_ERRNO_CODES.has(code)) {
      return { ok: false, reason: 'missing_root', detail: code };
    }
    return { ok: false, reason: 'unreadable_source', detail: code ?? errorMessage(err) };
  }

  const entrypoint = skill.entrypoint || 'SKILL.md';
  const entryPath = join(skill.rootDir, entrypoint);
  try {
    const entryStat = statSync(entryPath);
    if (!entryStat.isFile()) {
      return { ok: false, reason: 'missing_entrypoint', detail: 'entrypoint_not_file' };
    }
  } catch (err) {
    const code = errorCode(err);
    if (code && MISSING_ERRNO_CODES.has(code)) {
      return { ok: false, reason: 'missing_entrypoint', detail: code };
    }
    return { ok: false, reason: 'unreadable_source', detail: code ?? errorMessage(err) };
  }

  return { ok: true };
}

/**
 * Classify a copy error thrown while materializing a skill into a session
 * delivery directory (e.g. `cpSync` in Claude plugin or Pi skill-root delivery).
 *
 * Returns a `SkillSourceIssueReason` when the failure is caused by a missing or
 * unreadable source (including TOCTOU disappearance or dangling symlinks inside
 * the source tree), or `null` for non-source failures (such as ENOSPC or an
 * unwritable destination directory) so those still surface loudly.
 */
export function classifyMaterializationCopyError(
  err: unknown,
  skill: Pick<SkillPackage, 'rootDir' | 'entrypoint' | 'source'>,
  destParentDir?: string,
): SkillSourceIssueReason | null {
  const health = inspectSkillSourceHealth(skill);
  if (!health.ok) return health.reason;

  const code = errorCode(err);
  if (!code || !SOURCE_READ_ERRNO_CODES.has(code)) return null;

  const failedPath = errorPath(err);
  if (failedPath && destParentDir && isPathInsideOrEqual(destParentDir, failedPath)) {
    // Destination-side failure (e.g. EACCES writing into runtime-skills).
    return null;
  }
  if (failedPath && !isPathInsideOrEqual(skill.rootDir, failedPath)) {
    // Only skip when the error points inside the source tree (or has no path
    // attached while the destination parent is healthy).
    if (destParentDir) {
      try {
        if (!statSync(destParentDir).isDirectory()) return null;
      } catch {
        return null;
      }
    }
  }
  return 'unreadable_source';
}

export function buildUnavailableSkillEntry(
  skill: Pick<SkillPackage, 'name' | 'rootDir' | 'source'>,
  reason: SkillSourceIssueReason,
  detail?: string,
): UnavailableSkillEntry {
  return {
    name: skill.name,
    sourceType: skill.source.type,
    sourcePath: skillSourcePath(skill),
    rootDir: skill.rootDir,
    reason,
    ...(detail ? { detail } : {}),
  };
}

export function repairGuidanceForSkill(entry: Pick<UnavailableSkillEntry, 'name' | 'sourceType'>): string {
  if (entry.sourceType === 'local-link') {
    return `Reinstall in copy mode (\`botmux skills install <path>\` without \`--link\`), or remove/detach it (\`botmux skills remove ${entry.name}\` / \`/skills detach ${entry.name}\`); run \`botmux skills doctor\` to list all broken links.`;
  }
  return `Reinstall or update with \`botmux skills update ${entry.name}\` (or \`botmux skills install <source>\`), or run \`botmux skills doctor\` to inspect broken entries.`;
}

export function formatUnavailableSkillDiagnostic(entry: UnavailableSkillEntry): string {
  const reasonLabel = entry.detail ? `${entry.reason}: ${entry.detail}` : entry.reason;
  return `skill "${entry.name}" (${entry.sourceType}) skipped: source unavailable (${reasonLabel}) at ${entry.sourcePath}. ${repairGuidanceForSkill(entry)}`;
}

export function formatSkillMaterializationError(
  skill: Pick<SkillPackage, 'name' | 'rootDir' | 'source'>,
  err: unknown,
): Error {
  const path = skillSourcePath(skill);
  return new Error(
    `Failed to materialize skill "${skill.name}" (${skill.source.type}) from ${path}: ${errorMessage(err)}. Run \`botmux skills doctor\` or reinstall with \`botmux skills install <path>\`.`,
    { cause: err },
  );
}

export interface SessionSkillPreflightResult {
  manifest: SessionSkillManifest;
  availableSkills: ResolvedSkill[];
  unavailableSkills: UnavailableSkillEntry[];
  diagnostics: string[];
}

/**
 * Inspect every resolved priority skill in `manifest` without short-circuiting
 * on the first broken entry. Unavailable optional priority skills are dropped
 * from `manifest.prioritySkills` and recorded in `manifest.diagnostics` and
 * `unavailableSkills` so session startup can proceed and report every broken
 * skill together.
 */
export function filterAvailableSessionSkills(manifest: SessionSkillManifest): SessionSkillPreflightResult {
  const availableSkills: ResolvedSkill[] = [];
  const unavailableSkills: UnavailableSkillEntry[] = [];
  const skillDiagnostics: SkillDiagnostic[] = [];
  const diagnostics: string[] = [];

  for (const skill of manifest.prioritySkills) {
    const health = inspectSkillSourceHealth(skill);
    if (health.ok) {
      availableSkills.push(skill);
      continue;
    }
    const entry = buildUnavailableSkillEntry(skill, health.reason, health.detail);
    const message = formatUnavailableSkillDiagnostic(entry);
    unavailableSkills.push(entry);
    diagnostics.push(message);
    skillDiagnostics.push({
      level: 'warn',
      code: 'skill_source_missing',
      skillName: skill.name,
      message,
    });
  }

  return {
    manifest: {
      ...manifest,
      prioritySkills: availableSkills,
      diagnostics: [...manifest.diagnostics, ...skillDiagnostics],
    },
    availableSkills,
    unavailableSkills,
    diagnostics,
  };
}

export function mergeUnavailableSkills(
  ...groups: ReadonlyArray<readonly UnavailableSkillEntry[] | undefined>
): UnavailableSkillEntry[] {
  const byName = new Map<string, UnavailableSkillEntry>();
  for (const group of groups) {
    if (!group) continue;
    for (const entry of group) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry);
    }
  }
  return [...byName.values()];
}

const MAX_DETAILED_WARNING_ITEMS = 10;

/**
 * Format a concise, actionable user-visible warning summarizing all unavailable
 * skills skipped during session startup.
 */
export function formatUnavailableSkillsUserWarning(
  entries: readonly UnavailableSkillEntry[],
  locale: 'zh' | 'en' = 'zh',
): string | null {
  if (entries.length === 0) return null;

  const hasLocalLink = entries.some(entry => entry.sourceType === 'local-link');
  const detailed = entries.slice(0, MAX_DETAILED_WARNING_ITEMS);
  const remaining = entries.slice(MAX_DETAILED_WARNING_ITEMS);

  if (locale === 'en') {
    const lines = [
      `⚠️ Skipped ${entries.length} unavailable Skill${entries.length === 1 ? '' : 's'} (session started normally with the remaining intact Skills):`,
      ...detailed.map(entry => `- ${entry.name} (${entry.sourceType}, ${entry.reason}): ${entry.sourcePath}`),
    ];
    if (remaining.length > 0) {
      lines.push(`- …and ${remaining.length} more: ${remaining.map(entry => entry.name).join(', ')}`);
    }
    if (hasLocalLink) {
      lines.push(
        'How to fix: if these local-link entries pointed into a versioned plugin cache (such as `.claude/plugins/cache/...`), reinstall them in copy mode with `botmux skills install <new-path>` (without `--link`), or remove/detach unused entries (`botmux skills remove <name>` / `/skills detach <name>`). Run `botmux skills doctor` to inspect all broken links.',
      );
    } else {
      lines.push(
        'How to fix: reinstall or update with `botmux skills update <name>` / `botmux skills install <source>`, or run `botmux skills doctor` to inspect all broken entries.',
      );
    }
    return lines.join('\n');
  }

  const lines = [
    `⚠️ 已跳过 ${entries.length} 个源路径失效的 Skill（其余完好 Skill 照常加载，会话已正常启动）：`,
    ...detailed.map(entry => `- ${entry.name}（${entry.sourceType}，${entry.reason}）：${entry.sourcePath}`),
  ];
  if (remaining.length > 0) {
    lines.push(`- 另有 ${remaining.length} 个失效项：${remaining.map(entry => entry.name).join('、')}`);
  }
  if (hasLocalLink) {
    lines.push(
      '修复方式：若链接指向插件版本缓存目录（如 `.claude/plugins/cache/...`），请改用复制模式重新安装 `botmux skills install <新路径>`（不要加 `--link`），或清理不再需要的引用（`botmux skills remove <name>` / `/skills detach <name>`）；运行 `botmux skills doctor` 可查看全部失效项。',
    );
  } else {
    lines.push(
      '修复方式：请运行 `botmux skills update <name>` 或 `botmux skills install <source>` 重新安装；运行 `botmux skills doctor` 可查看全部失效项。',
    );
  }
  return lines.join('\n');
}
