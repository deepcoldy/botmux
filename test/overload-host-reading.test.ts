import { describe, expect, it } from 'vitest';
import { readOverloadHostReading, type OverloadHostReadingDeps } from '../src/core/overload-host-reading.js';
import { DEFAULT_OVERLOAD_THRESHOLDS, evaluateOverload, INITIAL_OVERLOAD_STATE } from '../src/core/host-overload-alert.js';

const GiB = 1024 ** 3;
const thresholds = { cpuCount: 12, ...DEFAULT_OVERLOAD_THRESHOLDS };
const defaults: OverloadHostReadingDeps = {
  totalmem: () => 36 * GiB,
  freemem: () => 0.25 * GiB,
  loadavg: () => [3, 4, 4.1],
};
function vmStat(free: number, inactive: number, speculative = 0): string {
  return `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: ${free}.
Pages inactive: ${inactive}.
Pages speculative: ${speculative}.
Pages purgeable: 100000.
Pages occupied by compressor: 100000.
`;
}

describe('host available memory drives overload decisions', () => {
  it('keeps a cache-heavy Mac healthy although os.freemem alone reports >99% used', () => {
    const reading = readOverloadHostReading({ ...defaults, platform: 'darwin', readVmStat: () => vmStat(16384, 1000000) });
    const before = evaluateOverload(INITIAL_OVERLOAD_STATE, { ...reading, memAvailableBytes: undefined }, thresholds, 1000);
    expect(before.action?.reasons).toEqual(['memory']);
    const after = evaluateOverload(INITIAL_OVERLOAD_STATE, reading, thresholds, 1000);
    expect(after.nextState.overloaded).toBe(false);
    expect(after.action).toBeUndefined();
  });

  it('enters once on real memory scarcity, waits through hysteresis, then recovers with reclaimable pages', () => {
    const sample = (inactive: number) => readOverloadHostReading({ ...defaults, platform: 'darwin', readVmStat: () => vmStat(0, inactive) });
    const entered = evaluateOverload(INITIAL_OVERLOAD_STATE, sample(65536), thresholds, 1000);
    expect(entered.action?.reasons).toEqual(['memory']);
    expect(entered.action?.metrics.memUsedFrac).toBeCloseTo(35 / 36);
    const steady = evaluateOverload(entered.nextState, sample(65536), thresholds, 2000);
    expect(steady.action).toBeUndefined();
    const deadBand = evaluateOverload(steady.nextState, sample(262144), thresholds, 3000);
    expect(deadBand.nextState.overloaded).toBe(true);
    expect(deadBand.action).toBeUndefined();
    const recovered = evaluateOverload(deadBand.nextState, sample(1000000), thresholds, 4000);
    expect(recovered.action?.kind).toBe('recovered');
    expect(recovered.action!.metrics.memUsedFrac).toBeLessThan(thresholds.exitMemUsedFrac);
  });

  it('alarms on zero reclaimable pages instead of treating exhaustion as missing data', () => {
    const reading = readOverloadHostReading({ ...defaults, platform: 'darwin', readVmStat: () => vmStat(0, 0) });
    expect(reading.memAvailableBytes).toBe(0);
    const result = evaluateOverload(INITIAL_OVERLOAD_STATE, reading, thresholds, 1000);
    expect(result.action?.reasons).toEqual(['memory']);
    expect(result.action?.metrics.memUsedFrac).toBe(1);
  });

  it('still reports high load when available memory is comfortable', () => {
    const reading = readOverloadHostReading({ ...defaults, platform: 'darwin', loadavg: () => [30, 30, 30], readVmStat: () => vmStat(0, 1000000) });
    expect(evaluateOverload(INITIAL_OVERLOAD_STATE, reading, thresholds, 1000).action?.reasons).toEqual(['load']);
  });

  it('uses Linux MemAvailable instead of MemFree for both entry and recovery', () => {
    const reading = readOverloadHostReading({ ...defaults, platform: 'linux', readMeminfo: () => 'MemTotal: 16777216 kB\nMemFree: 1024 kB\nMemAvailable: 8388608 kB\n' });
    expect(reading.memTotalBytes).toBe(16 * GiB);
    expect(evaluateOverload(INITIAL_OVERLOAD_STATE, reading, thresholds, 1000).action).toBeUndefined();
    const recovered = evaluateOverload({ overloaded: true, lastEnteredAlertAt: 1000 }, reading, thresholds, 2000);
    expect(recovered.action?.kind).toBe('recovered');
    expect(recovered.action?.metrics.memUsedFrac).toBe(0.5);
  });

  it('does not replace a valid Linux zero-available counter with MemFree', () => {
    const reading = readOverloadHostReading({ ...defaults, platform: 'linux', readMeminfo: () => 'MemTotal: 16777216 kB\nMemFree: 8388608 kB\nMemAvailable: 0 kB\n' });
    expect(evaluateOverload(INITIAL_OVERLOAD_STATE, reading, thresholds, 1000).action?.reasons).toEqual(['memory']);
  });

  it('retains the monitor fallback for a Linux kernel without MemAvailable', () => {
    const reading = readOverloadHostReading({ ...defaults, platform: 'linux', readMeminfo: () => 'MemTotal: 16777216 kB\nMemFree: 8388608 kB\n' });
    expect(evaluateOverload(INITIAL_OVERLOAD_STATE, reading, thresholds, 1000).action).toBeUndefined();
  });

  it('retains legacy physical-free semantics on other platforms', () => {
    const reading = readOverloadHostReading({ ...defaults, platform: 'win32' });
    expect(reading.memAvailableBytes).toBeUndefined();
    expect(evaluateOverload(INITIAL_OVERLOAD_STATE, reading, thresholds, 1000).action?.reasons).toEqual(['memory']);
  });

  it.each([
    { label: 'native command failure', deps: { platform: 'darwin', readVmStat: () => { throw new Error('timeout'); } } },
    { label: 'truncated Mac counters', deps: { platform: 'darwin', readVmStat: () => 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.' } },
    { label: 'missing Linux counters', deps: { platform: 'linux', readMeminfo: () => 'MemTotal: 16777216 kB\n' } },
    { label: 'malformed Linux available counter', deps: { platform: 'linux', readMeminfo: () => 'MemTotal: 16777216 kB\nMemFree: 1024 kB\nMemAvailable: invalid\n' } },
    { label: 'newline-split Linux available counter', deps: { platform: 'linux', readMeminfo: () => 'MemTotal: 16777216 kB\nMemFree: 8388608 kB\nMemAvailable:\n0 kB\n' } },
    { label: 'CR-suffixed Linux available counter', deps: { platform: 'linux', readMeminfo: () => 'MemTotal: 16777216 kB\nMemFree: 8388608 kB\nMemAvailable: 0 kB\r\n' } },
    { label: 'invalid Linux total', deps: { platform: 'linux', readMeminfo: () => 'MemAvailable: 1024 kB\n' } },
    { label: 'out-of-bounds Mac counters', deps: { platform: 'darwin', readVmStat: () => vmStat(10000000, 0) } },
  ] satisfies { label: string; deps: OverloadHostReadingDeps }[])('rejects $label without substituting a different memory metric', ({ deps }) => {
    expect(() => readOverloadHostReading({ ...defaults, ...deps })).toThrow();
  });
});
