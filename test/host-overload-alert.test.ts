import { describe, expect, it } from 'bun:test';
import {
  evaluateOverload,
  formatOverloadAlert,
  buildOverloadAlertCard,
  buildOverloadRecoveredCard,
  buildOverloadExpiredCard,
  initialOverloadCardState,
  computeOverloadThresholds,
  parseOverloadEnvFloat,
  isValidEnterLoadRatio,
  isValidEnterMemUsedFrac,
  isOverloadAlertTarget,
  OVERLOAD_ACTION_CLEAN_STOPPED,
  OVERLOAD_ACTION_SUSPEND_IDLE,
  OVERLOAD_ACTION_NOOP,
  DEFAULT_OVERLOAD_THRESHOLDS,
  INITIAL_OVERLOAD_STATE,
  type HostReading,
  type OverloadThresholds,
} from '../src/core/host-overload-alert.js';
import {
  registerOverloadNonce,
  claimOverloadNonce,
  releaseOverloadNonce,
  _resetOverloadNoncesForTest,
} from '../src/im/lark/overload-nonce.js';

const GB = 1024 * 1024 * 1024;

function thresholds(overrides: Partial<OverloadThresholds> = {}): OverloadThresholds {
  return { cpuCount: 10, ...DEFAULT_OVERLOAD_THRESHOLDS, ...overrides };
}

/** Healthy baseline: load well under cpuCount, memory comfortable, no swap. */
function healthy(overrides: Partial<HostReading> = {}): HostReading {
  return { load15: 3, memTotalBytes: 16 * GB, memFreeBytes: 12 * GB, ...overrides };
}

describe('evaluateOverload — load dimension', () => {
  it('stays healthy when load is under the enter line', () => {
    const { nextState, action } = evaluateOverload(INITIAL_OVERLOAD_STATE, healthy(), thresholds(), 1_000);
    expect(nextState.overloaded).toBe(false);
    expect(action).toBeUndefined();
  });

  it('fires exactly one "entered" alert on the healthy→overloaded edge', () => {
    // cpuCount 10, enterLoadRatio 1.5 → enter above 15.
    const reading = healthy({ load15: 20 });
    const { nextState, action } = evaluateOverload(INITIAL_OVERLOAD_STATE, reading, thresholds(), 1_000);
    expect(nextState.overloaded).toBe(true);
    expect(nextState.lastEnteredAlertAt).toBe(1_000);
    expect(action?.kind).toBe('entered');
    expect(action?.reasons).toContain('load');
  });

  it('does NOT re-alert while it stays overloaded', () => {
    const overloaded = { overloaded: true, lastEnteredAlertAt: 1_000 };
    const { nextState, action } = evaluateOverload(overloaded, healthy({ load15: 22 }), thresholds(), 2_000);
    expect(nextState.overloaded).toBe(true);
    expect(action).toBeUndefined();
  });

  it('applies hysteresis: does not recover between exit and enter lines', () => {
    // exitLoadRatio 1.0 → recover only at/below 10. load 12 is in the dead band.
    const overloaded = { overloaded: true, lastEnteredAlertAt: 1_000 };
    const { nextState, action } = evaluateOverload(overloaded, healthy({ load15: 12 }), thresholds(), 3_000);
    expect(nextState.overloaded).toBe(true);
    expect(action).toBeUndefined();
  });

  it('fires "recovered" once load falls to/below the exit line', () => {
    const overloaded = { overloaded: true, lastEnteredAlertAt: 1_000 };
    const { nextState, action } = evaluateOverload(overloaded, healthy({ load15: 9 }), thresholds(), 4_000);
    expect(nextState.overloaded).toBe(false);
    expect(action?.kind).toBe('recovered');
  });
});

describe('evaluateOverload — memory dimension', () => {
  it('enters on memory pressure alone (load calm)', () => {
    // enterMemUsedFrac 0.92 → used >= 92%. 16GB total, 1GB free = 93.75% used.
    const reading = healthy({ load15: 2, memFreeBytes: 1 * GB });
    const { nextState, action } = evaluateOverload(INITIAL_OVERLOAD_STATE, reading, thresholds(), 1_000);
    expect(nextState.overloaded).toBe(true);
    expect(action?.reasons).toEqual(['memory']);
  });

  it('does not recover until BOTH load and memory clear their exit lines', () => {
    const overloaded = { overloaded: true, lastEnteredAlertAt: 1_000 };
    // load recovered (8 <= 10) but memory still 90% used (> exit 85%): stay.
    const reading = healthy({ load15: 8, memFreeBytes: 1.6 * GB });
    const { nextState, action } = evaluateOverload(overloaded, reading, thresholds(), 5_000);
    expect(nextState.overloaded).toBe(true);
    expect(action).toBeUndefined();
  });
});

describe('evaluateOverload — min re-alert window', () => {
  it('suppresses a fresh "entered" alert within minReAlertMs of the last one', () => {
    // Episode 1 entered at t=1000. Recover, then re-enter within 15 min.
    const t = thresholds({ minReAlertMs: 15 * 60_000 });
    const afterRecover = { overloaded: false, lastEnteredAlertAt: 1_000 };
    // Re-enter at t=1000 + 5 min < 15 min window → state flips but no alert.
    const reEnter = evaluateOverload(afterRecover, healthy({ load15: 20 }), t, 1_000 + 5 * 60_000);
    expect(reEnter.nextState.overloaded).toBe(true);
    expect(reEnter.action).toBeUndefined();
    // lastEnteredAlertAt preserved so the window keeps counting from episode 1.
    expect(reEnter.nextState.lastEnteredAlertAt).toBe(1_000);
  });

  it('allows a fresh "entered" alert once the window has elapsed', () => {
    const t = thresholds({ minReAlertMs: 15 * 60_000 });
    const afterRecover = { overloaded: false, lastEnteredAlertAt: 1_000 };
    const reEnter = evaluateOverload(afterRecover, healthy({ load15: 20 }), t, 1_000 + 16 * 60_000);
    expect(reEnter.action?.kind).toBe('entered');
    expect(reEnter.nextState.lastEnteredAlertAt).toBe(1_000 + 16 * 60_000);
  });

  it('never rate-limits the recovered alert', () => {
    const overloaded = { overloaded: true, lastEnteredAlertAt: 999_999_999 };
    const { action } = evaluateOverload(overloaded, healthy({ load15: 5 }), thresholds(), 1_000);
    expect(action?.kind).toBe('recovered');
  });
});

describe('evaluateOverload — edge cases', () => {
  it('treats cpuCount<=0 as "load dimension disabled"', () => {
    const t = thresholds({ cpuCount: 0 });
    const { nextState, action } = evaluateOverload(INITIAL_OVERLOAD_STATE, healthy({ load15: 999 }), t, 1_000);
    expect(nextState.overloaded).toBe(false);
    expect(action).toBeUndefined();
  });

  it('ignores swap when the reading omits it', () => {
    const reading = healthy({ load15: 20 }); // no swap fields
    const { action } = evaluateOverload(INITIAL_OVERLOAD_STATE, reading, thresholds(), 1_000);
    expect(action?.reasons).not.toContain('swap');
  });
});

describe('formatOverloadAlert', () => {
  it('renders an entered alert with the tripped dimensions and remediation', () => {
    const reading = healthy({ load15: 30 });
    const { action } = evaluateOverload(INITIAL_OVERLOAD_STATE, reading, thresholds(), 1_000);
    const text = formatOverloadAlert(action!, 'mac-mini');
    expect(text).toContain('⚠️ 机器过载告警');
    expect(text).toContain('mac-mini');
    expect(text).toContain('CPU 负载');
    expect(text).toContain('maxLiveWorkers');
  });

  it('renders a recovered alert', () => {
    const overloaded = { overloaded: true, lastEnteredAlertAt: 1_000 };
    const { action } = evaluateOverload(overloaded, healthy({ load15: 5 }), thresholds(), 2_000);
    const text = formatOverloadAlert(action!);
    expect(text).toContain('✅ 机器负载已恢复');
  });
});

describe('buildOverloadAlertCard (stateful, two persistent buttons)', () => {
  function enteredState() {
    const { action } = evaluateOverload(INITIAL_OVERLOAD_STATE, healthy({ load15: 30 }), thresholds(), 1_000);
    return initialOverloadCardState(action!, { stopped: 4, idle: 7 }, 'nonce-123');
  }

  it('initial card shows both live buttons with candidate counts + carries state', () => {
    const card = JSON.parse(buildOverloadAlertCard(enteredState()));
    expect(card.header.template).toBe('red');
    const actionEl = card.elements.find((e: any) => e.tag === 'action');
    const [clean, suspend] = actionEl.actions;
    expect(clean.text.content).toContain('(4)');
    expect(suspend.text.content).toContain('(7)');
    expect(clean.value.action).toBe(OVERLOAD_ACTION_CLEAN_STOPPED);
    expect(suspend.value.action).toBe(OVERLOAD_ACTION_SUSPEND_IDLE);
    // Each live button carries the serialized state (so any daemon can rebuild).
    expect(JSON.parse(clean.value.st).nonce).toBe('nonce-123');
    expect(clean.disabled).toBeFalsy();
    expect(suspend.disabled).toBeFalsy();
  });

  it('header/body always show the current candidate counts before any click', () => {
    const card = JSON.parse(buildOverloadAlertCard(enteredState()));
    const body = card.elements.map((e: any) => e.text?.content ?? '').join('\n');
    expect(body).toContain('僵尸会话 4 个');
    expect(body).toContain('闲置会话 7 个');
  });

  it('after clean: clean button is disabled with ✓done, suspend stays live (both visible)', () => {
    const st = { ...enteredState(), cleanedN: 3, stopped: 0 };
    const card = JSON.parse(buildOverloadAlertCard(st));
    const actionEl = card.elements.find((e: any) => e.tag === 'action');
    const [clean, suspend] = actionEl.actions;
    // Clicked button: disabled, shows result, becomes a harmless noop.
    expect(clean.disabled).toBe(true);
    expect(clean.text.content).toContain('已清理 3');
    expect(clean.value.action).toBe(OVERLOAD_ACTION_NOOP);
    // Other button: STILL clickable (the whole point — the two buttons are independent).
    expect(suspend.disabled).toBeFalsy();
    expect(suspend.value.action).toBe(OVERLOAD_ACTION_SUSPEND_IDLE);
  });

  it('after both clicked: both disabled with their result counts', () => {
    const st = { ...enteredState(), cleanedN: 2, suspendedN: 5 };
    const card = JSON.parse(buildOverloadAlertCard(st));
    const [clean, suspend] = card.elements.find((e: any) => e.tag === 'action').actions;
    expect(clean.disabled).toBe(true);
    expect(suspend.disabled).toBe(true);
    expect(clean.text.content).toContain('已清理 2');
    expect(suspend.text.content).toContain('已挂起 5');
  });
});

describe('buildOverloadRecoveredCard / buildOverloadExpiredCard', () => {
  it('recovered card is display-only (no action buttons)', () => {
    const overloaded = { overloaded: true, lastEnteredAlertAt: 1_000 };
    const { action } = evaluateOverload(overloaded, healthy({ load15: 5 }), thresholds(), 2_000);
    const card = JSON.parse(buildOverloadRecoveredCard(action!));
    expect(card.header.template).toBe('green');
    expect(card.elements.find((e: any) => e.tag === 'action')).toBeUndefined();
  });

  it('expired card is grey and button-less', () => {
    const card = JSON.parse(buildOverloadExpiredCard());
    expect(card.header.template).toBe('grey');
    expect(card.elements.find((e: any) => e.tag === 'action')).toBeUndefined();
  });
});

describe('overload nonce (one-shot per action)', () => {
  it('claims once per (nonce, action); both buttons on one card each claim once', () => {
    _resetOverloadNoncesForTest();
    registerOverloadNonce('n1');
    expect(claimOverloadNonce('n1', OVERLOAD_ACTION_CLEAN_STOPPED)).toBe(true);
    // Second click of the SAME button → rejected.
    expect(claimOverloadNonce('n1', OVERLOAD_ACTION_CLEAN_STOPPED)).toBe(false);
    // The OTHER button on the same card → still allowed once.
    expect(claimOverloadNonce('n1', OVERLOAD_ACTION_SUSPEND_IDLE)).toBe(true);
    expect(claimOverloadNonce('n1', OVERLOAD_ACTION_SUSPEND_IDLE)).toBe(false);
  });

  it('rejects unknown / never-registered nonce (stale card after daemon restart)', () => {
    _resetOverloadNoncesForTest();
    expect(claimOverloadNonce('never-issued', OVERLOAD_ACTION_CLEAN_STOPPED)).toBe(false);
    expect(claimOverloadNonce('', OVERLOAD_ACTION_CLEAN_STOPPED)).toBe(false);
  });

  it('release re-opens a claim so a failed sweep can be retried (does not touch the other button)', () => {
    _resetOverloadNoncesForTest();
    registerOverloadNonce('n1');
    expect(claimOverloadNonce('n1', OVERLOAD_ACTION_CLEAN_STOPPED)).toBe(true);
    // Sweep failed → roll back this button's claim.
    releaseOverloadNonce('n1', OVERLOAD_ACTION_CLEAN_STOPPED);
    // Same button can be clicked again.
    expect(claimOverloadNonce('n1', OVERLOAD_ACTION_CLEAN_STOPPED)).toBe(true);
    // Releasing one action leaves the other button independently claimable.
    releaseOverloadNonce('n1', OVERLOAD_ACTION_CLEAN_STOPPED);
    expect(claimOverloadNonce('n1', OVERLOAD_ACTION_SUSPEND_IDLE)).toBe(true);
    // Release on an unknown nonce is a no-op (no throw).
    expect(() => releaseOverloadNonce('never-issued', OVERLOAD_ACTION_CLEAN_STOPPED)).not.toThrow();
  });
});

describe('parseOverloadEnvFloat', () => {
  it('parses a valid non-negative number (default predicate allows 0)', () => {
    expect(parseOverloadEnvFloat('2.5', 1)).toBe(2.5);
    expect(parseOverloadEnvFloat('0', 1)).toBe(0); // 0 is legal for exit lines / minReAlertMs
  });
  it('falls back on unset / blank / non-finite / negative', () => {
    expect(parseOverloadEnvFloat(undefined, 1.5)).toBe(1.5);
    expect(parseOverloadEnvFloat('   ', 1.5)).toBe(1.5);
    expect(parseOverloadEnvFloat('abc', 1.5)).toBe(1.5);
    expect(parseOverloadEnvFloat('-3', 1.5)).toBe(1.5);
    expect(parseOverloadEnvFloat('NaN', 1.5)).toBe(1.5);
  });
  it('honours a stricter isValid predicate (enter thresholds reject 0 / out-of-range)', () => {
    expect(parseOverloadEnvFloat('0', 1.5, isValidEnterLoadRatio)).toBe(1.5); // load must be > 0
    expect(parseOverloadEnvFloat('2', 1.5, isValidEnterLoadRatio)).toBe(2);
    expect(parseOverloadEnvFloat('0', 0.9, isValidEnterMemUsedFrac)).toBe(0.9); // mem must be > 0
    expect(parseOverloadEnvFloat('1.5', 0.9, isValidEnterMemUsedFrac)).toBe(0.9); // mem must be <= 1
    expect(parseOverloadEnvFloat('0.8', 0.9, isValidEnterMemUsedFrac)).toBe(0.8);
  });
});

describe('computeOverloadThresholds — enter priority (env > config > default)', () => {
  it('uses built-in defaults when neither env nor config is provided', () => {
    const t = computeOverloadThresholds({ cpuCount: 8 });
    expect(t.cpuCount).toBe(8);
    expect(t.enterLoadRatio).toBe(DEFAULT_OVERLOAD_THRESHOLDS.enterLoadRatio);
    expect(t.enterMemUsedFrac).toBe(DEFAULT_OVERLOAD_THRESHOLDS.enterMemUsedFrac);
    expect(t.exitLoadRatio).toBe(DEFAULT_OVERLOAD_THRESHOLDS.exitLoadRatio);
    expect(t.exitMemUsedFrac).toBe(DEFAULT_OVERLOAD_THRESHOLDS.exitMemUsedFrac);
    expect(t.minReAlertMs).toBe(DEFAULT_OVERLOAD_THRESHOLDS.minReAlertMs);
  });

  it('config enter values override the defaults', () => {
    const t = computeOverloadThresholds({
      cpuCount: 8,
      configEnterLoadRatio: 2.0,
      configEnterMemUsedFrac: 0.8,
    });
    expect(t.enterLoadRatio).toBe(2.0);
    expect(t.enterMemUsedFrac).toBe(0.8);
  });

  it('env enter values win over config', () => {
    const t = computeOverloadThresholds({
      cpuCount: 8,
      configEnterLoadRatio: 2.0,
      configEnterMemUsedFrac: 0.8,
      env: { enterLoadRatio: '3.0', enterMemUsedFrac: '0.7' },
    });
    expect(t.enterLoadRatio).toBe(3.0);
    expect(t.enterMemUsedFrac).toBe(0.7);
  });

  it('ignores garbage / out-of-range config enter values and falls back to default', () => {
    const t = computeOverloadThresholds({
      cpuCount: 8,
      configEnterLoadRatio: -1, // not positive
      configEnterMemUsedFrac: 1.5, // > 1
    });
    expect(t.enterLoadRatio).toBe(DEFAULT_OVERLOAD_THRESHOLDS.enterLoadRatio);
    expect(t.enterMemUsedFrac).toBe(DEFAULT_OVERLOAD_THRESHOLDS.enterMemUsedFrac);
  });

  it('rejects a degenerate env enter=0 (would break hysteresis / flap) and falls back', () => {
    // enter load 0 → 95% clamp is still 0, so "exit strictly below enter" is
    // impossible; enter mem 0 additionally flaps entered/recovered every tick.
    const t = computeOverloadThresholds({
      cpuCount: 8,
      configEnterLoadRatio: 2.0,
      configEnterMemUsedFrac: 0.8,
      env: { enterLoadRatio: '0', enterMemUsedFrac: '0' },
    });
    // env was invalid → fall back to the (valid) config values, NOT 0.
    expect(t.enterLoadRatio).toBe(2.0);
    expect(t.enterMemUsedFrac).toBe(0.8);
  });

  it('rejects an env enter mem > 1 (never triggers) and falls back to default', () => {
    const t = computeOverloadThresholds({ cpuCount: 8, env: { enterMemUsedFrac: '1.5' } });
    expect(t.enterMemUsedFrac).toBe(DEFAULT_OVERLOAD_THRESHOLDS.enterMemUsedFrac);
  });

  it('accepts a full-memory enter of exactly 1.0 (boundary)', () => {
    const t = computeOverloadThresholds({ cpuCount: 8, env: { enterMemUsedFrac: '1' } });
    expect(t.enterMemUsedFrac).toBe(1);
  });

  it('clamps cpuCount to at least 1', () => {
    expect(computeOverloadThresholds({ cpuCount: 0 }).cpuCount).toBe(1);
    expect(computeOverloadThresholds({ cpuCount: -4 }).cpuCount).toBe(1);
    expect(computeOverloadThresholds({ cpuCount: Number.NaN }).cpuCount).toBe(1);
  });
});

describe('computeOverloadThresholds — hysteresis (exit strictly below enter)', () => {
  it('keeps a valid exit that already sits below enter', () => {
    const t = computeOverloadThresholds({
      cpuCount: 8,
      env: { enterLoadRatio: '2.0', exitLoadRatio: '1.5', enterMemUsedFrac: '0.9', exitMemUsedFrac: '0.8' },
    });
    expect(t.enterLoadRatio).toBe(2.0);
    expect(t.exitLoadRatio).toBe(1.5);
    expect(t.enterMemUsedFrac).toBe(0.9);
    expect(t.exitMemUsedFrac).toBe(0.8);
  });

  it('clamps a misconfigured exit >= enter down to 95% of enter and warns', () => {
    const warnings: string[] = [];
    const t = computeOverloadThresholds({
      cpuCount: 8,
      env: { enterLoadRatio: '1.0', exitLoadRatio: '2.0', enterMemUsedFrac: '0.5', exitMemUsedFrac: '0.9' },
      warn: (m) => warnings.push(m),
    });
    // exit was >= enter for BOTH dimensions → both clamped to 0.95 * enter.
    expect(t.exitLoadRatio).toBeCloseTo(0.95, 10);
    expect(t.exitMemUsedFrac).toBeCloseTo(0.475, 10);
    expect(t.exitLoadRatio).toBeLessThan(t.enterLoadRatio);
    expect(t.exitMemUsedFrac).toBeLessThan(t.enterMemUsedFrac);
    expect(warnings.length).toBe(2);
    expect(warnings.some(w => w.includes('EXIT_LOAD_RATIO'))).toBe(true);
    expect(warnings.some(w => w.includes('EXIT_MEM_FRAC'))).toBe(true);
  });

  it('clamps exit == enter (the flapping boundary) too, not just exit > enter', () => {
    const t = computeOverloadThresholds({
      cpuCount: 8,
      env: { enterLoadRatio: '1.5', exitLoadRatio: '1.5', enterMemUsedFrac: '0.9', exitMemUsedFrac: '0.9' },
    });
    expect(t.exitLoadRatio).toBeLessThan(t.enterLoadRatio);
    expect(t.exitMemUsedFrac).toBeLessThan(t.enterMemUsedFrac);
  });

  it('the clamped thresholds actually stop the state machine from flapping at the enter line', () => {
    // Enter mem 0.9, exit misconfigured to 0.9 → clamp to 0.855. A reading pinned
    // exactly at 0.9 must NOT recover on the next tick (the whole point of the gap).
    const t = computeOverloadThresholds({
      cpuCount: 10,
      env: { enterMemUsedFrac: '0.9', exitMemUsedFrac: '0.9' },
    });
    const at90 = { load15: 1, memTotalBytes: 100, memFreeBytes: 10 }; // 90% used
    const entered = evaluateOverload(INITIAL_OVERLOAD_STATE, at90, { cpuCount: 10, ...DEFAULT_OVERLOAD_THRESHOLDS, ...t }, 1_000);
    expect(entered.nextState.overloaded).toBe(true);
    const stillPinned = evaluateOverload(entered.nextState, at90, { cpuCount: 10, ...DEFAULT_OVERLOAD_THRESHOLDS, ...t }, 2_000);
    expect(stillPinned.nextState.overloaded).toBe(true); // did not flap back to healthy
    expect(stillPinned.action).toBeUndefined();
  });

  it('passes through minReAlertMs from env, else default', () => {
    expect(computeOverloadThresholds({ cpuCount: 8, env: { minReAlertMs: '60000' } }).minReAlertMs).toBe(60000);
    expect(computeOverloadThresholds({ cpuCount: 8 }).minReAlertMs).toBe(DEFAULT_OVERLOAD_THRESHOLDS.minReAlertMs);
  });
});

describe('isOverloadAlertTarget — machine-level target gating', () => {
  const SELF = 'cli_self';

  it('true only when enabled AND this daemon is the named target', () => {
    expect(isOverloadAlertTarget({ enabled: true, targetBotAppId: SELF }, SELF)).toBe(true);
    expect(isOverloadAlertTarget({ enabled: true, targetBotAppId: SELF }, { larkAppId: SELF })).toBe(true);
  });

  it('false when disabled, even if this daemon is the target', () => {
    expect(isOverloadAlertTarget({ enabled: false, targetBotAppId: SELF }, SELF)).toBe(false);
  });

  it('false when the target is a different bot (other daemons must no-op + reset)', () => {
    expect(isOverloadAlertTarget({ enabled: true, targetBotAppId: 'cli_other' }, SELF)).toBe(false);
  });

  it('false when no target is set, or config is empty / undefined', () => {
    expect(isOverloadAlertTarget({ enabled: true }, SELF)).toBe(false);
    expect(isOverloadAlertTarget({}, SELF)).toBe(false);
    expect(isOverloadAlertTarget(undefined, SELF)).toBe(false);
  });

  it('FAIL-CLOSED on apiOnly: an apiOnly bot never samples even if named as target', () => {
    // A hand-edited config or pre-apiOnly-aware migration could name an apiOnly
    // bot; it has no Feishu transport so it must not advance the state machine
    // and then silently drop the DM.
    expect(isOverloadAlertTarget({ enabled: true, targetBotAppId: SELF }, { larkAppId: SELF, apiOnly: true })).toBe(false);
    // Non-apiOnly (explicit false / omitted) still samples.
    expect(isOverloadAlertTarget({ enabled: true, targetBotAppId: SELF }, { larkAppId: SELF, apiOnly: false })).toBe(true);
  });

  it('models the target-switch → state-reset gate: non-target ticks are gated off', () => {
    // The watcher resets local state whenever the gate is false, so a bot that
    // was the target and then loses it stops sampling on the very next tick.
    let cfg: { enabled?: boolean; targetBotAppId?: string } = { enabled: true, targetBotAppId: SELF };
    expect(isOverloadAlertTarget(cfg, SELF)).toBe(true); // sampling
    cfg = { enabled: true, targetBotAppId: 'cli_other' }; // target switched away
    expect(isOverloadAlertTarget(cfg, SELF)).toBe(false); // → caller resets state, no stale edge
  });
});
