import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSkillPackage } from './package.js';
import type { SkillPackage } from './types.js';

function listSkillDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

export function discoverProjectSkills(workingDir: string): SkillPackage[] {
  const roots = [
    join(workingDir, '.agents', 'skills'),
    join(workingDir, '.botmux', 'skills'),
  ];
  const out: SkillPackage[] = [];
  for (const root of roots) {
    for (const dir of listSkillDirs(root)) {
      try {
        out.push(loadSkillPackage(dir, { source: { type: 'project', root: dir } }));
      } catch {
        // Bad project-local skills should surface through diagnostics later, not break spawn.
      }
    }
  }
  return out;
}
