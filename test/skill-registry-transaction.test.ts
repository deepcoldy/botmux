import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

import { __testOnly_setLocalSkillCopyOps, installLocalSkill, installLocalSkillCopies, installLocalSkillCopiesAsync, installLocalSkillLinks, readSkillRegistry, recoverLocalSkillCopyTransactions, sweepStoreTrash } from '../src/services/skill-registry-store.js';
import { spawnSyncTsEvalWithRepoImports, spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const CRASH_CHILD = String.raw`
const fs = await import('node:fs');
const { installLocalSkillCopies, __testOnly_setLocalSkillCopyOps } = await import('./src/services/skill-registry-store.js');
const target = process.env.CRASH_TARGET;
const boundary = process.env.CRASH_BOUNDARY;
__testOnly_setLocalSkillCopyOps({
  renameSync(from, to) {
    const backup = from === target && to.includes('.copy-backup-');
    const publish = from.includes('.copy-staging-') && !to.includes('.copy-staging-');
    const finalize = from.includes('.copy-backup-') && to.includes('.trash-');
    if (boundary === 'beforeBackup' && backup) process.exit(86);
    fs.renameSync(from, to);
    if ((boundary === 'afterBackup' && backup)
      || (boundary === 'afterPublish' && publish)
      || (boundary === 'afterFinalize' && finalize)) process.exit(86);
  },
});
installLocalSkillCopies([process.env.COPY_SOURCE]);
`;

const PAUSED_WRITER_CHILD = String.raw`
const fs = await import('node:fs');
const { installLocalSkillCopies, __testOnly_setLocalSkillCopyOps } = await import('./src/services/skill-registry-store.js');
__testOnly_setLocalSkillCopyOps({
  beforeRegistryWrite() {
    fs.writeFileSync(process.env.PAUSE_FILE, 'paused');
    const slot = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(process.env.RESUME_FILE)) Atomics.wait(slot, 0, 0, 10);
  },
});
installLocalSkillCopies([process.env.COPY_SOURCE]);
`;

const PLAIN_WRITER_CHILD = String.raw`
const { installLocalSkillCopies } = await import('./src/services/skill-registry-store.js');
installLocalSkillCopies([process.env.COPY_SOURCE]);
`;

const STAGING_OWNER_CHILD = String.raw`
const fs = await import('node:fs');
const path = await import('node:path');
const { installLocalSkillCopiesAsync, __testOnly_setLocalSkillCopyOps } = await import('./src/services/skill-registry-store.js');
__testOnly_setLocalSkillCopyOps({
  async copyAsync(source, target) {
    await fs.promises.mkdir(target, { recursive: true });
    await fs.promises.writeFile(path.join(target, 'SKILL.md'), 'partial staging tree');
    fs.writeFileSync(process.env.STAGING_MARK, 'started');
    if (process.env.STAGING_MODE === 'crash') process.exit(86);
    while (!fs.existsSync(process.env.RESUME_FILE)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  },
});
await installLocalSkillCopiesAsync([process.env.COPY_SOURCE]);
`;

function stderrOf(child: ChildProcess): () => string {
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  return () => stderr;
}

describe('local skill copy transactions', () => {
  let home: string;
  let src: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-skill-transaction-home-'));
    src = mkdtempSync(join(tmpdir(), 'botmux-skill-transaction-src-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    __testOnly_setLocalSkillCopyOps(undefined);
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  for (const boundary of ['beforeBackup', 'afterBackup', 'afterPublish', 'afterFinalize'] as const) {
    it(`recovers a hard exit at ${boundary} before the startup trash sweep`, async () => {
      const name = `skill-${boundary}`;
      const source = join(src, name);
      write(join(source, 'SKILL.md'), `---\nname: ${name}\n---\n# OLD ${boundary}`);
      const previous = installLocalSkill(source, { link: false });
      write(join(source, 'SKILL.md'), `---\nname: ${name}\n---\n# NEW ${boundary}`);

      const crashed = spawnSyncTsEvalWithRepoImports(CRASH_CHILD, {
        encoding: 'utf-8',
        env: {
          ...process.env,
          COPY_SOURCE: source,
          CRASH_TARGET: previous.rootDir,
          CRASH_BOUNDARY: boundary,
        },
      });
      expect(crashed.status, crashed.stderr).toBe(86);

      recoverLocalSkillCopyTransactions();
      const installed = readSkillRegistry().skills[name];
      expect(installed).toBeDefined();
      expect(readFileSync(join(installed.rootDir, 'SKILL.md'), 'utf-8')).toContain(`NEW ${boundary}`);
      expect(installed.source).toMatchObject({ type: 'local-copy', originalPath: source });

      // Startup cleanup must see only finalized trash, never a recoverable backup.
      sweepStoreTrash();
      await vi.waitFor(() => {
        const entries = readdirSync(dirname(installed.rootDir));
        expect(entries.filter(entry => entry.startsWith('.trash-'))).toEqual([]);
      }, { timeout: 3000, interval: 25 });
      const entries = readdirSync(dirname(installed.rootDir));
      expect(entries.filter(entry => entry.startsWith('.copy-transaction-')
        || entry.startsWith('.copy-backup-')
        || entry.startsWith('.copy-staging-'))).toEqual([]);
      expect(readFileSync(join(installed.rootDir, 'SKILL.md'), 'utf-8')).toContain(`NEW ${boundary}`);
    });
  }

  async function runConcurrentWriters(sourceA: string, sourceB: string): Promise<void> {
    const pauseFile = join(home, 'writer-a-paused');
    const resumeFile = join(home, 'writer-a-resume');
    const childA = spawnTsEvalWithRepoImports(PAUSED_WRITER_CHILD, {
      env: { ...process.env, COPY_SOURCE: sourceA, PAUSE_FILE: pauseFile, RESUME_FILE: resumeFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exitA = once(childA, 'exit');
    const readStderrA = stderrOf(childA);
    let childB: ChildProcess | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(pauseFile)).toBe(true), { timeout: 10_000, interval: 20 });
      childB = spawnTsEvalWithRepoImports(PLAIN_WRITER_CHILD, {
        env: { ...process.env, COPY_SOURCE: sourceB },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exitB = once(childB, 'exit');
      const readStderrB = stderrOf(childB);
      // Without the shared registry lock B can finish while A holds its old
      // snapshot. With the lock B waits for A, then publishes after A.
      await new Promise(resolve => setTimeout(resolve, 200));
      writeFileSync(resumeFile, 'resume');
      const [[codeA], [codeB]] = await Promise.all([exitA, exitB]);
      expect(codeA, readStderrA()).toBe(0);
      expect(codeB, readStderrB()).toBe(0);
    } finally {
      if (childA.exitCode === null) childA.kill();
      if (childB && childB.exitCode === null) childB.kill();
    }
  }

  it('keeps same-name source metadata and content aligned across two processes', async () => {
    const sourceA = join(src, 'source-a');
    const sourceB = join(src, 'source-b');
    write(join(sourceA, 'SKILL.md'), '---\nname: shared\n---\n# CONTENT A');
    write(join(sourceB, 'SKILL.md'), '---\nname: shared\n---\n# CONTENT B');

    await runConcurrentWriters(sourceA, sourceB);

    const installed = readSkillRegistry().skills.shared;
    expect(installed.source).toMatchObject({ type: 'local-copy', originalPath: sourceB });
    expect(readFileSync(join(installed.rootDir, 'SKILL.md'), 'utf-8')).toContain('CONTENT B');
  });

  it('does not lose an unrelated registration across two processes', async () => {
    const sourceA = join(src, 'alpha');
    const sourceB = join(src, 'beta');
    write(join(sourceA, 'SKILL.md'), '---\nname: alpha\n---\n# ALPHA');
    write(join(sourceB, 'SKILL.md'), '---\nname: beta\n---\n# BETA');

    await runConcurrentWriters(sourceA, sourceB);

    const registry = readSkillRegistry();
    expect(registry.skills.alpha).toBeDefined();
    expect(registry.skills.beta).toBeDefined();
    expect(readFileSync(join(registry.skills.alpha.rootDir, 'SKILL.md'), 'utf-8')).toContain('ALPHA');
    expect(readFileSync(join(registry.skills.beta.rootDir, 'SKILL.md'), 'utf-8')).toContain('BETA');
  });

  for (const preinstall of [false, true]) {
    it(`preserves staging for recovery after rollback failure (preinstall=${preinstall})`, () => {
      const sourceA = join(src, 'rollback-a');
      const sourceB = join(src, 'rollback-b');
      write(join(sourceA, 'SKILL.md'), '---\nname: rollback-a\n---\n# OLD A');
      write(join(sourceB, 'SKILL.md'), '---\nname: rollback-b\n---\n# OLD B');
      if (preinstall) {
        installLocalSkill(sourceA, { link: false });
        installLocalSkill(sourceB, { link: false });
      }
      write(join(sourceA, 'SKILL.md'), '---\nname: rollback-a\n---\n# NEW A');
      write(join(sourceB, 'SKILL.md'), '---\nname: rollback-b\n---\n# NEW B');
      const storeRoot = join(home, '.botmux', 'skills', 'store');
      mkdirSync(storeRoot, { recursive: true });
      const targetA = join(realpathSync(storeRoot), 'rollback-a');
      let publishRenames = 0;
      let rollbackFailed = false;
      __testOnly_setLocalSkillCopyOps({
        renameSync: (from, to) => {
          if (from.includes('.copy-staging-') && !to.includes('.copy-staging-')) {
            publishRenames++;
            if (publishRenames === 2) throw new Error('injected publish failure');
          }
          if (from === targetA && to.includes('.copy-staging-') && !rollbackFailed) {
            rollbackFailed = true;
            throw new Error('injected rollback failure');
          }
          renameSync(from, to);
        },
      });

      expect(() => installLocalSkillCopies([sourceA, sourceB])).toThrow(/local_copy_rollback_failed/);
      expect(readdirSync(storeRoot).filter(name => name.startsWith('.copy-transaction-'))).toHaveLength(1);
      expect(readdirSync(storeRoot).filter(name => name.startsWith('.copy-staging-'))).toHaveLength(1);

      recoverLocalSkillCopyTransactions();
      const registry = readSkillRegistry();
      expect(readFileSync(join(registry.skills['rollback-a'].rootDir, 'SKILL.md'), 'utf-8')).toContain('NEW A');
      expect(readFileSync(join(registry.skills['rollback-b'].rootDir, 'SKILL.md'), 'utf-8')).toContain('NEW B');
      expect(readdirSync(storeRoot).filter(name => name.startsWith('.copy-transaction-')
        || name.startsWith('.copy-backup-')
        || name.startsWith('.copy-staging-'))).toEqual([]);

      const afterward = join(src, `afterward-${preinstall}`);
      write(join(afterward, 'SKILL.md'), `---\nname: afterward-${preinstall}\n---\n# After`);
      expect(installLocalSkillLinks([afterward])).toHaveLength(1);
    });
  }

  it('fails a synchronous writer busy instead of deadlocking behind an in-process async lock', async () => {
    const asyncSource = join(src, 'async-holder');
    const syncSource = join(src, 'sync-writer');
    write(join(asyncSource, 'SKILL.md'), '---\nname: async-holder\n---\n# Async');
    write(join(syncSource, 'SKILL.md'), '---\nname: sync-writer\n---\n# Sync');
    let busyError: unknown;
    __testOnly_setLocalSkillCopyOps({
      beforeRegistryWrite: () => {
        try { installLocalSkillLinks([syncSource]); } catch (err) { busyError = err; }
      },
    });

    await installLocalSkillCopiesAsync([asyncSource]);

    expect(busyError).toBeInstanceOf(Error);
    expect((busyError as Error).message).toBe('skill_registry_busy');
    expect(installLocalSkillLinks([syncSource])).toHaveLength(1);
  });

  it('keeps staging owned by a live process, then lets that process finish', async () => {
    const source = join(src, 'live-staging');
    write(join(source, 'SKILL.md'), '---\nname: live-staging\n---\n# Live');
    const marker = join(home, 'live-staging-started');
    const resume = join(home, 'live-staging-resume');
    const child = spawnTsEvalWithRepoImports(STAGING_OWNER_CHILD, {
      env: { ...process.env, COPY_SOURCE: source, STAGING_MARK: marker, RESUME_FILE: resume, STAGING_MODE: 'pause' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exit = once(child, 'exit');
    const readStderr = stderrOf(child);
    try {
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000, interval: 20 });
      const storeRoot = join(home, '.botmux', 'skills', 'store');
      expect(readdirSync(storeRoot).filter(name => name.startsWith('.copy-staging-'))).toHaveLength(1);

      recoverLocalSkillCopyTransactions();
      expect(readdirSync(storeRoot).filter(name => name.startsWith('.copy-staging-'))).toHaveLength(1);

      writeFileSync(resume, 'resume');
      const [code] = await exit;
      expect(code, readStderr()).toBe(0);
      expect(readSkillRegistry().skills['live-staging']).toBeDefined();
      expect(readdirSync(storeRoot).filter(name => name.startsWith('.copy-staging-'))).toEqual([]);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  it('reclaims partial staging after its owner dies before journal creation', () => {
    const source = join(src, 'dead-staging');
    write(join(source, 'SKILL.md'), '---\nname: dead-staging\n---\n# Dead');
    const marker = join(home, 'dead-staging-started');
    const crashed = spawnSyncTsEvalWithRepoImports(STAGING_OWNER_CHILD, {
      encoding: 'utf-8',
      env: { ...process.env, COPY_SOURCE: source, STAGING_MARK: marker, RESUME_FILE: join(home, 'unused-resume'), STAGING_MODE: 'crash' },
    });
    expect(crashed.status, crashed.stderr).toBe(86);
    const storeRoot = join(home, '.botmux', 'skills', 'store');
    expect(readdirSync(storeRoot).filter(name => name.startsWith('.copy-staging-'))).toHaveLength(1);
    expect(readdirSync(storeRoot).filter(name => name.startsWith('.copy-transaction-'))).toHaveLength(0);

    recoverLocalSkillCopyTransactions();
    expect(readdirSync(storeRoot).filter(name => name.startsWith('.copy-staging-'))).toEqual([]);
    expect(readSkillRegistry().skills['dead-staging']).toBeUndefined();
  });
});
