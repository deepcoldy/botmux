import { mkdtempSync, symlinkSync, unlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freezeCodexCleanupLaunch } from '../src/core/codex-cleanup-launch.js';

describe('Codex native launch identity', () => {
  it.each(['codex', 'codex-app'])('freezes the exact %s native executable before its alias disappears', cliId => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-native-launch-'));
    try {
      const alias = join(dir, 'temporary-codex'); symlinkSync(process.execPath, alias);
      const result = freezeCodexCleanupLaunch(cliId, cliId === 'codex' ? alias : '/not-the-native-runner',
        cliId === 'codex-app' ? ['--codex-bin', alias] : [], dir)!;
      unlinkSync(alias);
      expect(result.codexBin).toBe(realpathSync(process.execPath));
      expect(result.codexHome).toBe(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not infer a native executable for other CLIs or a runner missing --codex-bin', () => {
    expect(freezeCodexCleanupLaunch('claude-code', process.execPath, [], '/tmp')).toBeUndefined();
    expect(freezeCodexCleanupLaunch('codex-app', process.execPath, [], '/tmp')).toBeUndefined();
  });
});
