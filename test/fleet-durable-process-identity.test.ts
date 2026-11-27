// Must stay first: this file mocks node:fs and therefore requires the data-dir fence.
import './helpers/require-fenced-data-dir.js';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ps = vi.hoisted(() => ({ output: 'Fri Nov 27 19:32:34 2026\n' }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(() => ps.output) };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      path === '/usr/bin/ps' || path === '/bin/ps' ? true : actual.existsSync(path),
  };
});

import {
  canFleetIdentityProvePidReuse,
  FLEET_LSTART_UTC_V1_PREFIX,
  readDurableProcessIdentity,
  readFleetDurableProcessIdentity,
  readProcessStartIdentity,
} from '../src/utils/process-identity.js';

const raw = 'Fri Nov 27 19:32:34 2026';

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(execFileSync).mockClear();
});

describe('fleet durable POSIX process identity', () => {
  it('versions fresh fleet identities and pins only their ps rendering to UTC', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    expect(readProcessStartIdentity(61)).toBe(raw);
    expect(readDurableProcessIdentity(61)).toBe(raw);
    expect(readFleetDurableProcessIdentity(61)).toBe(`${FLEET_LSTART_UTC_V1_PREFIX}${raw}`);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][2]?.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C' });
    expect(calls[1][2]?.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C' });
    expect(calls[2][2]?.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C', TZ: 'UTC0' });
  });

  it('reads a recorded legacy identity with the legacy renderer for upgrade compatibility', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    expect(readFleetDurableProcessIdentity(61, raw)).toBe(raw);
    expect(readFleetDurableProcessIdentity(61, `${FLEET_LSTART_UTC_V1_PREFIX}${raw}`))
      .toBe(`${FLEET_LSTART_UTC_V1_PREFIX}${raw}`);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0][2]?.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C' });
    expect(calls[1][2]?.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C', TZ: 'UTC0' });
  });

  it('allows only versioned POSIX identities to prove PID reuse', () => {
    expect(canFleetIdentityProvePidReuse(raw, 'darwin')).toBe(false);
    expect(canFleetIdentityProvePidReuse(FLEET_LSTART_UTC_V1_PREFIX, 'darwin')).toBe(false);
    expect(canFleetIdentityProvePidReuse(`${FLEET_LSTART_UTC_V1_PREFIX}${raw}`, 'darwin')).toBe(true);
    expect(canFleetIdentityProvePidReuse(raw, 'linux')).toBe(true);
    expect(canFleetIdentityProvePidReuse(raw, 'win32')).toBe(true);
  });
});
