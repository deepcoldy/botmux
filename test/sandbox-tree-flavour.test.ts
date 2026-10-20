/**
 * A spawn reconciles the per-session tree it inherits with the flavour it is
 * about to build — in ONE place (reconcileSandboxTreeFlavour):
 *   same flavour → reused (the session's own state);
 *   other flavour → torn down with ITS OWN teardown (scratch unmounts first),
 *   only once the old pane is proven gone, and only if the teardown really
 *   took the tree away; otherwise the spawn refuses to start.
 *
 * Scratch trees here carry a REAL mount at their merged root (tmpfs as root,
 * fuse-overlayfs otherwise) when the host allows it.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MASK_MANIFEST_NAME, mountsAtOrUnder, prepareCredentialOnlyRelayOutbox } from '../src/adapters/backend/sandbox.js';
import { isMountpoint } from '../src/adapters/backend/scratch-sandbox.js';
import {
  reconcileSandboxTreeFlavour,
  recordedSandboxTreeFlavour,
  requestedSandboxTreeFlavour,
  type SandboxTreeFlavour,
} from '../src/adapters/backend/sandbox-tree-teardown.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

const linux = process.platform === 'linux';
const isRoot = process.getuid?.() === 0;

function unmount(target: string): void {
  if (!isMountpoint(target)) return;
  if (spawnSync('umount', [target], { stdio: 'ignore' }).status === 0) return;
  spawnSync('fusermount', ['-u', target], { stdio: 'ignore' });
}

function mountSmallFs(target: string, scratch: string): boolean {
  mkdirSync(target, { recursive: true });
  if (isRoot) {
    return spawnSync('mount', ['-t', 'tmpfs', '-o', 'mode=700,size=1m', 'tmpfs', target], { stdio: 'ignore' }).status === 0;
  }
  const dirs = ['lower', 'upper', 'work'].map(d => join(scratch, d));
  for (const d of dirs) mkdirSync(d, { recursive: true });
  return spawnSync('fuse-overlayfs', ['-o', `lowerdir=${dirs[0]},upperdir=${dirs[1]},workdir=${dirs[2]}`, target], { stdio: 'ignore' }).status === 0;
}

const mountsAvailable = linux && (() => {
  const dir = mkdtempSync(join(tmpdir(), 'sbx-flavour-probe-'));
  try {
    const target = join(dir, 'm');
    const ok = mountSmallFs(target, join(dir, 'fs'));
    if (ok) unmount(target);
    return ok && !isMountpoint(target);
  } catch {
    return false;
  } finally {
    rmSandboxScratch(dir);
  }
})();

/** Build the on-disk layout each flavour's prepare leaves behind. */
function buildTree(dataDir: string, sessionId: string, flavour: SandboxTreeFlavour): { merged?: string } {
  const sessionRoot = join(dataDir, 'sandboxes', sessionId);
  if (flavour === 'credential-only') {
    expect(prepareCredentialOnlyRelayOutbox({ sessionId, dataDir })).not.toBeNull();
    return {};
  }
  mkdirSync(join(sessionRoot, 'outbox'), { recursive: true });
  for (const d of ['shimbin', 'empties', 'empty']) mkdirSync(join(sessionRoot, d));
  if (flavour === 'oncall') {
    writeFileSync(join(sessionRoot, MASK_MANIFEST_NAME), '[]');
    return {};
  }
  const merged = join(sessionRoot, 'root');
  writeFileSync(join(sessionRoot, 'scratch.json'), JSON.stringify({ v: 1, sid: sessionId, storage: 'disk', merged }));
  if (mountsAvailable) {
    expect(mountSmallFs(merged, join(dataDir, 'fs'))).toBe(true);
    writeFileSync(join(merged, 'canary'), 'x');
  } else {
    mkdirSync(merged);
  }
  return { merged };
}

const flavours: SandboxTreeFlavour[] = ['scratch', 'oncall', 'credential-only'];
const requests: Array<SandboxTreeFlavour | null> = [...flavours, null];
const matrix = flavours.flatMap(recorded => requests.map(requested => ({ recorded, requested })));

describe.skipIf(!linux)('reconcileSandboxTreeFlavour', () => {
  it.each(matrix)('inherited $recorded tree, spawn builds $requested', ({ recorded, requested }) => {
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-flavour-')));
    const sessionId = 'sid-flavour';
    const { merged } = buildTree(dataDir, sessionId, recorded);
    try {
      expect(recordedSandboxTreeFlavour(sessionId, dataDir)).toBe(recorded);
      let probed = 0;
      const outcome = reconcileSandboxTreeFlavour({
        sessionId, dataDir, requested, reattach: false,
        probePane: () => { probed += 1; return 'missing'; },
      });
      if (recorded === requested) {
        // The session's own state: reused untouched, no pane probe needed.
        expect(outcome).toBe('kept');
        expect(probed).toBe(0);
        expect(recordedSandboxTreeFlavour(sessionId, dataDir)).toBe(recorded);
        if (merged && mountsAvailable) expect(readFileSync(join(merged, 'canary'), 'utf8')).toBe('x');
      } else {
        expect(outcome).toBe('torn-down');
        expect(probed).toBe(1);
        expect(recordedSandboxTreeFlavour(sessionId, dataDir)).toBeNull();
        if (merged) expect(isMountpoint(merged)).toBe(false);
      }
    } finally {
      if (merged) unmount(merged);
      rmSandboxScratch(dataDir);
    }
  });

  it.each(flavours)('keeps an inherited %s tree while its pane may still run, and refuses to build another', (recorded) => {
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-flavour-live-')));
    const sessionId = 'sid-live';
    const { merged } = buildTree(dataDir, sessionId, recorded);
    const other = flavours.find(f => f !== recorded)!;
    try {
      for (const probe of ['exists', 'unknown']) {
        expect(() => reconcileSandboxTreeFlavour({
          sessionId, dataDir, requested: other, reattach: false, probePane: () => probe,
        })).toThrow(/may still be in use by its pane/);
        expect(recordedSandboxTreeFlavour(sessionId, dataDir)).toBe(recorded);
      }
      // A warm reattach keeps the live pane, and with it its tree.
      expect(reconcileSandboxTreeFlavour({
        sessionId, dataDir, requested: other, reattach: true, probePane: () => 'exists',
      })).toBe('kept');
      expect(recordedSandboxTreeFlavour(sessionId, dataDir)).toBe(recorded);
    } finally {
      if (merged) unmount(merged);
      rmSandboxScratch(dataDir);
    }
  });

  it.skipIf(!mountsAvailable)('refuses to build a new flavour on top of an old tree it could not take down', () => {
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-flavour-stuck-')));
    const sessionId = 'sid-stuck';
    const { merged } = buildTree(dataDir, sessionId, 'scratch');
    // A mount the scratch teardown does not know about stays behind.
    const stray = join(dataDir, 'sandboxes', sessionId, 'outbox');
    try {
      expect(mountSmallFs(stray, join(dataDir, 'fs-stray'))).toBe(true);
      expect(() => reconcileSandboxTreeFlavour({
        sessionId, dataDir, requested: 'credential-only', reattach: false, probePane: () => 'missing',
      })).toThrow(/could not tear down its previous scratch sandbox tree/);
      expect(mountsAtOrUnder(join(dataDir, 'sandboxes', sessionId))).toEqual([stray]);
    } finally {
      unmount(stray);
      if (merged) unmount(merged);
      rmSandboxScratch(dataDir);
    }
  });

  it('has nothing to do without an inherited tree', () => {
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-flavour-none-')));
    try {
      expect(reconcileSandboxTreeFlavour({
        sessionId: 'sid-none', dataDir, requested: 'scratch', reattach: false,
        probePane: () => { throw new Error('no probe without a tree'); },
      })).toBe('none');
    } finally {
      rmSandboxScratch(dataDir);
    }
  });
});

describe('requestedSandboxTreeFlavour', () => {
  it.each([
    [{ platform: 'linux', scratchRequested: true, sandboxRequested: true, credentialOnlyBwrap: false }, 'scratch'],
    [{ platform: 'darwin', scratchRequested: true, sandboxRequested: true, credentialOnlyBwrap: false }, 'scratch'],
    [{ platform: 'linux', scratchRequested: false, sandboxRequested: true, credentialOnlyBwrap: false }, 'oncall'],
    // macOS oncall is a Seatbelt profile, not a tree.
    [{ platform: 'darwin', scratchRequested: false, sandboxRequested: true, credentialOnlyBwrap: false }, null],
    [{ platform: 'linux', scratchRequested: false, sandboxRequested: false, credentialOnlyBwrap: true }, 'credential-only'],
    [{ platform: 'linux', scratchRequested: false, sandboxRequested: false, credentialOnlyBwrap: false }, null],
  ] as const)('%o → %s', (input, expected) => {
    expect(requestedSandboxTreeFlavour({ ...input, platform: input.platform as NodeJS.Platform })).toBe(expected);
  });
});
