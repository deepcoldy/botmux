import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { BUILTIN_SKILLS, RETIRED_SKILL_NAMES, ASK_SKILL, ASK_SKILL_NAME } from './definitions.js';

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
      writeFileSync(manifestFile, PLUGIN_MANIFEST, 'utf-8');
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
      writeFileSync(skillFile, ASK_SKILL, 'utf-8');
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

  for (const skill of BUILTIN_SKILLS) {
    const skillDir = join(dir, skill.name);
    const skillFile = join(skillDir, 'SKILL.md');
    try {
      if (existsSync(skillFile)) {
        const current = readFileSync(skillFile, 'utf-8');
        if (current === skill.content) continue;
      }
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(skillFile, skill.content, 'utf-8');
      logger.info(`[skills] Installed ${skill.name} for ${cliId} → ${skillFile}`);
    } catch (err: any) {
      logger.warn(`[skills] Failed to install ${skill.name} for ${cliId}: ${err.message}`);
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
