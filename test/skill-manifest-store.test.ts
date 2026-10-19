import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  __testOnly_setManifestFileReader,
  readSessionSkillManifest,
  sessionSkillManifestPath,
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
    __testOnly_setManifestFileReader(undefined);
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

  it('names the manifest file through the shared path helper (the sandbox exposes this exact file)', () => {
    writeSessionSkillManifest({
      sessionId: 's-path', cliId: 'codex', workingDir: '/repo', policyMode: 'priority',
      prioritySkills: [], diagnostics: [], generatedAt: '2026-06-14T00:00:00.000Z',
    });
    expect(sessionSkillManifestPath('s-path')).toBe(join(dataDir, 'skill-manifests', 's-path.json'));
    expect(sessionSkillManifestPath('s-path', '/elsewhere')).toBe('/elsewhere/skill-manifests/s-path.json');
    expect(existsSync(sessionSkillManifestPath('s-path'))).toBe(true);
  });

  // Mode bits can't stand in for "unreadable" here: the daemon runs as root,
  // and root (CAP_DAC_OVERRIDE) reads a chmod-000 file fine — a chmod case would
  // have to skip exactly where it matters. These cases hold for ANY uid.
  it('a present-but-unreadable manifest throws a read error, not null — real fs (EISDIR, ELOOP)', () => {
    mkdirSync(sessionSkillManifestPath('as-dir'), { recursive: true });
    symlinkSync('loop.json', sessionSkillManifestPath('loop'));
    for (const [sessionId, code] of [['as-dir', 'EISDIR'], ['loop', 'ELOOP']] as const) {
      let caught: unknown;
      try { readSessionSkillManifest(sessionId); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(SkillManifestReadError);
      expect((caught as SkillManifestReadError).cause?.code).toBe(code);
      expect((caught as SkillManifestReadError).path).toBe(sessionSkillManifestPath(sessionId));
    }
  });

  for (const code of ['EPERM', 'EACCES'] as const) {
    it(`a ${code} read (macOS Seatbelt deny / real permission fault) throws a read error, not null`, () => {
      mkdirSync(join(dataDir, 'skill-manifests'), { recursive: true });
      writeFileSync(sessionSkillManifestPath('locked'), '{}');
      __testOnly_setManifestFileReader(() => {
        throw Object.assign(new Error(`${code}: operation not permitted`), { code });
      });
      let caught: unknown;
      try { readSessionSkillManifest('locked'); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(SkillManifestReadError);
      expect((caught as SkillManifestReadError).cause?.code).toBe(code);
      __testOnly_setManifestFileReader(undefined);
      expect(readSessionSkillManifest('locked')).toEqual({});
    });
  }

  it('ENOENT stays "absent" (null) — also the shape Linux bwrap gives an unexposed path', () => {
    __testOnly_setManifestFileReader(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });
    expect(readSessionSkillManifest('not-mounted')).toBeNull();
  });
});
