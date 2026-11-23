import type { TestProject } from 'vitest/node';
import {
  createHcFence,
  hcFenceDenialError,
  readHcFenceDenials,
  teardownHcFence,
  type HcFence,
} from './helpers/hc-fence.js';

declare module 'vitest' {
  export interface ProvidedContext {
    hcFence: HcFence;
  }
}

/**
 * Vitest globalSetup half of the hc fence (see test/helpers/hc-fence.ts): one
 * private root + shims per run, created from the INVOKING environment so the
 * host's own hc config is recognised. Teardown stops any private core a test
 * left running. The per-file half is test/hc-fence-setup.ts.
 */
export default function setupHcFence(project: TestProject) {
  const fence = createHcFence(process.env);
  project.provide('hcFence', fence);
  return () => {
    const denials = readHcFenceDenials(fence);
    teardownHcFence(fence);
    if (denials.length === 0) return;
    // Backstop for refusals the per-file hook cannot see (a child that dropped
    // BOTMUX_HC_FENCE_LOG, a refusal after the file finished).
    process.exitCode = 1;
    throw hcFenceDenialError(denials);
  };
}
