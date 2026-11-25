import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HC_MIN_VERSION,
  discoverHcBinary,
  probeHcAvailability,
  resetHcAvailabilityCache,
} from '../src/setup/ensure-hc.js';

const floor = HC_MIN_VERSION.join('.');
const belowFloor = [HC_MIN_VERSION[0], HC_MIN_VERSION[1], HC_MIN_VERSION[2] - 1].join('.');
const aboveFloor = [HC_MIN_VERSION[0], HC_MIN_VERSION[1] + 1, 0].join('.');

let root: string;
let dataDir: string;
let dataBin: string;
let pathA: string;
let pathB: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bm-ensure-hc-'));
  dataDir = join(root, 'botmux', 'data');
  dataBin = join(root, 'botmux', 'bin');
  pathA = join(root, 'path-a');
  pathB = join(root, 'path-b');
  for (const dir of [dataDir, pathA, pathB]) mkdirSync(dir, { recursive: true });
  resetHcAvailabilityCache();
});

afterEach(() => {
  resetHcAvailabilityCache();
  rmSync(root, { recursive: true, force: true });
});

function fakeBinary(dir: string, name: string, versionLine: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${versionLine}'; exit 0; fi\nexit 64\n`);
  chmodSync(file, 0o755);
  return file;
}

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: join(root, 'home'),
    SESSION_DATA_DIR: dataDir,
    PATH: `${pathA}:${pathB}:/usr/bin:/bin`,
    ...extra,
  };
}

describe('discoverHcBinary', () => {
  it('prefers the botmux data root bin over PATH', () => {
    const managed = fakeBinary(dataBin, 'herdr-core', `hc ${floor}`);
    fakeBinary(pathA, 'herdr-core', `hc ${aboveFloor}`);

    expect(discoverHcBinary({ env: env(), platform: 'linux' })).toEqual({
      ok: true,
      bin: managed,
      version: `hc ${floor}`,
    });
  });

  it('prefers herdr-core on PATH over hc, whatever the PATH order', () => {
    fakeBinary(pathA, 'hc', `hc ${aboveFloor}`);
    const herdrCore = fakeBinary(pathB, 'herdr-core', `hc ${floor}`);

    expect(discoverHcBinary({ env: env(), platform: 'linux' })).toMatchObject({ ok: true, bin: herdrCore });
  });

  it('takes the first PATH entry holding an executable', () => {
    writeFileSync(join(pathA, 'hc'), 'not executable');
    const usable = fakeBinary(pathB, 'hc', `hc ${floor}`);

    expect(discoverHcBinary({ env: env(), platform: 'linux' })).toMatchObject({ ok: true, bin: usable });
  });

  it('skips a candidate below the version floor and falls through to the next', () => {
    fakeBinary(dataBin, 'herdr-core', `hc ${belowFloor}`);
    const fallback = fakeBinary(pathA, 'hc', `hc ${floor}`);

    expect(discoverHcBinary({ env: env(), platform: 'linux' })).toMatchObject({ ok: true, bin: fallback });
  });

  it('reports every rejected candidate when none is usable', () => {
    const old = fakeBinary(dataBin, 'herdr-core', `hc ${belowFloor}`);
    const foreign = fakeBinary(pathA, 'hc', 'tmux 3.4');

    const result = discoverHcBinary({ env: env(), platform: 'linux' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(old);
    expect(result.reason).toContain(belowFloor);
    expect(result.reason).toContain(foreign);
  });

  it('uses BOTMUX_HC_BIN exclusively when it is set', () => {
    const pinned = fakeBinary(join(root, 'pinned'), 'herdr-core', `hc ${belowFloor}`);
    fakeBinary(dataBin, 'herdr-core', `hc ${floor}`);
    fakeBinary(pathA, 'herdr-core', `hc ${floor}`);

    const result = discoverHcBinary({ env: env({ BOTMUX_HC_BIN: pinned }), platform: 'linux' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(pinned);
    const good = fakeBinary(join(root, 'pinned-good'), 'hc', `hc ${aboveFloor}`);
    expect(discoverHcBinary({ env: env({ BOTMUX_HC_BIN: good }), platform: 'linux' })).toEqual({
      ok: true,
      bin: good,
      version: `hc ${aboveFloor}`,
    });
  });

  it('refuses a relative BOTMUX_HC_BIN instead of resolving it against PATH or cwd', () => {
    fakeBinary(pathA, 'herdr-core', `hc ${floor}`);

    expect(discoverHcBinary({ env: env({ BOTMUX_HC_BIN: 'herdr-core' }), platform: 'linux' }).ok).toBe(false);
  });

  it('does not let HC_* variables reach the version probe', () => {
    const strict = join(pathA, 'herdr-core');
    writeFileSync(strict, `#!/bin/sh\n[ -n "$HC_SOCKET$HC_SESSION" ] && exit 1\necho 'hc ${floor}'\n`);
    chmodSync(strict, 0o755);

    const result = discoverHcBinary({
      env: env({ HC_SOCKET: '/run/user/0/herdr-core/default.sock', HC_SESSION: 'default' }),
      platform: 'linux',
    });

    expect(result).toMatchObject({ ok: true, bin: strict });
  });

  it('discovers a usable binary on macOS', () => {
    const bin = fakeBinary(pathA, 'herdr-core', `hc ${floor}`);

    expect(discoverHcBinary({ env: env(), platform: 'darwin' })).toMatchObject({ ok: true, bin });
  });

  it('is unavailable on Windows even with a usable binary', () => {
    fakeBinary(pathA, 'herdr-core', `hc ${floor}`);

    const result = discoverHcBinary({ env: env(), platform: 'win32' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toBe('');
  });
});

describe('probeHcAvailability', () => {
  it('keeps answering from cache until reset', () => {
    const bin = fakeBinary(pathA, 'herdr-core', `hc ${floor}`);
    const options = { env: env(), platform: 'linux' as const };

    expect(probeHcAvailability(options)).toMatchObject({ ok: true, bin });
    rmSync(bin);
    expect(probeHcAvailability(options)).toMatchObject({ ok: true, bin });

    resetHcAvailabilityCache();
    expect(probeHcAvailability(options).ok).toBe(false);
  });

  it('answers separately for a different BOTMUX_HC_BIN', () => {
    const first = fakeBinary(join(root, 'one'), 'herdr-core', `hc ${floor}`);
    const second = fakeBinary(join(root, 'two'), 'herdr-core', `hc ${floor}`);

    expect(probeHcAvailability({ env: env({ BOTMUX_HC_BIN: first }), platform: 'linux' })).toMatchObject({ bin: first });
    expect(probeHcAvailability({ env: env({ BOTMUX_HC_BIN: second }), platform: 'linux' })).toMatchObject({ bin: second });
  });
});
