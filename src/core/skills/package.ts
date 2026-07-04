import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readSkillFrontmatter } from './frontmatter.js';
import type { SkillPackage, SkillSource } from './types.js';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/;

export function isValidSkillName(name: string): boolean {
  return NAME_RE.test(name);
}

export function validateSkillPackageDir(dir: string): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(join(dir, 'SKILL.md'))) return { ok: false, reason: 'missing_skill_md' };
  return { ok: true };
}

export function loadSkillPackage(
  dir: string,
  opts: { source: SkillSource; id?: string },
): SkillPackage {
  const valid = validateSkillPackageDir(dir);
  if (!valid.ok) throw new Error(valid.reason);
  const rootDir = realpathSync(dir);
  const text = readFileSync(join(rootDir, 'SKILL.md'), 'utf-8');
  const fm = readSkillFrontmatter(text);
  const name = fm.name?.trim() || basename(rootDir);
  if (!isValidSkillName(name)) throw new Error(`invalid_skill_name:${name}`);
  return {
    id: opts.id ?? name,
    name,
    displayName: fm.displayName,
    description: fm.description,
    version: fm.version,
    tags: fm.tags ?? [],
    rootDir,
    entrypoint: 'SKILL.md',
    source: opts.source,
  };
}
