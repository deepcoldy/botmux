import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readSessionSkillManifest,
  writeSessionSkillManifest,
  SkillManifestReadError,
  SkillManifestParseError,
} from '../src/core/skills/manifest-store.js';
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

  it('returns null only when the manifest is genuinely absent (ENOENT)', () => {
    expect(readSessionSkillManifest('never-written')).toBeNull();
  });

  it('throws a corrupt-JSON error instead of masking it as not-found', () => {
    mkdirSync(join(dataDir, 'skill-manifests'), { recursive: true });
    writeFileSync(join(dataDir, 'skill-manifests', 'bad.json'), '{ not valid json');
    expect(() => readSessionSkillManifest('bad')).toThrow(SkillManifestParseError);
  });

  it('throws a read error (not null) when the manifest is present but unreadable', () => {
    // A permission-denied read (the sandbox never exposed this session's
    // manifest) must NOT collapse to "not found" — regression for the
    // sandbox=true skill-body-unreadable bug.
    mkdirSync(join(dataDir, 'skill-manifests'), { recursive: true });
    const file = join(dataDir, 'skill-manifests', 'locked.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o000);
    try {
      // root ignores mode bits — skip the assertion there rather than false-fail.
      let readable = true;
      try { readSessionSkillManifest('locked'); } catch { readable = false; }
      if (typeof process.getuid === 'function' && process.getuid() === 0) return;
      expect(readable).toBe(false);
      expect(() => readSessionSkillManifest('locked')).toThrow(SkillManifestReadError);
    } finally {
      chmodSync(file, 0o600);
    }
  });
});
