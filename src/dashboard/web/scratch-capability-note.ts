import type { ScratchCapability, ScratchCapabilityProblem } from '../../adapters/backend/scratch-capability.js';

type Tr = (key: string, params?: Record<string, string | number>) => string;

export interface ScratchCapabilityNote {
  /** 'block' = scratch cannot start / the chosen storage cannot; 'warn' = works
   *  with a caveat; 'info' = could not be decided. */
  level: 'block' | 'warn' | 'info';
  lines: string[];
}

const PROBLEM_KEY: Record<ScratchCapabilityProblem, string> = {
  'unsupported-platform': 'botDefaults.scratchCapProblemPlatform',
  'sandbox-exec-missing': 'botDefaults.scratchCapProblemSandboxExec',
  'bwrap-missing': 'botDefaults.scratchCapProblemBwrap',
  'userns-blocked': 'botDefaults.scratchCapProblemUserns',
  'tmpfs-needs-root': 'botDefaults.scratchCapProblemTmpfsRoot',
  'kernel-overlay-missing': 'botDefaults.scratchCapProblemKernelOverlay',
  'fuse-overlayfs-missing': 'botDefaults.scratchCapProblemFuseOverlayfs',
  'fusermount-missing': 'botDefaults.scratchCapProblemFusermount',
  'no-new-privs': 'botDefaults.scratchCapProblemNoNewPrivs',
  'dev-fuse-missing': 'botDefaults.scratchCapProblemDevFuseMissing',
  'dev-fuse-denied': 'botDefaults.scratchCapProblemDevFuseDenied',
};

const reasons = (tr: Tr, problems: readonly ScratchCapabilityProblem[]): string =>
  problems.map(p => tr(PROBLEM_KEY[p] ?? p)).join(tr('botDefaults.scratchCapSep'));

/**
 * What to show under the scratch choice for this machine. Advice only: the
 * caller never disables saving on it. null = nothing worth saying (all good,
 * or an older daemon that sends no probe).
 */
export function scratchCapabilityNote(
  cap: ScratchCapability | null | undefined,
  storage: 'tmpfs' | 'disk',
  tr: Tr,
): ScratchCapabilityNote | null {
  if (!cap) return null;
  const lines: string[] = [];
  let level: ScratchCapabilityNote['level'];
  if (cap.summary === 'none') {
    level = 'block';
    const problems = cap.storages ? cap.storages.disk.problems : (cap.problems ?? []);
    lines.push(tr('botDefaults.scratchCapNone', { reasons: reasons(tr, problems) }));
  } else if (cap.summary === 'disk-only') {
    level = storage === 'tmpfs' ? 'block' : 'warn';
    lines.push(tr('botDefaults.scratchCapDiskOnly', { reasons: reasons(tr, cap.storages?.tmpfs.problems ?? []) }));
    if (storage === 'tmpfs') lines.push(tr('botDefaults.scratchCapSwitchToDisk'));
  } else if (cap.summary === 'unknown') {
    level = 'info';
    lines.push(tr('botDefaults.scratchCapUnknown', { checks: cap.undecided.join(', ') }));
  } else {
    if (!cap.submountsReadOnly && !cap.undecided.length) return null;
    level = 'info';
  }
  // A caveat that is not the summary itself: something undecided next to a
  // storage that is known to work (or known not to).
  if (cap.summary !== 'unknown' && cap.summary !== 'none' && cap.undecided.length) {
    lines.push(tr('botDefaults.scratchCapUnknown', { checks: cap.undecided.join(', ') }));
  }
  if (cap.installHint) {
    lines.push(tr(cap.autoInstall ? 'botDefaults.scratchCapAutoInstall' : 'botDefaults.scratchCapInstall', { command: cap.installHint }));
  }
  if (cap.submountsReadOnly && cap.summary !== 'none') lines.push(tr('botDefaults.scratchCapSubmountsReadOnly'));
  return { level, lines };
}
