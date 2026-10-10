import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { installAidenCodexShim, renderAidenCodexShim } from '../src/services/aiden-codex-shim.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Aiden Codex reasoning shim', () => {
  it('materializes an executable shim on the real filesystem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-aiden-shim-'));
    dirs.push(dir);
    expect(installAidenCodexShim(dir)).toBe(dir);
    expect(readFileSync(join(dir, 'codex'), 'utf8')).toBe(renderAidenCodexShim());
  });

  it.each(['max', 'ultra'] as const)('passes %s to the real Codex without downgrading', (effort) => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-aiden-shim-'));
    dirs.push(dir);
    const shimDir = installAidenCodexShim(join(dir, 'shim'));
    const realCodex = join(dir, 'real-codex');
    writeFileSync(realCodex, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    chmodSync(realCodex, 0o755);

    const result = spawnSync(join(shimDir, 'codex'), ['--model', 'deepseek-v4-pro'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BOTMUX_AIDEN_CODEX_REAL_BIN: realCodex,
        BOTMUX_AIDEN_CODEX_REASONING_EFFORT: effort,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      '-c',
      `model_reasoning_effort="${effort}"`,
      '--model',
      'deepseek-v4-pro',
    ]);
  });
});
