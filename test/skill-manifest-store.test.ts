import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readSessionSkillManifest, writeSessionSkillManifest } from '../src/core/skills/manifest-store.js';
import type { SessionSkillManifest } from '../src/core/skills/types.js';

describe('session skill manifest store', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-skill-data-'));
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes and reads a manifest by session id', () => {
    const manifest: SessionSkillManifest = {
      sessionId: 's1',
      cliId: 'codex',
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: [],
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    };

    writeSessionSkillManifest(manifest);

    expect(readSessionSkillManifest('s1')).toEqual(manifest);
  });
});
