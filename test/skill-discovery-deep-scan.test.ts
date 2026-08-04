import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverLocalSkillCandidates } from '../src/services/skill-registry-store.js';
import { discoverDashboardSkills, parseDashboardSkillInstallRequest } from '../src/dashboard/skill-install-request.js';

/** Regression guard for whole-repo imports. Real skill collections nest a
 *  category directory (`skills/<category>/<skill>/SKILL.md`, e.g.
 *  github.com/mattpocock/skills), which the shallow scan cannot see — it only
 *  looks one level under `skills/`. The dashboard used to report "no skills
 *  found" for those repos because it never passed fullDepth. */
const tempDirs: string[] = [];

function makeRepo(relativeSkillDir: string): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-scan-'));
  tempDirs.push(root);
  const dir = join(root, relativeSkillDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: grill-me\ndescription: Grill me\n---\n# grill me\n');
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('discovery deep-scan fallback', () => {
  it('shallow scan misses skills/<category>/<skill> (the underlying limitation)', () => {
    const root = makeRepo(join('skills', 'productivity', 'grill-me'));
    expect(discoverLocalSkillCandidates(root, { fullDepth: false }).skills).toHaveLength(0);
    expect(discoverLocalSkillCandidates(root, { fullDepth: true }).skills.length).toBeGreaterThan(0);
  });

  it('dashboard discovery falls back to a deep scan and flags it', async () => {
    const root = makeRepo(join('skills', 'productivity', 'grill-me'));
    const result = await discoverDashboardSkills(parseDashboardSkillInstallRequest({ source: root }));
    expect(result.skills.map(skill => skill.name)).toContain('grill-me');
    expect(result.deepScanned).toBe(true);
  });

  it('does not deep-scan (or flag) when the shallow scan already found skills', async () => {
    const root = makeRepo(join('skills', 'alpha'));
    const result = await discoverDashboardSkills(parseDashboardSkillInstallRequest({ source: root }));
    expect(result.skills.length).toBeGreaterThan(0);
    expect(result.deepScanned).not.toBe(true);
  });

  it('an explicit fullDepth request skips the shallow pass entirely', async () => {
    const root = makeRepo(join('skills', 'productivity', 'grill-me'));
    const result = await discoverDashboardSkills(parseDashboardSkillInstallRequest({ source: root, fullDepth: true }));
    expect(result.skills.length).toBeGreaterThan(0);
    // Not a fallback — the caller asked for it, so no "we had to dig" marker.
    expect(result.deepScanned).not.toBe(true);
  });
});
