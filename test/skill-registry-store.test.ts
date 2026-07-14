import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { skillRegistryPath } from '../src/core/skills/registry-paths.js';
import { installLocalSkill, installLocalSkillLinks, readSkillRegistry, removeInstalledSkill, removeInstalledSkills } from '../src/services/skill-registry-store.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('skill registry store', () => {
  let home: string;
  let src: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-skill-home-'));
    src = mkdtempSync(join(tmpdir(), 'botmux-skill-src-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  it('installs a local copy into the botmux store and records registry metadata', () => {
    write(join(src, 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n# Deploy');

    const pkg = installLocalSkill(join(src, 'deploy'), { link: false });

    expect(pkg.name).toBe('deploy');
    expect(pkg.rootDir).toContain(join('.botmux', 'skills', 'store', 'deploy'));
    expect(readSkillRegistry().skills.deploy.name).toBe('deploy');
    expect(readFileSync(skillRegistryPath(), 'utf-8')).toContain('local-copy');
  });

  it('installs a local link without copying files', () => {
    write(join(src, 'review', 'SKILL.md'), '---\nname: review\n---\n# Review');

    const pkg = installLocalSkill(join(src, 'review'), { link: true });

    expect(pkg.rootDir).toBe(realpathSync(join(src, 'review')));
    expect(readSkillRegistry().skills.review.source.type).toBe('local-link');
  });

  it('installs multiple local links with one registry write path', () => {
    write(join(src, 'api', 'SKILL.md'), '---\nname: api\n---\n# API');
    write(join(src, 'docs', 'SKILL.md'), '---\nname: docs\n---\n# Docs');

    const packages = installLocalSkillLinks([join(src, 'api'), join(src, 'docs')]);
    const registry = readSkillRegistry();

    expect(packages.map(pkg => pkg.name).sort()).toEqual(['api', 'docs']);
    expect(registry.skills.api.source).toMatchObject({ type: 'local-link', path: join(src, 'api') });
    expect(registry.skills.docs.source).toMatchObject({ type: 'local-link', path: join(src, 'docs') });
    expect(registry.skills.api.rootDir).toBe(realpathSync(join(src, 'api')));
    expect(registry.skills.docs.rootDir).toBe(realpathSync(join(src, 'docs')));
  });

  it('collapses same-named local links to one entry (last wins) without duplicating the result', () => {
    // The discovery dialog can surface the same skill name under multiple CLI
    // roots (e.g. botmux's own builtin skills live in every CLI's skillsDir).
    // Selecting both must not write twice nor return a duplicate package.
    write(join(src, 'codex', 'send', 'SKILL.md'), '---\nname: send\ndescription: from codex\n---\n# Send');
    write(join(src, 'claude', 'send', 'SKILL.md'), '---\nname: send\ndescription: from claude\n---\n# Send');

    const packages = installLocalSkillLinks([join(src, 'codex', 'send'), join(src, 'claude', 'send')]);
    const registry = readSkillRegistry();

    expect(packages.map(pkg => pkg.name)).toEqual(['send']); // deduped — not ['send','send']
    // Last selection wins for the surviving registry entry's path.
    expect(registry.skills.send.source).toMatchObject({ type: 'local-link', path: join(src, 'claude', 'send') });
    expect(registry.skills.send.rootDir).toBe(realpathSync(join(src, 'claude', 'send')));
  });

  it('aborts the whole batch and names the offending dir when a source is invalid', () => {
    write(join(src, 'good', 'SKILL.md'), '---\nname: good\n---\n# Good');
    const missing = join(src, 'gone'); // no SKILL.md

    expect(() => installLocalSkillLinks([join(src, 'good'), missing])).toThrow(new RegExp(`local_link_failed:.*gone`));
    // All-or-nothing: nothing registered when any source fails.
    expect(readSkillRegistry().skills.good).toBeUndefined();
  });

  it('removes the registry entry and store copy for local-copy installs', () => {
    write(join(src, 'cleanup', 'SKILL.md'), '---\nname: cleanup\n---\n# Cleanup');
    const pkg = installLocalSkill(join(src, 'cleanup'), { link: false });

    const result = removeInstalledSkill('cleanup');

    expect(result).toEqual({ ok: true });
    expect(readSkillRegistry().skills.cleanup).toBeUndefined();
    expect(() => readFileSync(join(pkg.rootDir, 'SKILL.md'), 'utf-8')).toThrow();
  });

  it('removes a batch with one registry mutation and preserves linked source directories', () => {
    write(join(src, 'copy', 'SKILL.md'), '---\nname: copy\n---\n# Copy');
    write(join(src, 'linked', 'SKILL.md'), '---\nname: linked\n---\n# Linked');
    const copied = installLocalSkill(join(src, 'copy'), { link: false });
    const linked = installLocalSkill(join(src, 'linked'), { link: true });

    const result = removeInstalledSkills(['copy', 'linked', 'copy']);

    expect(result).toEqual({ ok: true, removed: ['copy', 'linked'] });
    expect(readSkillRegistry().skills).toEqual({});
    expect(() => readFileSync(join(copied.rootDir, 'SKILL.md'), 'utf-8')).toThrow();
    expect(readFileSync(join(linked.rootDir, 'SKILL.md'), 'utf-8')).toContain('name: linked');
  });

  it('keeps the whole batch when any requested skill is missing', () => {
    write(join(src, 'keep', 'SKILL.md'), '---\nname: keep\n---\n# Keep');
    installLocalSkill(join(src, 'keep'), { link: true });

    expect(removeInstalledSkills(['keep', 'missing'])).toEqual({
      ok: false,
      reason: 'skill_not_installed',
      missing: ['missing'],
    });
    expect(readSkillRegistry().skills.keep).toBeDefined();
  });

  it('rejects reinstalling a local copy from its own store target without deleting it', () => {
    write(join(src, 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n# Deploy');
    const pkg = installLocalSkill(join(src, 'deploy'), { link: false });

    expect(() => installLocalSkill(pkg.rootDir, { link: false })).toThrow(/local_skill_source_overlaps_store_target/);
    expect(readFileSync(join(pkg.rootDir, 'SKILL.md'), 'utf-8')).toContain('name: deploy');
    expect(readSkillRegistry().skills.deploy.rootDir).toBe(pkg.rootDir);
  });
});
