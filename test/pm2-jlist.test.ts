import { describe, expect, it } from 'vitest';
import {
  parseCanonicalPm2Id,
  parsePm2JlistOutput,
  parsePm2JlistOutputStrict,
  parsePm2Integer,
} from '../src/cli/pm2-jlist.js';

describe('PM2 jlist projection parsing', () => {
  it.each(['{}', 'null', '"not-a-list"'])('rejects non-array shutdown authority: %s', output => {
    expect(() => parsePm2JlistOutputStrict(output)).toThrow(/non-array JSON/);
  });

  it('rejects malformed shutdown authority instead of treating it as an empty fleet', () => {
    expect(() => parsePm2JlistOutputStrict('[PM2] unavailable')).toThrow(/malformed output/);
  });

  it('accepts an array after PM2 informational output', () => {
    const row = { name: 'botmux', pm_id: 0, pid: 42, pm2_env: { status: 'online' } };
    expect(parsePm2JlistOutputStrict(`[PM2] daemon ready\n${JSON.stringify([row])}`))
      .toEqual([row]);
  });

  it('keeps read-only callers backward-compatible with empty fallback', () => {
    expect(parsePm2JlistOutput('{}')).toEqual([]);
  });

  it('never coerces absent PM2 identity or exit-code fields to zero', () => {
    expect(parsePm2Integer(null)).toBeUndefined();
    expect(parsePm2Integer(undefined)).toBeUndefined();
    expect(parsePm2Integer('')).toBeUndefined();
    expect(parsePm2Integer('0')).toBe(0);
    expect(parsePm2Integer(-1, { nonNegative: true })).toBeUndefined();
  });

  it('never revives a missing canonical pm_id from nested PM2 environment state', () => {
    expect(parseCanonicalPm2Id({ pm_id: null, pm2_env: { pm_id: 7 } })).toBeUndefined();
    expect(parseCanonicalPm2Id({ pm2_env: { pm_id: 7 } })).toBeUndefined();
    expect(parseCanonicalPm2Id({ pm_id: 8, pm2_env: { pm_id: 7 } })).toBe(8);
  });

  it.each([
    ['non-object row', '[null]', /row 0 is not an object/],
    ['missing name', '[{"pm_id":0,"pid":1,"pm2_env":{"status":"online"}}]', /non-empty name/],
    ['missing canonical id', '[{"name":"botmux","pid":1,"pm2_env":{"status":"online"}}]', /canonical non-negative pm_id/],
    ['invalid pid', '[{"name":"botmux","pm_id":0,"pid":null,"pm2_env":{"status":"online"}}]', /non-negative pid/],
    ['missing status', '[{"name":"botmux","pm_id":0,"pid":1,"pm2_env":{}}]', /pm2_env.status/],
  ])('rejects a syntactically valid but semantically unsafe %s', (_label, output, pattern) => {
    expect(() => parsePm2JlistOutputStrict(output)).toThrow(pattern as RegExp);
  });

  it('rejects duplicate canonical pm_id values even when the names differ', () => {
    const output = JSON.stringify([
      { name: 'botmux-a', pm_id: 4, pid: 41, pm2_env: { status: 'online' } },
      { name: 'botmux-b', pm_id: 4, pid: 42, pm2_env: { status: 'online' } },
    ]);
    expect(() => parsePm2JlistOutputStrict(output))
      .toThrow(/duplicate canonical pm_id 4 across botmux-a and botmux-b/);
  });

  it('rejects duplicate positive PIDs even across daemon and dashboard rows', () => {
    const output = JSON.stringify([
      { name: 'botmux-a', pm_id: 4, pid: 41, pm2_env: { status: 'online' } },
      { name: 'botmux-dashboard', pm_id: 5, pid: 41, pm2_env: { status: 'online' } },
    ]);
    expect(() => parsePm2JlistOutputStrict(output))
      .toThrow(/duplicate positive pid 41 across botmux-a and botmux-dashboard/);
  });
});
