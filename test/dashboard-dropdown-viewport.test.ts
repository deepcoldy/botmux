import { readFileSync } from 'node:fs';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DropdownMenu, dropdownPlacement, popupClipFrame } from '../src/dashboard/web/dashboard-components.js';

function style(): string {
  return readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
}

/**
 * Regression cover for「时区下拉菜单无法滚动」: a long dropdown (e.g. the 14
 * timezone options) used to render at its full natural height with no cap and
 * no internal scrolling. Because every ancestor of a dropdown is
 * `overflow: hidden` (main / .chrome-body / .app-shell), the overhang was
 * clipped: the tail options could not be seen, and hovering there did not
 * scroll the popup either — the cursor was over .chrome-body, not the popup.
 */
describe('dropdown popup stays inside the viewport', () => {
  it('caps the popup to the room below the trigger instead of overflowing', () => {
    // Trigger low in a 900px viewport: 456px of options, ~95px of room below.
    const placement = dropdownPlacement({
      triggerTop: 760,
      triggerBottom: 800,
      naturalHeight: 456,
      viewportHeight: 900,
    });
    // Must flip up: below cannot fit and above is far roomier.
    expect(placement.dropUp).toBe(true);
    // And the height budget must stay within the room above (760 - 8 - 12).
    expect(placement.maxHeight).toBe(740);
  });

  it('keeps a short list below the trigger, uncapped in practice', () => {
    const placement = dropdownPlacement({
      triggerTop: 200,
      triggerBottom: 240,
      naturalHeight: 120,
      viewportHeight: 900,
    });
    expect(placement.dropUp).toBe(false);
    // Room below (900 - 240 - 8 - 12 = 640) comfortably exceeds the content,
    // so nothing is clipped and no scrollbar appears.
    expect(placement.maxHeight).toBe(640);
    expect(placement.maxHeight).toBeGreaterThan(120);
  });

  it('does not flip up when below is tight but above is even tighter', () => {
    // Short viewport, trigger near the top: flipping would make it worse.
    const placement = dropdownPlacement({
      triggerTop: 60,
      triggerBottom: 100,
      naturalHeight: 400,
      viewportHeight: 320,
    });
    expect(placement.dropUp).toBe(false);
  });

  it('never collapses the popup to an unusable sliver', () => {
    // Almost no room either side — the floor keeps it scrollable rather than
    // shrinking to a few pixels.
    const placement = dropdownPlacement({
      triggerTop: 150,
      triggerBottom: 170,
      naturalHeight: 500,
      viewportHeight: 190,
    });
    expect(placement.maxHeight).toBeGreaterThanOrEqual(140);
  });

  // 源码结构护栏(K4)：DropdownMenu 只负责量出预算写进 `--dropdown-popover-space`、
  // 切 `is-drop-up` 类，真正的限高与上翻全靠 style.css 消费这两个名字；CSS 无法 import，
  // 只能读文本对齐。守「时区下拉菜单无法滚动」：任何带 max-height 的 per-page 覆盖
  // 不夹到测得的预算，那个下拉就会在矮视口里重新溢出（行为侧见下方 DropdownMenu 用例）。
  it('style.css consumes the budget property and drop-up class the component writes', () => {
    const css = style();
    // Anchor on the BASE rule (at line start, no ancestor selector) — a plain
    // indexOf('.sect-sort-pop {') matches an earlier per-page override instead.
    const base = /^\.sect-sort-pop \{([^}]*)\}/m.exec(css);
    expect(base, 'base .sect-sort-pop rule not found').not.toBeNull();
    expect(base![1]).toContain('--dropdown-popover-space');

    const overrides = [...css.matchAll(/^[^\n@]*\.sect-sort-pop[^{]*\{[^}]*?max-height:[^;]+;/gms)];
    expect(overrides.length).toBeGreaterThan(1);
    for (const match of overrides) {
      const maxHeight = /max-height:([^;]+);/.exec(match[0])?.[1] ?? '';
      // The sticky search input is a child rule with its own fixed height.
      if (match[0].includes('sect-sort-search')) continue;
      expect(maxHeight, `override must clamp to --dropdown-popover-space: ${match[0].slice(0, 120)}`)
        .toContain('--dropdown-popover-space');
    }

    expect(css).toMatch(/\.sect-sort-menu\.is-drop-up\s*>\s*\.sect-sort-pop\s*\{/);
  });

  it('sizes for the direction that actually rendered, not the one it asked for', () => {
    // `.connector-create-modal #cn-verify .sect-sort-pop` pins `bottom` with ID
    // specificity, so that popup opens upward even when the class says other-
    // wise. Budgeting for "below" would then clip it off the TOP of the screen.
    const geometry = {
      triggerTop: 120,
      triggerBottom: 160,
      naturalHeight: 600,
      viewportHeight: 720,
    };
    const asked = dropdownPlacement(geometry);
    expect(asked.dropUp).toBe(false);
    expect(asked.maxHeight).toBe(540); // room BELOW — wrong side for this popup

    const rendered = dropdownPlacement({ ...geometry, forceDropUp: true });
    expect(rendered.dropUp).toBe(true);
    // Room ABOVE is only 120 - 8 - 12 = 100, so the floor applies; either way
    // it must be far smaller than the below-budget that would overflow upward.
    expect(rendered.maxHeight).toBeLessThan(asked.maxHeight);
    expect(rendered.maxHeight).toBeLessThanOrEqual(140);
  });
});

/**
 * Regression cover for「角色管理 Profiles 页看不到别的群」: the 应用到群组 dropdown
 * sits inside `.roles-profile-apply`, a `max-height: 34%; overflow: auto` panel.
 * Budgeting against `window.innerHeight` measured ~635px of room above a trigger
 * whose panel only showed ~290px, so the popup flipped up and out of the panel:
 * in a 1400x900 Chromium repro only 1 of 24 groups was hit-testable, and
 * scrolling the popup reached just 17 — an overflow container scrolls towards
 * its content, never above it, so the rest could not be brought back.
 */
describe('dropdown popup respects clipping ancestors, not just the viewport', () => {
  it('intersects every clipping ancestor into the visible band', () => {
    const frame = popupClipFrame({
      viewportHeight: 900,
      clippers: [
        { top: 615, bottom: 907 }, // .roles-profile-apply — the short panel
        { top: 28, bottom: 928 },  // .roles-page
        { top: 0, bottom: 900 },   // .app-shell
      ],
    });
    // Tightest top and tightest bottom win, so the band is the panel clamped
    // to the viewport — not the panel's own 907 bottom, nor the full 0-900.
    expect(frame).toEqual({ top: 615, bottom: 900 });
  });

  it('falls back to the whole viewport when nothing clips', () => {
    expect(popupClipFrame({ viewportHeight: 720, clippers: [] })).toEqual({ top: 0, bottom: 720 });
  });

  it('collapses rather than inverting when an ancestor is scrolled off screen', () => {
    // bottom above top would otherwise hand negative room to the placement maths.
    const frame = popupClipFrame({ viewportHeight: 900, clippers: [{ top: 700, bottom: 200 }] });
    expect(frame.bottom).toBeGreaterThanOrEqual(frame.top);
  });

  it('stops flipping up into a panel that cannot show the popup', () => {
    // The reported geometry: trigger inside .roles-profile-apply (615..907),
    // 24 groups wanting 920px. Viewport-only maths saw 635px "above" and flipped.
    const geometry = { triggerTop: 671, triggerBottom: 707, naturalHeight: 920, viewportHeight: 900 };
    const viewportOnly = dropdownPlacement(geometry);
    expect(viewportOnly.dropUp).toBe(true);
    expect(viewportOnly.maxHeight).toBe(651);

    const clipped = dropdownPlacement({ ...geometry, frameTop: 615, frameBottom: 900 });
    // Only ~36px usable above the trigger inside the panel, ~173px below, so
    // staying below is the reachable side.
    expect(clipped.dropUp).toBe(false);
    // And the budget must fit the panel, not the viewport.
    expect(clipped.maxHeight).toBeLessThan(viewportOnly.maxHeight);
    expect(clipped.maxHeight).toBeLessThanOrEqual(900 - 707);
  });

  it('measures room above from the frame top, not the screen top', () => {
    // Trigger low in the viewport but near the top of its scroll panel: the
    // space above belongs to the panel's ancestors, not to this popup.
    const geometry = { triggerTop: 600, triggerBottom: 640, naturalHeight: 800, viewportHeight: 900 };
    const unclipped = dropdownPlacement(geometry);
    const clipped = dropdownPlacement({ ...geometry, frameTop: 560, frameBottom: 900 });
    expect(unclipped.dropUp).toBe(true);       // 580 above vs 240 below
    expect(clipped.dropUp).toBe(false);        // only 20 above once the panel is honoured
    expect(clipped.maxHeight).toBe(240);
  });

  it('keeps the sliver floor when a panel is smaller than the floor', () => {
    const placement = dropdownPlacement({
      triggerTop: 300, triggerBottom: 340, naturalHeight: 600,
      viewportHeight: 900, frameTop: 290, frameBottom: 400,
    });
    // 400-340-20 = 40px of real room; the floor keeps it scrollable instead of
    // rendering a few unusable pixels.
    expect(placement.maxHeight).toBe(140);
  });
});

/**
 * DropdownMenu end to end, with react-test-renderer node mocks standing in for
 * the DOM: the boxes and computed styles below are what place() measures.
 */
describe('DropdownMenu measures the rendered popup and its clipping ancestry', () => {
  type Box = { top: number; bottom: number };
  type Crop = { box: Box; overflow?: string; position?: string };

  afterEach(() => vi.unstubAllGlobals());

  function openDropdown(input: {
    trigger: Box;
    popRect: Box;
    naturalHeight: number;
    viewportHeight: number;
    /** Overflow of the <details> itself (the popup's parent). */
    menuOverflow?: string;
    /** Ancestors above the <details>, nearest first. */
    ancestors?: Crop[];
  }): { space: string | undefined; dropUp: boolean | undefined } {
    const styles = new Map<object, { overflowX: string; overflowY: string; position: string }>();
    const docEl = { parentElement: null };
    let parent: object = docEl;
    for (const crop of [...(input.ancestors ?? [])].reverse()) {
      const node = { parentElement: parent, getBoundingClientRect: () => crop.box };
      const overflow = crop.overflow ?? 'visible';
      styles.set(node, { overflowX: overflow, overflowY: overflow, position: crop.position ?? 'static' });
      parent = node;
    }
    const toggle = vi.fn();
    const details = { parentElement: parent, open: false, classList: { toggle }, getBoundingClientRect: () => input.trigger };
    const menuOverflow = input.menuOverflow ?? 'visible';
    styles.set(details, { overflowX: menuOverflow, overflowY: menuOverflow, position: 'relative' });
    const setProperty = vi.fn();
    const pop = {
      parentElement: details,
      scrollHeight: input.naturalHeight,
      style: { setProperty },
      getBoundingClientRect: () => ({ ...input.popRect, height: input.popRect.bottom - input.popRect.top }),
    };
    const noop = () => undefined;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('document', { documentElement: docEl, addEventListener: noop, removeEventListener: noop });
    vi.stubGlobal('window', {
      innerHeight: input.viewportHeight,
      getComputedStyle: (node: object) => styles.get(node),
      requestAnimationFrame: (cb: () => void) => { cb(); return 1; },
      cancelAnimationFrame: noop,
      addEventListener: noop,
      removeEventListener: noop,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(DropdownMenu<string>, { label: 'tz', value: 'a', options: [{ value: 'a', label: 'A' }], onChange: noop }),
        { createNodeMock: el => (el.type === 'details' ? details : el.props.className === 'sect-sort-pop' ? pop : {}) },
      );
    });
    act(() => renderer.root.findByType('details').props.onToggle({ currentTarget: { open: true } }));
    act(() => renderer.unmount());
    const space = setProperty.mock.calls.findLast(([name]) => name === '--dropdown-popover-space')?.[1];
    return { space, dropUp: toggle.mock.calls.findLast(([name]) => name === 'is-drop-up')?.[1] };
  }

  it('budgets for the side the popup actually rendered on, judged from its box', () => {
    // A per-page rule pins this popup upward even though placement asked for below.
    const geometry = { trigger: { top: 120, bottom: 160 }, naturalHeight: 600, viewportHeight: 720 };
    const renderedAbove = openDropdown({ ...geometry, popRect: { top: 0, bottom: 112 } });
    expect(renderedAbove.dropUp).toBe(false);
    expect(renderedAbove.space).toBe(`${dropdownPlacement({
      triggerTop: 120, triggerBottom: 160, naturalHeight: 600, viewportHeight: 720, forceDropUp: true,
    }).maxHeight}px`);

    const renderedBelow = openDropdown({ ...geometry, popRect: { top: 168, bottom: 708 } });
    expect(renderedBelow.space).toBe('540px');
  });

  it('clamps to the clipping ancestors up to and including a fixed one, ignoring boxes above it', () => {
    const base = { trigger: { top: 260, bottom: 300 }, popRect: { top: 308, bottom: 900 }, naturalHeight: 1000, viewportHeight: 900 };
    const ancestors: Crop[] = [
      { box: { top: 200, bottom: 800 }, overflow: 'auto' },
      // A showModal() <dialog>: fixed, and it crops its own content.
      { box: { top: 100, bottom: 700 }, overflow: 'hidden', position: 'fixed' },
      // Above the fixed box: it does not crop the popup at all.
      { box: { top: 0, bottom: 400 }, overflow: 'hidden' },
    ];
    // Frame 200..700: room below 700 - 300 - 20 = 380 (viewport-only would give 580).
    expect(openDropdown({ ...base, ancestors })).toEqual({ space: '380px', dropUp: false });
    // The walk starts at the popup, so a menu that itself crops is honoured too.
    expect(openDropdown({ ...base, ancestors, menuOverflow: 'hidden' }).space).toBe('140px');
  });
});
