// Run only by test/systemd-fence.test.ts, in a nested runner: the fence must
// fail this test although it catches the refusal. `--version` keeps it harmless
// should the fence ever let the call through.
import { spawnSync } from 'node:child_process';
import { it } from 'vitest';

it('swallows the systemd fence refusal', () => {
  try {
    spawnSync('systemd-run', ['--version']);
  } catch {
    // swallowed on purpose
  }
});
