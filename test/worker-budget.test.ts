import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_MEMORY_FULL_AVG10,
  evaluateWorkerAdmission,
  readHostMemoryPressure,
  resolveWorkerPressurePolicy,
} from '../src/core/worker-budget.js';

const GIB = 1024 ** 3;

describe('worker host-memory admission', () => {
  it('parses MemAvailable and memory full PSI fixtures', () => {
    const pressure = readHostMemoryPressure({
      platform: 'linux',
      totalMemoryBytes: 32 * GIB,
      readFile: path => path.endsWith('meminfo')
        ? 'MemTotal:       33554432 kB\nMemAvailable:    6291456 kB\n'
        : 'some avg10=1.00 avg60=2.00 avg300=3.00 total=1\nfull avg10=7.25 avg60=2.00 avg300=1.00 total=2\n',
    });
    expect(pressure.availableMemoryBytes).toBe(6 * GIB);
    expect(pressure.memoryFullAvg10).toBe(7.25);
    expect(pressure.warnings).toEqual([]);
  });

  it('blocks low MemAvailable or critical full PSI and permits normal pressure', () => {
    const normal = evaluateWorkerAdmission({
      totalMemoryBytes: 32 * GIB,
      availableMemoryBytes: 12 * GIB,
      memoryFullAvg10: 1,
      warnings: [],
    });
    expect(normal.allowed).toBe(true);
    expect(normal.policy.minAvailableMemoryBytes).toBe(8 * GIB);
    expect(normal.policy.maxMemoryFullAvg10).toBe(DEFAULT_MAX_MEMORY_FULL_AVG10);

    expect(evaluateWorkerAdmission({
      totalMemoryBytes: 32 * GIB,
      availableMemoryBytes: 2 * GIB,
      memoryFullAvg10: 1,
      warnings: [],
    }).allowed).toBe(false);
    expect(evaluateWorkerAdmission({
      totalMemoryBytes: 32 * GIB,
      availableMemoryBytes: 12 * GIB,
      memoryFullAvg10: 35,
      warnings: [],
    }).allowed).toBe(false);
  });

  it('honours policy overrides without changing any resident-worker ceiling', () => {
    expect(resolveWorkerPressurePolicy({
      minAvailableMemoryBytes: 2 * GIB,
      maxMemoryFullAvg10: 40,
      sessionMemoryMaxBytes: 6 * GIB,
    }, 32 * GIB)).toEqual({
      minAvailableMemoryBytes: 2 * GIB,
      maxMemoryFullAvg10: 40,
      sessionMemoryMaxBytes: 6 * GIB,
      minAvailableMemorySource: 'config',
      maxMemoryFullAvg10Source: 'config',
    });
  });

  it('fails open when proc pressure files are unavailable', () => {
    const pressure = readHostMemoryPressure({
      platform: 'linux',
      totalMemoryBytes: 8 * GIB,
      readFile: () => { throw new Error('not mounted'); },
    });
    const decision = evaluateWorkerAdmission(pressure);
    expect(decision.allowed).toBe(true);
    expect(pressure.warnings).toHaveLength(2);
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
});
