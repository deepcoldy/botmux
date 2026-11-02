/**
 * The Dashboard note under the scratch choice: which machine verdict leads to
 * a blocking note, a caveat or nothing, for the storage currently selected.
 * `tr` echoes the key so the assertions follow the decision, not the wording.
 */
import { describe, expect, it } from 'vitest';
import { scratchCapabilityNote } from '../src/dashboard/web/scratch-capability-note.js';
import { evaluateScratchCapability, type ScratchFacts } from '../src/adapters/backend/scratch-capability.js';

const tr = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}(${Object.values(params).join('|')})` : key;

const linux = (over: Partial<ScratchFacts> = {}): ScratchFacts => ({
  platform: 'linux', uid: 0, forceFuse: false, bwrapSetuid: false, noNewPrivs: false, devFuse: 'ok',
  kernelOverlay: true, userns: { state: 'ok' },
  ...over,
  has: { bwrap: true, fuseOverlayfs: true, fusermount: true, sandboxExec: false, packageManager: 'apt-get', ...over.has },
});
const note = (f: ScratchFacts, storage: 'tmpfs' | 'disk') => scratchCapabilityNote(evaluateScratchCapability(f), storage, tr);

describe('scratchCapabilityNote', () => {
  it('says nothing for a capable root host or an older daemon without a probe', () => {
    expect(note(linux(), 'tmpfs')).toBeNull();
    expect(scratchCapabilityNote(null, 'tmpfs', tr)).toBeNull();
    expect(scratchCapabilityNote(undefined, 'disk', tr)).toBeNull();
  });

  it('non-root: "disk only" blocks the tmpfs choice and only cautions the disk choice', () => {
    const onTmpfs = note(linux({ uid: 1000 }), 'tmpfs')!;
    expect(onTmpfs.level).toBe('block');
    expect(onTmpfs.lines).toEqual([
      'botDefaults.scratchCapDiskOnly(botDefaults.scratchCapProblemTmpfsRoot)',
      'botDefaults.scratchCapSwitchToDisk',
      'botDefaults.scratchCapSubmountsReadOnly',
    ]);
    const onDisk = note(linux({ uid: 1000 }), 'disk')!;
    expect(onDisk.level).toBe('warn');
    expect(onDisk.lines).not.toContain('botDefaults.scratchCapSwitchToDisk');
  });

  it('a machine that cannot run scratch names the disk-storage reasons, whatever is selected', () => {
    const n = note(linux({ uid: 1000, devFuse: 'missing' }), 'disk')!;
    expect(n.level).toBe('block');
    expect(n.lines[0]).toBe('botDefaults.scratchCapNone(botDefaults.scratchCapProblemDevFuseMissing)');
    expect(n.lines).not.toContain('botDefaults.scratchCapSubmountsReadOnly');
  });

  it('missing packages carry the install command, flagged as auto-installed when root can', () => {
    expect(note(linux({ has: { bwrap: false } }), 'disk')!.lines).toContain('botDefaults.scratchCapAutoInstall(apt-get install -y bubblewrap)');
    expect(note(linux({ uid: 1000, has: { bwrap: false } }), 'disk')!.lines).toContain('botDefaults.scratchCapInstall(sudo apt-get install -y bubblewrap)');
  });

  it('an undecidable check is informational, never blocking', () => {
    const n = note(linux({ userns: { state: 'unknown', detail: 'kernel.apparmor_restrict_unprivileged_userns=1' } }), 'tmpfs')!;
    expect(n.level).toBe('info');
    expect(n.lines).toEqual(['botDefaults.scratchCapUnknown(kernel.apparmor_restrict_unprivileged_userns=1)']);
  });

  it('an undecided check next to a disk-only verdict is still shown', () => {
    const n = note(linux({ uid: 1000, userns: { state: 'unknown', detail: 'kernel.apparmor_restrict_unprivileged_userns=1' } }), 'disk')!;
    expect(n.lines).toContain('botDefaults.scratchCapUnknown(kernel.apparmor_restrict_unprivileged_userns=1)');
  });

  it('macOS without sandbox-exec cannot run scratch', () => {
    const n = note(linux({ platform: 'darwin' }), 'tmpfs')!;
    expect(n.level).toBe('block');
    expect(n.lines).toEqual(['botDefaults.scratchCapNone(botDefaults.scratchCapProblemSandboxExec)']);
  });
});
