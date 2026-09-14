import { describe, expect, it, vi } from 'vitest';
import {
  checkWorkerAdmission,
  DEFAULT_MAX_MEMORY_FULL_AVG10,
  evaluateWorkerAdmission,
  readHostMemoryPressure,
  resolveWorkerPressurePolicy,
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
    expect(normal.policy.minAvailableMemoryBytes).toBe(8 * GIB);
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
