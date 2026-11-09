import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Nested run for test/systemd-fence.test.ts: the unit project's fences and
// setup around the fixture alone.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    include: ['test/fixtures/systemd-fence/*.fixture.ts'],
    globalSetup: ['./test/unit-global-setup.ts', './test/tmux-fence-global-setup.ts'],
    setupFiles: ['./test/tmux-fence-setup.ts', './test/unit-setup.ts'],
  },
});
