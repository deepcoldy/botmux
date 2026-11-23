import { afterAll, inject } from 'vitest';
import { applyHcFenceEnv, hcFenceDenialError, readHcFenceLog } from './helpers/hc-fence.js';

// Per-file half of the hc fence (test/helpers/hc-fence.ts): runs before the
// test module is imported, so module-scope hc calls are fenced too. Mounted
// before unit-setup.ts, whose home fence then moves XDG_STATE_HOME into the
// fenced HOME.
const { denyLog } = applyHcFenceEnv(inject('hcFence'));

// Registered first, so with vitest's stacked hook order it runs after the
// file's own cleanup.
afterAll(() => {
  const denials = readHcFenceLog(denyLog);
  if (denials.length > 0) throw hcFenceDenialError(denials);
});
