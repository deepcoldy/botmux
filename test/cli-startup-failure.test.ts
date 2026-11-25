import { describe, expect, it } from 'vitest';
import { isCliStartupFailure } from '../src/core/cli-startup-failure.js';
const waiting = { code: 1, fresh: true, ready: false, argvTurnUnstarted: false,
  structuredInputWaiting: true, nativeInputSeen: false, elapsedMs: 2_000 };
describe('observed CLI startup exit classification', () => {
  it('counts actual unready nonzero exits even after slow initialization', () => {
    expect(isCliStartupFailure(waiting)).toBe(true);
    expect(isCliStartupFailure({ ...waiting, elapsedMs: 5 * 60_000 })).toBe(true);
  });
  it('does not let a dead quiet pane claim readiness without its first native input', () => {
    expect(isCliStartupFailure({ ...waiting, ready: true })).toBe(true);
    expect(isCliStartupFailure({ ...waiting, ready: true, nativeInputSeen: true })).toBe(false);
  });
  it.each([0, null])('never treats a clean/signal exit (%s) as a startup failure', code => {
    expect(isCliStartupFailure({ ...waiting, code })).toBe(false);
  });
  it('leaves warm reattach/adopt/outage/intentional replacement to their existing owners', () => {
    expect(isCliStartupFailure({ ...waiting, fresh: false })).toBe(false);
  });
  it('does not treat a healthy ready idle CLI or a long-running turn as a fast startup failure', () => {
    expect(isCliStartupFailure({ ...waiting, ready: true, structuredInputWaiting: false })).toBe(false);
    expect(isCliStartupFailure({ ...waiting, ready: true, elapsedMs: 120_000 })).toBe(false);
  });
  it('retains argv opening failure evidence after a heuristic ready edge', () => {
    expect(isCliStartupFailure({ ...waiting, ready: true, elapsedMs: 120_000, argvTurnUnstarted: true })).toBe(true);
  });
});
