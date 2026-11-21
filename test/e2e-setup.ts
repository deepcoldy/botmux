import { inject } from 'vitest';
import { installSessionDataDirFence } from './helpers/session-data-dir-fence.js';

// Per-file data-dir fence for the e2e project (the unit project gets the same
// via unit-setup.ts). Without it an e2e file inherits the invoking shell's
// SESSION_DATA_DIR — inside a Botmux session that is the live fleet's
// ~/.botmux/data — and every store it touches reads and writes real data.
//
// HOME is deliberately NOT fenced here: e2e files drive real CLIs (claude,
// codex, …) that need the developer's own credentials and config, so only the
// botmux-owned data directory is redirected.
installSessionDataDirFence(inject('testSessionDataRoot'), 'e2e-');
