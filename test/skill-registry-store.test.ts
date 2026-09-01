import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { skillRegistryPath } from '../src/core/skills/registry-paths.js';
import { __testOnly_setStoreTreeRemovalOps, buildSkillInstallAuditSummary, discoverLocalSkillCandidates, installLocalSkill, installLocalSkillLinks, readSkillRegistry, removeInstalledSkill, removeInstalledSkills, sweepStoreTrash } from '../src/services/skill-registry-store.js';

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
    __testOnly_setStoreTreeRemovalOps(undefined);
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  it('does not expose Object prototype properties as installed skills', () => {
    const skills = readSkillRegistry().skills;

    expect(Object.hasOwn(skills, 'constructor')).toBe(false);
    expect(skills.constructor).toBeUndefined();
  });

  it('discovers direct children when the supplied source is a native skills root', () => {
    const skillsRoot = join(src, '.claude', 'skills');
    write(join(skillsRoot, 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n# Deploy');
    write(join(skillsRoot, 'review', 'SKILL.md'), '---\nname: review\n---\n# Review');
    write(join(skillsRoot, 'not-a-skill', 'README.md'), '# Ignore');

    const discovery = discoverLocalSkillCandidates(skillsRoot);

    expect(discovery.skills.map(skill => [skill.name, skill.path])).toEqual([
      ['deploy', 'deploy'],
      ['review', 'review'],
    ]);
  });

  it('installs a local copy into the botmux store and records registry metadata', () => {
    write(join(src, 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n# Deploy');

    const pkg = installLocalSkill(join(src, 'deploy'), { link: false });

    expect(pkg.name).toBe('deploy');
    expect(pkg.rootDir).toContain(join('.botmux', 'skills', 'store', 'deploy'));
    expect(readSkillRegistry().skills.deploy.name).toBe('deploy');
    expect(readFileSync(skillRegistryPath(), 'utf-8')).toContain('local-copy');
  });

  it('builds a static audit summary without following or executing resources', () => {
    const skillDir = join(src, 'complex');
    write(join(skillDir, 'SKILL.md'), '---\nname: complex\nversion: 1.2.3\n---\n# Complex');
    write(join(skillDir, 'bin', 'delivery'), '#!/usr/bin/env bash\nexit 99\n');
    write(join(skillDir, 'scripts', 'helper.py'), '#!/usr/bin/python3\nraise SystemExit(98)\n');
    chmodSync(join(skillDir, 'bin', 'delivery'), 0o755);
    chmodSync(join(skillDir, 'scripts', 'helper.py'), 0o755);
    symlinkSync('../SKILL.md', join(skillDir, 'references-link'));
    const pkg = installLocalSkill(skillDir, { link: false });

    expect(buildSkillInstallAuditSummary(pkg)).toMatchObject({
      name: 'complex',
      sourceType: 'local-copy',
      version: '1.2.3',
      files: 3,
      directories: 2,
      symlinks: 1,
      executables: ['bin/delivery', 'scripts/helper.py'],
      executablesTruncated: false,
      runtimes: ['bash', 'python3'],
    });
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

  it('frees the skill rootDir synchronously (rename) and unlinks the tree in the background', async () => {
    write(join(src, 'bulky', 'SKILL.md'), '---\nname: bulky\n---\n# Bulky');
    // A few files so the tree is more than an empty dir — the point is that the
    // caller returns before these are unlinked.
    write(join(src, 'bulky', 'a', 'one.txt'), 'one');
    write(join(src, 'bulky', 'a', 'two.txt'), 'two');
    const pkg = installLocalSkill(join(src, 'bulky'), { link: false });
    const storeDir = join(home, '.botmux', 'skills', 'store');

    const result = removeInstalledSkill('bulky');

    // Synchronous guarantees: registry entry gone AND rootDir no longer resolves
    // (renamed away) the instant removeInstalledSkill returns.
    expect(result).toEqual({ ok: true });
    expect(readSkillRegistry().skills.bulky).toBeUndefined();
    expect(() => readFileSync(join(pkg.rootDir, 'SKILL.md'), 'utf-8')).toThrow();

    // The tree is briefly a `.trash-*` sibling, then the background unlink drains
    // it. Poll rather than assume timing.
    await vi.waitFor(() => {
      const leftovers = readdirSync(storeDir);
      expect(leftovers.filter(name => name.startsWith('.trash-'))).toEqual([]);
      expect(leftovers).toEqual([]);
    }, { timeout: 2000, interval: 25 });
  });

  it('sweepStoreTrash reclaims a leftover .trash-* dir from an interrupted unlink', async () => {
    const storeDir = join(home, '.botmux', 'skills', 'store');
    // Simulate an interrupted background unlink: a `.trash-*` dir left on disk.
    const orphan = join(storeDir, '.trash-deadbeefdeadbeef');
    write(join(orphan, 'video', 'big.bin'), 'x'.repeat(4096));

    sweepStoreTrash();

    await vi.waitFor(() => {
      expect(existsSync(orphan)).toBe(false);
    }, { timeout: 2000, interval: 25 });
    // A real installed skill (no .trash- prefix) must never be swept.
    write(join(src, 'keeper', 'SKILL.md'), '---\nname: keeper\n---\n# Keeper');
    const kept = installLocalSkill(join(src, 'keeper'), { link: false });
    sweepStoreTrash();
    await new Promise(r => setTimeout(r, 50));
    expect(readFileSync(join(kept.rootDir, 'SKILL.md'), 'utf-8')).toContain('name: keeper');
  });

  it('keeps the registry and tree intact when staging rename fails', () => {
    write(join(src, 'bulky', 'SKILL.md'), '---\nname: bulky\n---\n# Bulky');
    const pkg = installLocalSkill(join(src, 'bulky'), { link: false });
    const renameError = new Error('rename denied');
    __testOnly_setStoreTreeRemovalOps({
      rename: () => { throw renameError; },
      removeAsync: async () => undefined,
    });

    expect(removeInstalledSkill('bulky')).toEqual({ ok: false, reason: 'skill_tree_remove_failed' });
    expect(readSkillRegistry().skills.bulky).toBeDefined();
    expect(readFileSync(join(pkg.rootDir, 'SKILL.md'), 'utf-8')).toContain('name: bulky');
  });

  it('rolls back earlier staged trees when a later batch rename fails', () => {
    write(join(src, 'one', 'SKILL.md'), '---\nname: one\n---\n# One');
    write(join(src, 'two', 'SKILL.md'), '---\nname: two\n---\n# Two');
    const one = installLocalSkill(join(src, 'one'), { link: false });
    const two = installLocalSkill(join(src, 'two'), { link: false });
    let forwardRenames = 0;
    __testOnly_setStoreTreeRemovalOps({
      rename: (from, to) => {
        if (!from.includes('.trash-') && ++forwardRenames === 2) throw new Error('second rename denied');
        renameSync(from, to);
      },
      removeAsync: async () => undefined,
    });

    expect(removeInstalledSkills(['one', 'two'])).toEqual({ ok: false, reason: 'skill_tree_remove_failed' });
    expect(readSkillRegistry().skills.one).toBeDefined();
    expect(readSkillRegistry().skills.two).toBeDefined();
    expect(readFileSync(join(one.rootDir, 'SKILL.md'), 'utf-8')).toContain('name: one');
    expect(readFileSync(join(two.rootDir, 'SKILL.md'), 'utf-8')).toContain('name: two');
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
