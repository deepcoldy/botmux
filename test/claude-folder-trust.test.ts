/**
 * Unit tests for ensureClaudeFolderTrust — pre-accepting Claude Code's
 * per-project folder-trust dialog so freshly spawned `claude` sessions in an
 * untrusted workingDir don't block on the interactive confirmation screen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureClaudeFolderTrust } from '../src/core/worker-pool.js';

describe('ensureClaudeFolderTrust', () => {
  let home: string;
  let workDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bmx-trust-home-'));
    workDir = mkdtempSync(join(tmpdir(), 'bmx-trust-work-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  const configPath = () => join(home, '.claude.json');
  const canonical = () => realpathSync(workDir);

  it('creates ~/.claude.json and marks the workingDir trusted (keyed by realpath)', () => {
    expect(existsSync(configPath())).toBe(false);
    ensureClaudeFolderTrust(workDir);
    const data = JSON.parse(readFileSync(configPath(), 'utf-8'));
    expect(data.projects[canonical()].hasTrustDialogAccepted).toBe(true);
  });

  it('merges into an existing config without clobbering other keys', () => {
    writeFileSync(configPath(), JSON.stringify({
      numStartups: 7,
      projects: { '/some/other/dir': { hasTrustDialogAccepted: true, lastCost: 1.5 } },
    }, null, 2));
    ensureClaudeFolderTrust(workDir);
    const data = JSON.parse(readFileSync(configPath(), 'utf-8'));
    expect(data.numStartups).toBe(7);
    expect(data.projects['/some/other/dir']).toEqual({ hasTrustDialogAccepted: true, lastCost: 1.5 });
    expect(data.projects[canonical()].hasTrustDialogAccepted).toBe(true);
  });

  it('preserves other per-project fields when the entry already exists', () => {
    writeFileSync(configPath(), JSON.stringify({
      projects: { [canonical()]: { lastCost: 2.5, allowedTools: ['Bash'] } },
    }, null, 2));
    ensureClaudeFolderTrust(workDir);
    const entry = JSON.parse(readFileSync(configPath(), 'utf-8')).projects[canonical()];
    expect(entry.hasTrustDialogAccepted).toBe(true);
    expect(entry.lastCost).toBe(2.5);
    expect(entry.allowedTools).toEqual(['Bash']);
  });

  it('is idempotent and does not rewrite when already trusted', () => {
    ensureClaudeFolderTrust(workDir);
    const firstMtime = readFileSync(configPath(), 'utf-8');
    ensureClaudeFolderTrust(workDir);
    expect(readFileSync(configPath(), 'utf-8')).toBe(firstMtime);
  });

  it('swallows malformed JSON without throwing', () => {
    writeFileSync(configPath(), '{ not valid json');
    expect(() => ensureClaudeFolderTrust(workDir)).not.toThrow();
    // Left the corrupt file untouched (best-effort: never destroys user data).
    expect(readFileSync(configPath(), 'utf-8')).toBe('{ not valid json');
  });
});
