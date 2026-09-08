import { mkdirSync, existsSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { BUILTIN_SKILLS, RETIRED_SKILL_NAMES, WORKFLOW_FEATURE_SKILLS, ASK_SKILL, ASK_SKILL_NAME, WHITEBOARD_SKILL, WHITEBOARD_SKILL_NAME } from './definitions.js';
import { effectiveBuiltinSkills, isBuiltinSkillBodyOverridden } from './effective-builtins.js';
import { SEND_SKILL_SESSION_LOADER } from './reply-style-guide.js';

// This module only manages botmux-owned bridge/ask skills. User-defined skills
// live in src/core/skills/* and services/skill-registry-store.ts so their
// lifecycle stays independent of any specific CLI's global skill directory.

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/** Claude Code plugin manifest written to `{pluginDir}/.claude-plugin/plugin.json`.
 *  `name` is the only required field; it namespaces the bundled skills. */
const PLUGIN_MANIFEST = JSON.stringify({
  name: 'botmux',
  description: 'botmux 飞书话题桥接内置 skill —— 仅在 botmux 拉起的会话内通过 --plugin-dir 注入，不写入全局 ~/.claude/skills。',
  version: '1.0.0',
  author: { name: 'botmux' },
}, null, 2) + '\n';

/**
 * Materialise the built-in skills as a Claude Code *plugin* under `pluginDir`,
 * so they can be injected per-session via `--plugin-dir` instead of polluting
 * the user's global `~/.claude/skills`. Writes:
 *   - {pluginDir}/.claude-plugin/plugin.json   (manifest, name='botmux')
 *   - {pluginDir}/skills/<name>/SKILL.md        (one per built-in skill)
 * Idempotent — only writes when content differs. Skill files are written by
 * reusing `ensureSkills` against `{pluginDir}/skills` (same flat layout).
 */
export function ensurePluginSkills(cliId: string, pluginDir: string | undefined): void {
  if (!pluginDir) return;
  const root = expandHome(pluginDir);
  const manifestDir = join(root, '.claude-plugin');
  const manifestFile = join(manifestDir, 'plugin.json');
  try {
    mkdirSync(manifestDir, { recursive: true });
    if (!(existsSync(manifestFile) && readFileSync(manifestFile, 'utf-8') === PLUGIN_MANIFEST)) {
      atomicWriteFileSync(manifestFile, PLUGIN_MANIFEST);
      logger.info(`[skills] Wrote plugin manifest for ${cliId} → ${manifestFile}`);
    }
  } catch (err: any) {
    logger.warn(`[skills] Failed to write plugin manifest for ${cliId}: ${err.message}`);
  }
  ensureSkills(cliId, join(root, 'skills'));
}

/**
 * Remove botmux-owned skill directories that earlier versions installed into a
 * shared global skills dir (e.g. `~/.claude/skills`). Once skills move to a
 * per-session plugin dir, these stale global copies would keep leaking into the
 * user's standalone CLI sessions, so we delete them on upgrade.
 *
 * Matches by the `botmux-` directory-name prefix (the namespace botmux owns)
 * rather than the static `BUILTIN_SKILLS` list — a daemon may have previously
 * installed skills that a *different* botmux version shipped (e.g.
 * `botmux-handoff`), and those must be cleaned too. Non-`botmux-` user skills
 * are never touched.
 */
export function removeGlobalBotmuxSkills(globalSkillsDir: string | undefined): void {
  if (!globalSkillsDir) return;
  const dir = expandHome(globalSkillsDir);
  if (!existsSync(dir)) return;
  let names: string[];
  try { names = readdirSync(dir); }
  catch (err: any) { logger.warn(`[skills] Failed to scan ${dir}: ${err.message}`); return; }
  for (const name of names) {
    if (!name.startsWith('botmux-')) continue;
    const skillDir = join(dir, name);
    let isDir = false;
    try { isDir = statSync(skillDir).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    try {
      rmSync(skillDir, { recursive: true, force: true });
      logger.info(`[skills] Removed leaked global skill ${name} → ${skillDir}`);
    } catch (err: any) {
      logger.warn(`[skills] Failed to remove leaked global skill ${name}: ${err.message}`);
    }
  }
}

/**
 * 条件管理 `botmux-ask` skill —— hook 优先 + 非 hook CLI 兜底策略。
 *
 * - `install=false`（CLI 支持 hook 接管 askUserQuestion）：删除该 skill，避免
 *   skill 与 hook 双重弹卡 / 抢工具。
 * - `install=true`（CLI 无 hook 接管能力）：写入该 skill，让 agent 至少能用
 *   `botmux ask buttons` 把选择题引到飞书（不如 hook 可靠，但有得用）。
 *
 * 幂等：install 时内容相同则跳过；remove 时不存在则跳过。
 */
export function ensureAskSkill(cliId: string, skillsDir: string | undefined, install: boolean): void {
  if (!skillsDir) return;
  const skillDir = join(expandHome(skillsDir), ASK_SKILL_NAME);
  const skillFile = join(skillDir, 'SKILL.md');
  try {
    if (install) {
      if (existsSync(skillFile) && readFileSync(skillFile, 'utf-8') === ASK_SKILL) return;
      mkdirSync(skillDir, { recursive: true });
      atomicWriteFileSync(skillFile, ASK_SKILL);
      logger.info(`[skills] Installed ${ASK_SKILL_NAME} (无 hook 接管，兜底) for ${cliId} → ${skillFile}`);
    } else {
      if (!existsSync(skillDir)) return;
      rmSync(skillDir, { recursive: true, force: true });
      logger.info(`[skills] Removed ${ASK_SKILL_NAME} (hook 已接管) for ${cliId}`);
    }
  } catch (err: any) {
    logger.warn(`[skills] ensureAskSkill(${install}) failed for ${cliId}: ${err.message}`);
  }
}

/**
 * 条件管理 `botmux-whiteboard` skill —— 跟随白板能力开关（与 {@link ensureAskSkill}
 * 同构）。白板默认关闭，是可选增强，所以它的 skill 不进 `BUILTIN_SKILLS`（那会被
 * 无条件安装），而是按开关动态写入 / 删除：
 *
 * - `install=true`（白板已开启）：写入 SKILL.md，让 agent 看得到并能用
 *   `botmux whiteboard read/update`。
 * - `install=false`（白板关闭）：删除该 skill 目录，避免给 agent 暴露一个当前
 *   用不了（CLI 读写会被拒）的能力；也清理旧版本无条件装下的残留。
 *
 * 由 worker-pool 的 `ensureCliSkills` 在每次 spawn 时按 `whiteboardEnabled()`
 * 调用（不走一次性缓存），所以运行时切换开关下一个会话即生效，无需重启 daemon。
 * 幂等：install 时内容相同则跳过；remove 时不存在则跳过。
 */
export function ensureWhiteboardSkill(cliId: string, skillsDir: string | undefined, install: boolean): void {
  if (!skillsDir) return;
  const skillDir = join(expandHome(skillsDir), WHITEBOARD_SKILL_NAME);
  const skillFile = join(skillDir, 'SKILL.md');
  try {
    if (install) {
      if (existsSync(skillFile) && readFileSync(skillFile, 'utf-8') === WHITEBOARD_SKILL) return;
      mkdirSync(skillDir, { recursive: true });
      atomicWriteFileSync(skillFile, WHITEBOARD_SKILL);
      logger.info(`[skills] Installed ${WHITEBOARD_SKILL_NAME} (whiteboard enabled) for ${cliId} → ${skillFile}`);
    } else {
      if (!existsSync(skillDir)) return;
      rmSync(skillDir, { recursive: true, force: true });
      logger.info(`[skills] Removed ${WHITEBOARD_SKILL_NAME} (whiteboard disabled) for ${cliId}`);
    }
  } catch (err: any) {
    logger.warn(`[skills] ensureWhiteboardSkill(${install}) failed for ${cliId}: ${err.message}`);
  }
}

/**
 * 条件管理 v3 Workflow skill 家族（`botmux-workflow` / `botmux-workflow-create` /
 * `botmux-goal-ask`）—— 跟随机器级 workflow 开关（与 {@link ensureWhiteboardSkill}
 * 同构）。这三个 skill 不进 `BUILTIN_SKILLS`（那会被无条件安装），而是按开关动态
 * 写入 / 删除：
 *
 * - `install=true`（workflow 功能开启，默认）：写入每个 SKILL.md，让 agent 看得到
 *   并能用 `/workflow` / botmux-workflow 能力。
 * - `install=false`（workflow 功能关闭）：删除这三个 skill 目录，避免给 agent 暴露
 *   一个当前会被 daemon/CLI 拒绝的能力；也清理旧版本无条件装下的残留。
 *
 * `botmux-orchestrate` 不在此列——它是独立的多 bot 长期编排能力，不随本开关关闭。
 *
 * 由 worker-pool 的 `ensureCliSkills` 在每次 spawn 时按 `isWorkflowFeatureEnabled()`
 * 调用（不走一次性缓存），所以运行时切换开关下一个会话即生效，无需重启 daemon。
 * 幂等：install 时内容相同则跳过；remove 时不存在则跳过。
 */
export function ensureWorkflowSkills(cliId: string, skillsDir: string | undefined, install: boolean): void {
  if (!skillsDir) return;
  const base = expandHome(skillsDir);
  for (const skill of WORKFLOW_FEATURE_SKILLS) {
    const skillDir = join(base, skill.name);
    const skillFile = join(skillDir, 'SKILL.md');
    try {
      if (install) {
        if (existsSync(skillFile) && readFileSync(skillFile, 'utf-8') === skill.content) continue;
        mkdirSync(skillDir, { recursive: true });
        atomicWriteFileSync(skillFile, skill.content);
        logger.info(`[skills] Installed ${skill.name} (workflow enabled) for ${cliId} → ${skillFile}`);
      } else {
        if (!existsSync(skillDir)) continue;
        rmSync(skillDir, { recursive: true, force: true });
        logger.info(`[skills] Removed ${skill.name} (workflow disabled) for ${cliId}`);
      }
    } catch (err: any) {
      logger.warn(`[skills] ensureWorkflowSkills(${install}) failed for ${skill.name} on ${cliId}: ${err.message}`);
    }
  }
}

/**
 * Install (or refresh) the built-in skill library into the given CLI's skills
 * directory. Idempotent — only writes when content differs.
 *
 * Each skill becomes {skillsDir}/<name>/SKILL.md. Sub-directory layout
 * matches Claude Code / Gemini / OpenCode convention. Retired skills (renamed
 * or removed in a later version) are deleted from the directory so the CLI
 * doesn't keep surfacing stale entries alongside their replacements.
 */
export function ensureSkills(cliId: string, skillsDir: string | undefined): void {
  if (!skillsDir) return;
  const dir = expandHome(skillsDir);
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

  // Apply user overrides: replaced bodies + user-disabled skills removed. The
  // shipped botmux-send body is the one exception to direct materialisation:
  // shared skill dirs receive a stable loader, while `botmux skill show` renders
  // the per-session guide from BOTMUX_REPLY_STYLE. Explicit user bodies still
  // win and are written verbatim.
  const effective = effectiveBuiltinSkills([...BUILTIN_SKILLS]).map((skill) => {
    if (skill.name !== 'botmux-send' || isBuiltinSkillBodyOverridden(skill.name)) return skill;
    return { ...skill, content: SEND_SKILL_SESSION_LOADER };
  });
  const effectiveNames = new Set(effective.map((s) => s.name));

  for (const skill of effective) {
    const skillDir = join(dir, skill.name);
    const skillFile = join(skillDir, 'SKILL.md');
    try {
      if (existsSync(skillFile)) {
        const current = readFileSync(skillFile, 'utf-8');
        if (current === skill.content) continue;
      }
      mkdirSync(skillDir, { recursive: true });
      // 原子写：多个 daemon 启动时并发刷同一份共享 skill 文件，CLI spawn 同时在读。
      atomicWriteFileSync(skillFile, skill.content);
      logger.info(`[skills] Installed ${skill.name} for ${cliId} → ${skillFile}`);
    } catch (err: any) {
      logger.warn(`[skills] Failed to install ${skill.name} for ${cliId}: ${err.message}`);
    }
  }

  // Remove a built-in skill's dir when the user has DISABLED it (present in the
  // shipped set but dropped from the effective set). Without this, a global-mode
  // CLI would keep injecting a skill the user turned off (stale file on disk).
  for (const shipped of BUILTIN_SKILLS) {
    if (effectiveNames.has(shipped.name)) continue;
    const disabledDir = join(dir, shipped.name);
    if (!existsSync(disabledDir)) continue;
    try {
      rmSync(disabledDir, { recursive: true, force: true });
      logger.info(`[skills] Removed user-disabled built-in skill ${shipped.name} for ${cliId}`);
    } catch (err: any) {
      logger.warn(`[skills] Failed to remove disabled skill ${shipped.name} for ${cliId}: ${err.message}`);
    }
  }

  // Clean up retired skill directories (e.g. botmux-thread-messages → botmux-history).
  for (const retired of RETIRED_SKILL_NAMES) {
    const retiredDir = join(dir, retired);
    if (!existsSync(retiredDir)) continue;
    try {
      rmSync(retiredDir, { recursive: true, force: true });
      logger.info(`[skills] Removed retired skill ${retired} for ${cliId}`);
    } catch (err: any) {
      logger.warn(`[skills] Failed to remove retired skill ${retired} for ${cliId}: ${err.message}`);
    }
  }
}
