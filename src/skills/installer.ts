import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { BUILTIN_SKILLS, RETIRED_SKILL_NAMES } from './definitions.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
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
