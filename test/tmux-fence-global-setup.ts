import type { TestProject } from 'vitest/node';
import {
  createTmuxFence,
  readTmuxFenceDenials,
  teardownTmuxFence,
  tmuxFenceDenialError,
  type TmuxFence,
} from './helpers/tmux-fence.js';

declare module 'vitest' {
  export interface ProvidedContext {
    tmuxFence: TmuxFence;
  }
}

/**
 * Vitest globalSetup half of the tmux fence (see test/helpers/tmux-fence.ts):
 * one private root + shim per run, created from the INVOKING environment so the
 * host's own TMUX_TMPDIR is recognised as a host socket directory. The per-file
 * half is test/tmux-fence-setup.ts.
 */
export default function setupTmuxFence(project: TestProject) {
  const fence = createTmuxFence(process.env);
  project.provide('tmuxFence', fence);
  return () => {
    const denials = readTmuxFenceDenials(fence);
    teardownTmuxFence(fence);
    if (denials.length === 0) return;
    // Backstop for refusals the per-file hook cannot see (a child that dropped
    // BOTMUX_TMUX_FENCE_LOG, a refusal after the file finished). vitest only
    // logs a teardown error, so fail the run explicitly.
    process.exitCode = 1;
    throw tmuxFenceDenialError(denials);
  };
}
