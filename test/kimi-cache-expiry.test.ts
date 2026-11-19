/**
 * The Kimi cache-expiry menu controller (core/kimi-cache-expiry.ts) against a
 * hand-driven clock: what a menu event decides, and that every automatic key
 * is bounded, verified and never repeated within one event.
 *
 * Pages come from the real classifier over the real captures, so "the
 * pointer moved" is the screen Kimi draws after a Down, not a flag.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KIMI_CACHE_EXPIRY_DECIDE_RETRIES,
  KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS,
  KIMI_CACHE_EXPIRY_WORKING_WINDOW_MS,
  KimiCacheExpiryController,
  applyKimiCacheExpiryAutoCompact,
  isKimiCacheExpiryAutoCompactEnabled,
  supportsKimiCacheExpiryAutoCompact,
  type KimiCacheExpiryDeps,
  type KimiCompactPressResult,
} from '../src/core/kimi-cache-expiry.js';
import { classifyStuckPage } from '../src/utils/stuck-detector.js';

const fixture = (name: string) => readFileSync(join(process.cwd(), 'test/fixtures/stuck-pages', name), 'utf-8');
const MENU = fixture('kimi-2.5.3-cache-expiry-idle-submit.txt');
const MENU_MOVED = fixture('kimi-2.5.3-cache-expiry-highlight-new-session.txt');
const COMPACTING = fixture('kimi-2.5.3-compacting-after-enter.txt');
const COMPOSER = fixture('kimi-2.5.3-composer-after-compact-resend.txt');

function rig(opts: { auto?: boolean; turnInFlight?: boolean; inputHeld?: boolean; screen?: string } = {}) {
  let now = 1_000_000;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const world = {
    auto: opts.auto ?? true,
    lifetime: 1,
    interrupts: 0,
    webInput: 0,
    paused: undefined as string | undefined,
    turnInFlight: opts.turnInFlight ?? true,
    inputHeld: opts.inputHeld ?? false,
    screen: opts.screen ?? MENU,
    /** A capture that fails: capturePage answers "unknown". */
    captureFails: false,
    /** What the standing input hold last saw (undefined = no hold). */
    heldScreen: undefined as string | undefined,
    working: false,
    /** What the guarded press does; default: like the guard — the page
     *  re-matches, then the veto is asked right before the write. */
    press: (veto: () => string | undefined): KimiCompactPressResult => {
      if (classifyStuckPage(world.screen, 'kimi') !== 'kimi cache expiry') return { kind: 'expired' };
      return veto() === undefined ? { kind: 'written' } : { kind: 'expired' };
    },
  };
  const presses: number[] = [];
  const cards: Array<{ reason: string; pageType: string | undefined; noticeKey?: string }> = [];
  const notices: string[] = [];
  const logs: string[] = [];
  const deps: KimiCacheExpiryDeps = {
    now: () => now,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimer: id => { timers = timers.filter(t => t.id !== id); },
    autoCompactEnabled: () => world.auto,
    lifetime: () => world.lifetime,
    interruptGeneration: () => world.interrupts,
    webInputGeneration: () => world.webInput,
    pausedReason: () => world.paused,
    turnInFlight: () => world.turnInFlight,
    inputHeld: () => world.inputHeld,
    capturePage: () => (world.captureFails ? undefined : { pageType: classifyStuckPage(world.screen, 'kimi'), screen: world.screen }),
    lastKnownPage: () => (world.heldScreen === undefined ? undefined
      : { pageType: classifyStuckPage(world.heldScreen, 'kimi'), screen: world.heldScreen }),
    pressCompact: async (lifetime, veto) => {
      presses.push(lifetime);
      return world.press(veto);
    },
    programStatusWorking: () => world.working,
    raiseCard: card => cards.push({ reason: card.reason, pageType: card.page.pageType, ...(card.noticeKey ? { noticeKey: card.noticeKey } : {}) }),
    notify: key => notices.push(key),
    log: m => logs.push(m),
  };
  const controller = new KimiCacheExpiryController(deps);
  /** Advance the clock, firing due timers (and the promises they start). */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter(t => t !== due);
      now = due.at;
      due.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    now = end;
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { controller, world, presses, cards, notices, logs, advance };
}

describe('KimiCacheExpiryController', () => {
  it('auto-compact on: presses once on the verified page and reports the start on `working`', async () => {
    const r = rig();
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.presses).toEqual([1]);
    r.world.screen = COMPACTING;
    r.world.working = true;
    r.controller.programStatusWorking();
    expect(r.notices).toEqual(['worker.kimi_cache_expiry.auto_started']);
    expect(r.cards).toEqual([]);
    // More frames of the same event never press again.
    r.controller.kick();
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_WORKING_WINDOW_MS * 2);
    expect(r.presses).toEqual([1]);
    expect(r.cards).toEqual([]);
  });

  it('auto-compact off: raises the card for the written turn, never presses', async () => {
    const r = rig({ auto: false });
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.presses).toEqual([]);
    expect(r.cards).toEqual([{ reason: 'turn_stalled', pageType: 'kimi cache expiry' }]);
  });

  it('pointer moved off "Compact and continue": card for the moved page, no key', async () => {
    const r = rig({ screen: MENU_MOVED });
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.presses).toEqual([]);
    expect(r.cards).toEqual([{ reason: 'turn_stalled', pageType: 'kimi cache expiry moved' }]);
  });

  it('the pointer moves between the decision and the key: the guard refuses, the card follows', async () => {
    const r = rig();
    r.world.press = () => {
      r.world.screen = MENU_MOVED;
      return { kind: 'expired' };
    };
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.presses).toHaveLength(1);
    expect(r.cards).toEqual([{ reason: 'turn_stalled', pageType: 'kimi cache expiry moved' }]);
    expect(r.notices).toEqual([]);
  });

  it.each([
    ['interrupted (/stop)', (w: ReturnType<typeof rig>['world']) => { w.interrupts += 1; }],
    ['someone typed into the terminal', (w: ReturnType<typeof rig>['world']) => { w.webInput += 1; }],
    ['paused (CLI restarting)', (w: ReturnType<typeof rig>['world']) => { w.paused = 'CLI restarting'; }],
  ])('never automatic when %s: the card is raised instead', async (_label, change) => {
    const r = rig();
    r.controller.menuShown();
    change(r.world);
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.presses).toEqual([]);
    expect(r.cards).toEqual([{ reason: 'turn_stalled', pageType: 'kimi cache expiry' }]);
  });

  it('nothing waits on the menu: stays pending until a held message kicks it', async () => {
    const r = rig({ turnInFlight: false, inputHeld: false });
    r.controller.menuShown();
    await r.advance(10_000);
    expect(r.presses).toEqual([]);
    expect(r.cards).toEqual([]);
    r.world.inputHeld = true;
    r.controller.kick();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.presses).toEqual([1]);
  });

  it('a held message on a resumed session gets the input_held card when auto-compact is off', async () => {
    const r = rig({ auto: false, turnInFlight: false, inputHeld: true });
    r.controller.kick();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.cards).toEqual([{ reason: 'input_held', pageType: 'kimi cache expiry' }]);
  });

  it('no `working` within the window and the menu still up: the card with the failure notice', async () => {
    const r = rig();
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.presses).toEqual([1]);
    await r.advance(KIMI_CACHE_EXPIRY_WORKING_WINDOW_MS - 1);
    expect(r.cards).toEqual([]);
    await r.advance(1);
    expect(r.cards).toEqual([{ reason: 'turn_stalled', pageType: 'kimi cache expiry', noticeKey: 'worker.kimi_cache_expiry.auto_failed' }]);
    expect(r.notices).toEqual([]);
    // Still the same event: no second automatic Enter.
    r.controller.kick();
    await r.advance(KIMI_CACHE_EXPIRY_WORKING_WINDOW_MS);
    expect(r.presses).toEqual([1]);
  });

  it('no `working` within the window but the menu is gone: an explicit notice, no card', async () => {
    const r = rig();
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    r.world.screen = COMPOSER;
    r.controller.menuGone();
    await r.advance(KIMI_CACHE_EXPIRY_WORKING_WINDOW_MS);
    expect(r.cards).toEqual([]);
    expect(r.notices).toEqual(['worker.kimi_cache_expiry.auto_unconfirmed']);
  });

  it('a late `working` (menu already gone) still counts as started', async () => {
    const r = rig();
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    r.world.screen = COMPACTING;
    r.controller.menuGone();
    await r.advance(3_000);
    r.world.working = true;
    r.controller.programStatusWorking();
    await r.advance(KIMI_CACHE_EXPIRY_WORKING_WINDOW_MS);
    expect(r.notices).toEqual(['worker.kimi_cache_expiry.auto_started']);
    expect(r.cards).toEqual([]);
  });

  it('a failed write raises the card with the write-failure notice', async () => {
    const r = rig();
    r.world.press = () => ({ kind: 'failed' });
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.cards).toEqual([{ reason: 'turn_stalled', pageType: 'kimi cache expiry', noticeKey: 'worker.kimi_cache_expiry.auto_write_failed' }]);
  });

  it('dedup is per menu event: the menu leaving and coming back is answered again', async () => {
    const r = rig();
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    r.world.working = true;
    r.controller.programStatusWorking();
    r.world.working = false;
    r.world.screen = COMPOSER;
    r.controller.menuGone();
    await r.advance(60_000);
    // The next idle submit: a new menu event.
    r.world.screen = MENU;
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.presses).toEqual([1, 1]);
  });

  it('a CLI replaced mid-attempt drops the attempt silently', async () => {
    const r = rig();
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    r.world.lifetime = 2;
    r.world.working = true;
    r.controller.programStatusWorking();
    await r.advance(KIMI_CACHE_EXPIRY_WORKING_WINDOW_MS);
    expect(r.notices).toEqual([]);
    expect(r.cards).toEqual([]);
  });

  it('an event opened under a replaced CLI is never decided; the new CLI\'s menu opens its own', async () => {
    const r = rig();
    r.controller.menuShown();
    r.world.lifetime = 2;
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.presses).toEqual([]);
    r.controller.kick();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.presses).toEqual([2]);
  });

  it('a capture that does not (yet) show the menu is retried boundedly', async () => {
    const r = rig();
    r.world.screen = COMPOSER;
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS * 2);
    expect(r.presses).toEqual([]);
    r.world.screen = MENU;
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.presses).toEqual([1]);

    const gone = rig();
    gone.world.screen = COMPOSER;
    gone.controller.menuShown();
    await gone.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS * (KIMI_CACHE_EXPIRY_DECIDE_RETRIES + 5));
    gone.world.screen = MENU;
    await gone.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS * 4);
    expect(gone.presses).toEqual([]);
    expect(gone.cards).toEqual([]);
  });
});

describe('KimiCacheExpiryController: what changes while the key is on its way', () => {
  it.each([
    ['an Esc / Ctrl-C (interrupt)', (w: ReturnType<typeof rig>['world']) => { w.interrupts += 1; }],
    ['a keystroke in the web terminal', (w: ReturnType<typeof rig>['world']) => { w.webInput += 1; }],
    ['the setting turned off', (w: ReturnType<typeof rig>['world']) => { w.auto = false; }],
    ['a CLI restart starting', (w: ReturnType<typeof rig>['world']) => { w.paused = 'CLI restarting'; }],
  ])('%s during the guard\'s capture refuses the key; the card follows while the menu is up', async (_label, change) => {
    const r = rig();
    const press = r.world.press;
    r.world.press = veto => { change(r.world); return press(veto); };
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.presses).toHaveLength(1);
    expect(r.cards).toEqual([{ reason: 'turn_stalled', pageType: 'kimi cache expiry' }]);
    r.world.working = true;
    r.controller.programStatusWorking();
    await r.advance(KIMI_CACHE_EXPIRY_WORKING_WINDOW_MS);
    expect(r.notices).toEqual([]);
  });

  it('an Esc that took the menu away during the capture: no key, no card, no "started"', async () => {
    const r = rig();
    const press = r.world.press;
    r.world.press = veto => { r.world.interrupts += 1; const out = press(veto); r.world.screen = COMPOSER; return out; };
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    r.world.working = true;
    r.controller.programStatusWorking();
    await r.advance(KIMI_CACHE_EXPIRY_WORKING_WINDOW_MS);
    expect(r.cards).toEqual([]);
    expect(r.notices).toEqual([]);
  });
});

describe('KimiCacheExpiryController: a capture that fails is unknown, never "the menu is gone"', () => {
  it('no `working` and no capture at the window\'s end, the hold still on the menu: the failure card', async () => {
    const r = rig();
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    r.world.captureFails = true;
    r.world.heldScreen = MENU;
    await r.advance(KIMI_CACHE_EXPIRY_WORKING_WINDOW_MS);
    expect(r.cards).toEqual([{ reason: 'turn_stalled', pageType: 'kimi cache expiry', noticeKey: 'worker.kimi_cache_expiry.auto_failed' }]);
    expect(r.notices).toEqual([]);
  });

  it('a press refused while no capture can be taken: the card from the held menu', async () => {
    const r = rig();
    r.world.press = () => { r.world.captureFails = true; return { kind: 'expired' }; };
    r.world.heldScreen = MENU;
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.cards).toEqual([{ reason: 'turn_stalled', pageType: 'kimi cache expiry' }]);
  });

  it('decisions whose captures keep failing end in a card from the held menu (never a key)', async () => {
    const r = rig({ inputHeld: true, turnInFlight: false });
    r.world.captureFails = true;
    r.world.heldScreen = MENU;
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS * (KIMI_CACHE_EXPIRY_DECIDE_RETRIES + 2));
    expect(r.presses).toEqual([]);
    expect(r.cards).toEqual([{ reason: 'input_held', pageType: 'kimi cache expiry' }]);
  });

  it('later kicks decide again once captures recover (the tick keeps an undecided event alive)', async () => {
    const r = rig();
    r.world.captureFails = true;
    r.controller.menuShown();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS * (KIMI_CACHE_EXPIRY_DECIDE_RETRIES + 2));
    expect(r.presses).toEqual([]);
    expect(r.cards).toEqual([]);
    r.world.captureFails = false;
    r.controller.kick();
    await r.advance(KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
    expect(r.presses).toEqual([1]);
  });
});

describe('缓存过期自动压缩 session setting', () => {
  it('is Kimi Code only, on a backend whose screen the worker can verify, in a session botmux owns', () => {
    const base = { cliId: 'kimi', backendType: 'tmux', adopted: false, headless: false, vcMeetingReceiver: false };
    expect(supportsKimiCacheExpiryAutoCompact(base)).toBe(true);
    expect(supportsKimiCacheExpiryAutoCompact({ ...base, backendType: 'pty' })).toBe(true);
    expect(supportsKimiCacheExpiryAutoCompact({ ...base, backendType: undefined })).toBe(true);
    for (const backendType of ['zmx', 'herdr', 'zellij', 'riff', 'mojo', 'remote-runner', 'orca']) {
      expect(supportsKimiCacheExpiryAutoCompact({ ...base, backendType }), backendType).toBe(false);
    }
    for (const cliId of ['claude-code', 'codex', 'traex', 'coco', 'pi', 'oh-my-pi', 'opencode']) {
      expect(supportsKimiCacheExpiryAutoCompact({ ...base, cliId }), cliId).toBe(false);
    }
    expect(supportsKimiCacheExpiryAutoCompact({ ...base, adopted: true })).toBe(false);
    expect(supportsKimiCacheExpiryAutoCompact({ ...base, headless: true })).toBe(false);
    expect(supportsKimiCacheExpiryAutoCompact({ ...base, vcMeetingReceiver: true })).toBe(false);
  });

  it('defaults to off and round-trips through the session row', () => {
    const session: { kimiCacheExpiryAutoCompact?: { enabled: boolean } } = {};
    expect(isKimiCacheExpiryAutoCompactEnabled(session)).toBe(false);
    expect(applyKimiCacheExpiryAutoCompact(session, true)).toBeUndefined();
    const row = JSON.parse(JSON.stringify(session));
    expect(isKimiCacheExpiryAutoCompactEnabled(row)).toBe(true);
    expect(applyKimiCacheExpiryAutoCompact(row, false)).toEqual({ enabled: true });
    expect(isKimiCacheExpiryAutoCompactEnabled(row)).toBe(false);
  });
});
