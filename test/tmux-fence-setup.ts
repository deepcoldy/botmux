import { afterAll, inject } from 'vitest';
import { applyTmuxFenceEnv, readTmuxFenceLog, tmuxFenceDenialError } from './helpers/tmux-fence.js';

// Per-file half of the tmux fence (test/helpers/tmux-fence.ts): runs before the
// test module is imported, so module-scope tmux calls are fenced too.
const { denyLog } = applyTmuxFenceEnv(inject('tmuxFence'));

// Registered first, so with vitest's stacked hook order it runs after the
// file's own cleanup (whose `kill-server` is the classic offender).
afterAll(() => {
  const denials = readTmuxFenceLog(denyLog);
  if (denials.length > 0) throw tmuxFenceDenialError(denials);
});
