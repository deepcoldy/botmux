import { describe, expect, it, vi } from 'vitest';
import {
  checkWorkerAdmission,
  DEFAULT_MAX_MEMORY_FULL_AVG10,
  DEFAULT_MIN_AVAILABLE_MEMORY_BYTES,
  DEFAULT_MIN_AVAILABLE_MEMORY_CAP_BYTES,
  evaluateWorkerAdmission,
  readHostMemoryPressure,
  resolveWorkerPressurePolicy,
  tierWorkerAdmission,
  MARGINAL_AVAILABLE_MEMORY_MARGIN,
  type HostMemoryPressure,
} from '../src/core/worker-budget.js';

const GIB = 1024 ** 3;

function hostPressure(overrides: Partial<HostMemoryPressure> = {}): HostMemoryPressure {
  return {
    totalMemoryBytes: 32 * GIB,
    totalMemorySource: 'host',
    availableMemorySource: 'unavailable',
    memoryFullAvg10Source: 'unavailable',
    warnings: [],
    ...overrides,
  };
}

function fixtureReader(files: Record<string, string>): (path: string) => string {
  return path => {
    if (path in files) return files[path];
    throw new Error(`missing fixture: ${path}`);
  };
}

describe('worker memory admission', () => {
  it('parses host MemAvailable and memory full PSI fixtures', () => {
    const pressure = readHostMemoryPressure({
      platform: 'linux',
      totalMemoryBytes: 32 * GIB,
      readFile: fixtureReader({
        '/proc/self/cgroup': '1:name=systemd:/\n',
        '/proc/meminfo': 'MemTotal:       33554432 kB\nMemAvailable:    6291456 kB\n',
        '/proc/pressure/memory': 'some avg10=1.00 avg60=2.00 avg300=3.00 total=1\nfull avg10=7.25 avg60=2.00 avg300=1.00 total=2\n',
      }),
    });
    expect(pressure.availableMemoryBytes).toBe(6 * GIB);
    expect(pressure.memoryFullAvg10).toBe(7.25);
    expect(pressure.totalMemorySource).toBe('host');
    expect(pressure.availableMemorySource).toBe('host');
    expect(pressure.memoryFullAvg10Source).toBe('host');
    expect(pressure.warnings).toEqual([]);
  });

  it('uses finite cgroup-v2 memory and pressure from the same boundary', () => {
    const pressure = readHostMemoryPressure({
      platform: 'linux',
      totalMemoryBytes: 64 * GIB,
      readFile: fixtureReader({
        '/proc/self/cgroup': '0::/docker/demo\n',
        '/proc/self/mountinfo': '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
        '/sys/fs/cgroup/docker/demo/memory.max': String(8 * GIB),
        '/sys/fs/cgroup/docker/demo/memory.current': String(3 * GIB),
        '/sys/fs/cgroup/docker/demo/memory.stat': `anon ${2 * GIB}\ninactive_file ${GIB}\n`,
        '/sys/fs/cgroup/docker/demo/memory.pressure': 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=2.50 avg60=0.00 avg300=0.00 total=0\n',
        '/sys/fs/cgroup/docker/memory.max': 'max\n',
        '/sys/fs/cgroup/memory.max': 'max\n',
        '/proc/meminfo': 'MemAvailable: 1 kB\n',
        '/proc/pressure/memory': 'full avg10=99.00 avg60=0.00 avg300=0.00 total=0\n',
      }),
    });
    expect(pressure).toMatchObject({
      totalMemoryBytes: 8 * GIB,
      availableMemoryBytes: 6 * GIB,
      memoryFullAvg10: 2.5,
      totalMemorySource: 'cgroup-v2',
      availableMemorySource: 'cgroup-v2',
      memoryFullAvg10Source: 'cgroup-v2',
      cgroupPath: '/sys/fs/cgroup/docker/demo',
      warnings: [],
    });
    expect(resolveWorkerPressurePolicy(undefined, pressure.totalMemoryBytes, pressure.totalMemorySource).minAvailableMemoryBytes).toBe(2 * GIB);
  });

  it('uses a finite cgroup ancestor when the leaf is unlimited', () => {
    const pressure = readHostMemoryPressure({
      platform: 'linux',
      totalMemoryBytes: 64 * GIB,
      readFile: fixtureReader({
        '/proc/self/cgroup': '0::/tenant/session\n',
        '/proc/self/mountinfo': '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
        '/sys/fs/cgroup/tenant/session/memory.max': 'max\n',
        '/sys/fs/cgroup/tenant/memory.max': String(10 * GIB),
        '/sys/fs/cgroup/tenant/memory.current': String(4 * GIB),
        '/sys/fs/cgroup/tenant/memory.stat': 'inactive_file 0\n',
        '/sys/fs/cgroup/tenant/memory.pressure': 'full avg10=1.00 avg60=0.00 avg300=0.00 total=0\n',
      }),
    });
    expect(pressure.totalMemoryBytes).toBe(10 * GIB);
    expect(pressure.availableMemoryBytes).toBe(6 * GIB);
    expect(pressure.totalMemorySource).toBe('cgroup-v2');
  });

  it('blocks on a tighter finite ancestor even when the leaf has ample headroom', () => {
    const pressure = readHostMemoryPressure({
      platform: 'linux',
      totalMemoryBytes: 64 * GIB,
      readFile: fixtureReader({
        '/proc/self/cgroup': '0::/tenant/session\n',
        '/proc/self/mountinfo': '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
        '/sys/fs/cgroup/tenant/session/memory.max': String(16 * GIB),
        '/sys/fs/cgroup/tenant/session/memory.current': String(2 * GIB),
        '/sys/fs/cgroup/tenant/session/memory.stat': 'inactive_file 0\n',
        '/sys/fs/cgroup/tenant/session/memory.pressure': 'full avg10=1.00 avg60=0.00 avg300=0.00 total=0\n',
        '/sys/fs/cgroup/tenant/memory.max': String(8 * GIB),
        '/sys/fs/cgroup/tenant/memory.current': String(7 * GIB),
        '/sys/fs/cgroup/tenant/memory.stat': 'inactive_file 0\n',
        '/sys/fs/cgroup/tenant/memory.pressure': 'full avg10=1.00 avg60=0.00 avg300=0.00 total=0\n',
        '/sys/fs/cgroup/memory.max': 'max\n',
      }),
    });
    expect(pressure.cgroupBoundaries).toHaveLength(2);
    const decision = evaluateWorkerAdmission(pressure);
    expect(decision.allowed).toBe(false);
    expect(decision.pressure.totalMemoryBytes).toBe(8 * GIB);
    expect(decision.reasons).toEqual(['available memory 1.0 GiB is below the reserved 2.0 GiB']);
  });

  it('fails open instead of trusting a partial hierarchy when mountinfo is unavailable', () => {
    const pressure = readHostMemoryPressure({
      platform: 'linux',
      totalMemoryBytes: 32 * GIB,
      readFile: fixtureReader({
        '/proc/self/cgroup': '0::/docker/demo\n',
        '/sys/fs/cgroup/docker/demo/memory.max': 'max\n',
        '/sys/fs/cgroup/docker/memory.max': 'max\n',
        '/sys/fs/cgroup/memory.max': 'max\n',
        '/proc/meminfo': 'MemAvailable: 1 kB\n',
      }),
    });
    expect(pressure.availableMemoryBytes).toBeUndefined();
    expect(pressure.availableMemorySource).toBe('unavailable');
    expect(pressure.warnings.join('\n')).toContain('does not expose the full cgroup-v2 hierarchy');
  });

  it('falls back to host metrics when the cgroup hierarchy is unlimited', () => {
    const pressure = readHostMemoryPressure({
      platform: 'linux',
      totalMemoryBytes: 32 * GIB,
      readFile: fixtureReader({
        '/proc/self/cgroup': '0::/docker/demo\n',
        '/proc/self/mountinfo': '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
        '/sys/fs/cgroup/docker/demo/memory.max': 'max\n',
        '/sys/fs/cgroup/docker/memory.max': 'max\n',
        '/sys/fs/cgroup/memory.max': 'max\n',
        '/proc/meminfo': 'MemAvailable: 12582912 kB\n',
        '/proc/pressure/memory': 'full avg10=3.00 avg60=0.00 avg300=0.00 total=0\n',
      }),
    });
    expect(pressure.totalMemoryBytes).toBe(32 * GIB);
    expect(pressure.availableMemoryBytes).toBe(12 * GIB);
    expect(pressure.memoryFullAvg10).toBe(3);
    expect(pressure.totalMemorySource).toBe('host');
  });

  it('does not mix host availability into a finite cgroup with missing current usage', () => {
    const pressure = readHostMemoryPressure({
      platform: 'linux',
      totalMemoryBytes: 32 * GIB,
      readFile: fixtureReader({
        '/proc/self/cgroup': '0::/docker/demo\n',
        '/proc/self/mountinfo': '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
        '/sys/fs/cgroup/docker/demo/memory.max': String(8 * GIB),
        '/sys/fs/cgroup/docker/demo/memory.pressure': 'full avg10=1.00 avg60=0.00 avg300=0.00 total=0\n',
        '/proc/meminfo': 'MemAvailable: 1 kB\n',
      }),
    });
    expect(pressure.totalMemorySource).toBe('cgroup-v2');
    expect(pressure.availableMemoryBytes).toBeUndefined();
    expect(pressure.availableMemorySource).toBe('unavailable');
    expect(pressure.memoryFullAvg10).toBe(1);
    expect(evaluateWorkerAdmission(pressure).allowed).toBe(true);
  });

  it('blocks low available memory or critical full PSI and permits normal pressure', () => {
    const normal = evaluateWorkerAdmission(hostPressure({
      availableMemoryBytes: 12 * GIB,
      availableMemorySource: 'host',
      memoryFullAvg10: 1,
      memoryFullAvg10Source: 'host',
    }));
    expect(normal.allowed).toBe(true);
    expect(normal.policy.minAvailableMemoryBytes).toBe(4 * GIB);
    expect(normal.policy.maxMemoryFullAvg10).toBe(DEFAULT_MAX_MEMORY_FULL_AVG10);

    expect(evaluateWorkerAdmission(hostPressure({
      availableMemoryBytes: 2 * GIB,
      availableMemorySource: 'host',
      memoryFullAvg10: 1,
      memoryFullAvg10Source: 'host',
    })).allowed).toBe(false);
    expect(evaluateWorkerAdmission(hostPressure({
      availableMemoryBytes: 12 * GIB,
      availableMemorySource: 'host',
      memoryFullAvg10: 35,
      memoryFullAvg10Source: 'host',
    })).allowed).toBe(false);
  });

  it('caps the default reserve at the 4 GiB spawn-cost floor instead of scaling with host capacity', () => {
    // The cap must never drift below the host floor, or the host Math.max leg
    // would silently revive a sub-floor fractional reserve.
    expect(DEFAULT_MIN_AVAILABLE_MEMORY_CAP_BYTES).toBeGreaterThanOrEqual(DEFAULT_MIN_AVAILABLE_MEMORY_BYTES);
    // host: max(4 GiB floor, min(4 GiB cap, 25% of total)) — uniformly 4 GiB
    for (const [totalGiB, expectedGiB] of [
      [8, 4], [16, 4], [32, 4], [64, 4], [248, 4],
    ] as const) {
      expect(
        resolveWorkerPressurePolicy(undefined, totalGiB * GIB, 'host').minAvailableMemoryBytes,
      ).toBe(expectedGiB * GIB);
    }
    // cgroup-v2: min(4 GiB cap, 25% of the finite limit) with no host floor
    for (const [totalGiB, expectedGiB] of [
      [8, 2], [16, 4], [32, 4], [64, 4], [248, 4],
    ] as const) {
      expect(
        resolveWorkerPressurePolicy(undefined, totalGiB * GIB, 'cgroup-v2').minAvailableMemoryBytes,
      ).toBe(expectedGiB * GIB);
    }
  });

  it('admits a worker with tens of GiB free on a huge host while PSI stays healthy', () => {
    // Production incident: 247.5 GiB host, 60.1 GiB available, PSI full avg10
    // at 0% was reported as "Memory pressure is critical" because the uncapped
    // 25% reserve demanded 61.9 GiB.
    const decision = evaluateWorkerAdmission(hostPressure({
      totalMemoryBytes: 248 * GIB,
      availableMemoryBytes: Math.round(60.1 * GIB),
      availableMemorySource: 'host',
      memoryFullAvg10: 0,
      memoryFullAvg10Source: 'host',
    }));
    expect(decision.policy.minAvailableMemoryBytes).toBe(4 * GIB);
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).toEqual([]);

    // The byte backstop still bites when the huge host is genuinely drained.
    const drained = evaluateWorkerAdmission(hostPressure({
      totalMemoryBytes: 248 * GIB,
      availableMemoryBytes: 3 * GIB,
      availableMemorySource: 'host',
      memoryFullAvg10: 0,
      memoryFullAvg10Source: 'host',
    }));
    expect(drained.allowed).toBe(false);
    expect(drained.reasons).toEqual([
      'available memory 3.0 GiB is below the reserved 4.0 GiB',
    ]);

    // Real contention is PSI's job: with the capped reserve met, full avg10 at
    // the limit still blocks independently of total/available bytes.
    const stalled = evaluateWorkerAdmission(hostPressure({
      totalMemoryBytes: 248 * GIB,
      availableMemoryBytes: 60 * GIB,
      availableMemorySource: 'host',
      memoryFullAvg10: 25,
      memoryFullAvg10Source: 'host',
    }));
    expect(stalled.allowed).toBe(false);
    expect(stalled.reasons).toEqual([
      'memory full PSI avg10 25.00% reached 20.00%',
    ]);
  });

  it('honours policy overrides without changing any resident-worker ceiling', () => {
    expect(resolveWorkerPressurePolicy({
      memoryAdmissionEnabled: false,
      minAvailableMemoryBytes: 2 * GIB,
      maxMemoryFullAvg10: 40,
      sessionMemoryMaxBytes: 6 * GIB,
    }, 32 * GIB)).toEqual({
      memoryAdmissionEnabled: false,
      minAvailableMemoryBytes: 2 * GIB,
      maxMemoryFullAvg10: 40,
      sessionMemoryMaxBytes: 6 * GIB,
      memoryAdmissionEnabledSource: 'config',
      minAvailableMemorySource: 'config',
      maxMemoryFullAvg10Source: 'config',
    });
  });

  it('explicitly disables admission without reading pressure files', () => {
    const readFile = vi.fn(() => { throw new Error('must not read'); });
    const decision = checkWorkerAdmission({ memoryAdmissionEnabled: false }, {
      platform: 'linux',
      totalMemoryBytes: 8 * GIB,
      readFile,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.policy.memoryAdmissionEnabled).toBe(false);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('fails open when proc pressure files are unavailable', () => {
    const pressure = readHostMemoryPressure({
      platform: 'linux',
      totalMemoryBytes: 8 * GIB,
      readFile: () => { throw new Error('not mounted'); },
    });
    const decision = evaluateWorkerAdmission(pressure);
    expect(decision.allowed).toBe(true);
    expect(pressure.warnings).toHaveLength(1);
    expect(pressure.availableMemorySource).toBe('unavailable');
  });

  it('fails open when proc pressure files are present but malformed', () => {
    const pressure = readHostMemoryPressure({
      platform: 'linux',
      totalMemoryBytes: 8 * GIB,
      readFile: () => 'not a supported proc fixture',
    });
    const decision = evaluateWorkerAdmission(pressure);
    expect(decision.allowed).toBe(true);
    expect(pressure.availableMemoryBytes).toBeUndefined();
    expect(pressure.memoryFullAvg10).toBeUndefined();
    expect(pressure.warnings).toEqual([
      '/proc/meminfo has no valid MemAvailable value',
      '/proc/pressure/memory has no valid full avg10 value',
    ]);
  });

  it('keeps non-Linux admission fail-open', () => {
    const pressure = readHostMemoryPressure({ platform: 'darwin', totalMemoryBytes: 16 * GIB });
    expect(evaluateWorkerAdmission(pressure).allowed).toBe(true);
    expect(pressure.totalMemorySource).toBe('host');
    expect(pressure.availableMemorySource).toBe('unavailable');
  });
});

describe('tierWorkerAdmission (allowed / marginal / hard)', () => {
  // Reserve pinned to 10 GiB so the marginal floor is an exact 9 GiB.
  const policyConfig = { minAvailableMemoryBytes: 10 * GIB } as const;

  function tierFor(available: number | undefined, psi: number | undefined) {
    const decision = evaluateWorkerAdmission(hostPressure({
      ...(available !== undefined
        ? { availableMemoryBytes: available, availableMemorySource: 'host' as const }
        : {}),
      ...(psi !== undefined
        ? { memoryFullAvg10: psi, memoryFullAvg10Source: 'host' as const }
        : {}),
    }), policyConfig);
    return { tier: tierWorkerAdmission(decision), decision };
  }

  it('exposes the hard-coded 10% marginal band with no config knob', () => {
    expect(MARGINAL_AVAILABLE_MEMORY_MARGIN).toBeCloseTo(0.1);
  });

  it('tier is allowed when admission passes', () => {
    expect(tierFor(12 * GIB, 1).tier).toBe('allowed');
  });

  it('marginal exactly at reserve*(1-MARGIN) (9 GiB of a 10 GiB reserve)', () => {
    expect(tierFor(9 * GIB, 1).tier).toBe('marginal');
  });

  it('marginal just inside the band (9.5 GiB)', () => {
    expect(tierFor(9.5 * GIB, 1).tier).toBe('marginal');
  });

  it('hard just beyond the band (8.9 GiB)', () => {
    expect(tierFor(8.9 * GIB, 1).tier).toBe('hard');
  });

  it('hard at zero available memory', () => {
    expect(tierFor(0, 1).tier).toBe('hard');
  });

  it('PSI hit alone is always hard even with ample memory', () => {
    expect(tierFor(12 * GIB, DEFAULT_MAX_MEMORY_FULL_AVG10).tier).toBe('hard');
    expect(tierFor(12 * GIB, 40).tier).toBe('hard');
  });

  it('PSI hit is hard even when the memory shortfall is within the marginal band', () => {
    expect(tierFor(9.5 * GIB, DEFAULT_MAX_MEMORY_FULL_AVG10).tier).toBe('hard');
  });

  it('stays allowed (fail-open tier) when metrics are unavailable', () => {
    expect(tierFor(undefined, undefined).tier).toBe('allowed');
  });

  it('marginal tier is reachable through a /proc fixture (host reader)', () => {
    // Total 32 GiB, reserve overridden to 10 GiB → floor 9 GiB; MemAvailable
    // 9.5 GiB (9961472 kB) with calm PSI must classify marginal end-to-end.
    const decision = checkWorkerAdmission(policyConfig, {
      platform: 'linux',
      totalMemoryBytes: 32 * GIB,
      readFile: fixtureReader({
        '/proc/self/cgroup': '1:name=systemd:/\n',
        '/proc/meminfo': 'MemTotal:       33554432 kB\nMemAvailable:    9961472 kB\n',
        '/proc/pressure/memory': 'some avg10=1.00 avg60=2.00 avg300=3.00 total=1\nfull avg10=3.00 avg60=2.00 avg300=1.00 total=2\n',
      }),
    });
    expect(decision.allowed).toBe(false);
    expect(tierWorkerAdmission(decision)).toBe('marginal');
  });

  it('hard tier is reachable through a /proc fixture when PSI is critical', () => {
    const decision = checkWorkerAdmission(policyConfig, {
      platform: 'linux',
      totalMemoryBytes: 32 * GIB,
      readFile: fixtureReader({
        '/proc/self/cgroup': '1:name=systemd:/\n',
        '/proc/meminfo': 'MemTotal:       33554432 kB\nMemAvailable:    9961472 kB\n',
        '/proc/pressure/memory': 'full avg10=35.00 avg60=10.00 avg300=5.00 total=2\n',
      }),
    });
    expect(decision.allowed).toBe(false);
    expect(tierWorkerAdmission(decision)).toBe('hard');
  });

  it('marginal tier is reachable through a cgroup-v2 fixture', () => {
    // 40 GiB cgroup → capped default reserve 4 GiB → marginal floor 3.6 GiB;
    // current 36.25 GiB (no inactive file) leaves 3.75 GiB available, PSI
    // calm → marginal. The reserve is capped at 4 GiB (large-host fix); before
    // the cap it was 25% × 40 = 10 GiB and this fixture used current 30.5 GiB.
    const decision = checkWorkerAdmission(undefined, {
      platform: 'linux',
      totalMemoryBytes: 64 * GIB,
      readFile: fixtureReader({
        '/proc/self/cgroup': '0::/docker/demo\n',
        '/proc/self/mountinfo': '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
        '/sys/fs/cgroup/docker/demo/memory.max': String(40 * GIB),
        '/sys/fs/cgroup/docker/demo/memory.current': String(36.25 * GIB),
        '/sys/fs/cgroup/docker/demo/memory.stat': 'inactive_file 0\n',
        '/sys/fs/cgroup/docker/demo/memory.pressure': 'full avg10=2.00 avg60=0.00 avg300=0.00 total=0\n',
        '/sys/fs/cgroup/docker/memory.max': 'max\n',
        '/sys/fs/cgroup/memory.max': 'max\n',
        '/proc/meminfo': 'MemAvailable: 1 kB\n',
        '/proc/pressure/memory': 'full avg10=99.00 avg60=0.00 avg300=0.00 total=0\n',
      }),
    });
    expect(decision.allowed).toBe(false);
    expect(tierWorkerAdmission(decision)).toBe('marginal');
  });
});
