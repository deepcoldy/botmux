/**
 * Unit tests for ensureClaudeFolderTrust — pre-accepting Claude Code's
 * per-project folder-trust dialog so freshly spawned `claude` sessions in an
 * untrusted workingDir don't block on the interactive confirmation screen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, realpathSync, mkdirSync, rmdirSync, statSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { ensureClaudeFolderTrust } from '../src/core/worker-pool.js';
import { prepareWorkflowClaudeTrust, updateClaudeStateFile } from '../src/core/claude-folder-trust.js';

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
    if (process.platform !== 'win32') expect(statSync(configPath()).mode & 0o777).toBe(0o600);
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

  it('preserves an explicit negative decision and private permissions', () => {
    const before = JSON.stringify({ projects: { [canonical()]: { hasTrustDialogAccepted: false } } });
    writeFileSync(configPath(), before, { mode: 0o600 });
    ensureClaudeFolderTrust(workDir);
    expect(readFileSync(configPath(), 'utf8')).toBe(before);
    const other = mkdtempSync(join(home, 'other-'));
    ensureClaudeFolderTrust(other);
    if (process.platform !== 'win32') expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(configPath(), 'utf8')).projects[canonical()].hasTrustDialogAccepted).toBe(false);
  });

  it('leaves a concurrent Claude writer alone and merges its committed state on the next attempt', () => {
    const lock = configPath() + '.lock';
    mkdirSync(lock);
    ensureClaudeFolderTrust(workDir);
    expect(existsSync(configPath())).toBe(false);
    expect(statSync(lock).isDirectory()).toBe(true);
    writeFileSync(configPath(), JSON.stringify({ projects: { '/other': { lastCost: 7 } } }));
    rmdirSync(lock);
    ensureClaudeFolderTrust(workDir);
    const state = JSON.parse(readFileSync(configPath(), 'utf8'));
    expect(state.projects['/other']).toEqual({ lastCost: 7 });
    expect(state.projects[canonical()].hasTrustDialogAccepted).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('merges after a competing writer releases the lock and respects cancellation while waiting', async () => {
    const lock = configPath() + '.lock';
    mkdirSync(lock);
    const controller = new AbortController();
    const cancelledDir = mkdtempSync(join(home, 'cancelled-'));
    const cancelled = prepareWorkflowClaudeTrust(cancelledDir, configPath(), controller.signal);
    const running = prepareWorkflowClaudeTrust(workDir, configPath());
    controller.abort();
    writeFileSync(configPath(), JSON.stringify({ projects: { concurrent: { keep: true } } }));
    rmdirSync(lock);
    await Promise.all([running, cancelled]);
    expect(JSON.parse(readFileSync(configPath(), 'utf8')).projects).toEqual({
      concurrent: { keep: true }, [canonical()]: { hasTrustDialogAccepted: true },
    });
  });

  it('leaves a symlinked state file to Claude, including when several profiles share it', () => {
    const shared = join(home, 'shared-state');
    writeFileSync(shared, '{}');
    symlinkSync(shared, configPath());
    ensureClaudeFolderTrust(workDir);
    expect(lstatSync(configPath()).isSymbolicLink()).toBe(true);
    expect(readFileSync(shared, 'utf8')).toBe('{}');
  });

  it('carries a negative source decision into a new isolated profile and preserves it on resume', () => {
    const isolated = join(home, 'isolated.json');
    writeFileSync(configPath(), JSON.stringify({ projects: {
      [canonical()]: { hasTrustDialogAccepted: false }, '/other': { keepPrivate: true },
    } }));
    const seed = loadWorkerFunction<(path: string, cwd: string, log: () => void, source: string) => void>(
      'seedAndTrustClaudeState', { existsSync, readFileSync, realpathSync, updateClaudeStateFile, isWorkflowWorker: () => true },
    );
    seed(isolated, workDir, () => {}, configPath());
    expect(JSON.parse(readFileSync(isolated, 'utf8')).projects).toEqual({ [canonical()]: { hasTrustDialogAccepted: false } });
    seed(isolated, workDir, () => {}, configPath());
    expect(JSON.parse(readFileSync(isolated, 'utf8')).projects[canonical()].hasTrustDialogAccepted).toBe(false);
    writeFileSync(isolated, JSON.stringify({ projects: { [canonical()]: { hasTrustDialogAccepted: true } } }));
    seed(isolated, workDir, () => {}, configPath());
    expect(JSON.parse(readFileSync(isolated, 'utf8')).projects[canonical()].hasTrustDialogAccepted).toBe(false);
    writeFileSync(isolated, JSON.stringify({ projects: { '/local': { keep: true } } }));
    seed(isolated, workDir, () => {}, configPath());
    expect(JSON.parse(readFileSync(isolated, 'utf8')).projects).toEqual({
      '/local': { keep: true }, [canonical()]: { hasTrustDialogAccepted: false },
    });
  });

  it.each([false, true])('finishes onboarding without inferring trust from a damaged source (existing profile %s)', existing => {
    const isolated = join(home, 'isolated.json');
    if (existing) writeFileSync(isolated, JSON.stringify({ keep: 7, projects: { '/local': { hasTrustDialogAccepted: false } } }));
    writeFileSync(configPath(), '{');
    const seed = loadWorkerFunction<(path: string, cwd: string, log: () => void, source: string) => void>(
      'seedAndTrustClaudeState', { existsSync, readFileSync, realpathSync, updateClaudeStateFile, isWorkflowWorker: () => false },
    );
    seed(isolated, workDir, () => {}, configPath());
    expect(existsSync(isolated)).toBe(true);
    const data = JSON.parse(readFileSync(isolated, 'utf8'));
    expect(data.hasCompletedOnboarding).toBe(true);
    expect(data.projects[canonical()]?.hasTrustDialogAccepted).toBeUndefined();
    if (existing) {
      expect(data.keep).toBe(7);
      expect(data.projects['/local'].hasTrustDialogAccepted).toBe(false);
    }
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
