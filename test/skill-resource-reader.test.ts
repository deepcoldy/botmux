import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { listSkillResources, readSkillResource } from '../src/core/skills/resource-reader.js';
import type { SessionSkillManifest } from '../src/core/skills/types.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('skill resource reader', () => {
  let root: string;
  let manifest: SessionSkillManifest;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-skill-resource-'));
    write(join(root, 'deploy', 'SKILL.md'), '# Deploy');
    write(join(root, 'deploy', 'references', 'release.md'), '# Release');
    manifest = {
      sessionId: 's1',
      cliId: 'codex',
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: [{
        id: 'deploy',
        name: 'deploy',
        tags: [],
        rootDir: join(root, 'deploy'),
        entrypoint: 'SKILL.md',
        source: { type: 'user', root: join(root, 'deploy') },
        priorityReason: 'bot:include',
      }],
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads files inside the skill root', () => {
    expect(readSkillResource(manifest, 'deploy', 'references/release.md').content).toContain('# Release');
  });

  it('rejects path traversal', () => {
    expect(() => readSkillResource(manifest, 'deploy', '../secret.txt')).toThrow(/path_outside_skill_root/);
  });

  it('rejects symlink traversal', () => {
    write(join(root, 'secret.txt'), 'secret');
    symlinkSync(join(root, 'secret.txt'), join(root, 'deploy', 'references', 'secret-link.md'));

    expect(() => readSkillResource(manifest, 'deploy', 'references/secret-link.md')).toThrow(/path_outside_skill_root/);
  });

  it('does not enumerate resources through symlinks outside the skill root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'botmux-skill-outside-'));
    try {
      write(join(outside, 'secret.md'), '# Secret');
      symlinkSync(outside, join(root, 'deploy', 'references', 'outside'));

      expect(listSkillResources(manifest, 'deploy')).toEqual(['SKILL.md', 'references/release.md']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
