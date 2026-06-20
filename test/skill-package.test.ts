import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadSkillPackage, validateSkillPackageDir } from '../src/core/skills/package.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('skill package parser', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-skill-pkg-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads metadata from SKILL.md frontmatter', () => {
    const dir = join(root, 'deploy-runbook');
    write(join(dir, 'SKILL.md'), [
      '---',
      'name: deploy-runbook',
      'description: Use when deploying services',
      'version: 1.2.0',
      'tags: [deploy, sre]',
      '---',
      '',
      '# Deploy',
    ].join('\n'));

    const pkg = loadSkillPackage(dir, { source: { type: 'user', root: dir } });

    expect(pkg.name).toBe('deploy-runbook');
    expect(pkg.description).toBe('Use when deploying services');
    expect(pkg.version).toBe('1.2.0');
    expect(pkg.tags).toEqual(['deploy', 'sre']);
    expect(pkg.entrypoint).toBe('SKILL.md');
  });

  it('uses the directory name when frontmatter has no name', () => {
    const dir = join(root, 'fallback-name');
    write(join(dir, 'SKILL.md'), '# Body');

    expect(loadSkillPackage(dir, { source: { type: 'user', root: dir } }).name).toBe('fallback-name');
  });

  it('rejects a directory without SKILL.md', () => {
    const dir = join(root, 'broken');
    mkdirSync(dir, { recursive: true });

    expect(validateSkillPackageDir(dir)).toEqual({ ok: false, reason: 'missing_skill_md' });
  });

  it('rejects invalid skill names', () => {
    const dir = join(root, 'bad-name');
    write(join(dir, 'SKILL.md'), '---\nname: bad name\n---\n# Bad');

    expect(() => loadSkillPackage(dir, { source: { type: 'user', root: dir } })).toThrow(/invalid_skill_name/);
  });
});
