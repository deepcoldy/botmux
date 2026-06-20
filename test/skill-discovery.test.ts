import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { discoverProjectSkills } from '../src/core/skills/discovery.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('skill discovery', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'botmux-skill-repo-'));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('discovers project skills from .agents/skills and .botmux/skills', () => {
    write(join(repo, '.agents', 'skills', 'agent-skill', 'SKILL.md'), '---\nname: agent-skill\n---');
    write(join(repo, '.botmux', 'skills', 'botmux-skill', 'SKILL.md'), '---\nname: botmux-skill\n---');

    expect(discoverProjectSkills(repo).map((s) => s.name).sort()).toEqual(['agent-skill', 'botmux-skill']);
  });
});
