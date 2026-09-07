import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function run(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-image-mode-'));
  try {
    return spawnSyncTsScript(cli, args, {
      env: { PATH: process.env.PATH, HOME: dir, SESSION_DATA_DIR: join(dir, 'data'), BOTS_CONFIG: join(dir, 'bots.json') },
      encoding: 'utf8', timeout: 30_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('send --image-mode', () => {
  it.each([
    ['--image-mode', 'invalid'], ['--image-mode=SMALL'], ['--image-mode'],
    ['--image-mode='], ['--image-mode', '--images', '/tmp/screenshot.png'],
  ])('rejects invalid or missing mode: %j', (...args) => {
    const result = run(['send', ...args]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--image-mode 仅支持');
  });

  it.each(['fit_horizontal', 'crop_center', 'large', 'medium', 'small', 'tiny'])('accepts %s before attachment validation', mode => {
    // Reject stdin-as-attachment after parsing, without uploading or sending.
    const result = run(['send', `--image-mode=${mode}`, '--images', '-']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('不能把 stdin');
  });

  it('documents the allowed modes and default in help', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--image-mode <mode>');
    expect(result.stdout).toContain('fit_horizontal（默认）|crop_center|large|medium|small|tiny');
  });
});
