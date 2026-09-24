import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { dropdownPlacement, popupClipFrame } from '../src/dashboard/web/dashboard-components.js';

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

  it('scrolls inside the popup rather than growing past the viewport', () => {
    const css = style();
    // Anchor on the BASE rule (at line start, no ancestor selector) — a plain
    // indexOf('.sect-sort-pop {') matches an earlier per-page override instead,
    // which would silently assert against the wrong block.
    const base = /^\.sect-sort-pop \{([^}]*)\}/m.exec(css);
    expect(base, 'base .sect-sort-pop rule not found').not.toBeNull();
    const block = base![1];
    // Prove the window really is the base rule before trusting the assertions.
    expect(block).toMatch(/position:\s*absolute/);
    expect(block).toMatch(/overflow-y:\s*auto/);
    expect(block).toMatch(/--dropdown-popover-space/);
    // Wheeling to the end of the options must not scroll the page behind it.
    expect(block).toMatch(/overscroll-behavior:\s*contain/);
  });

  it('honours the measured budget in every per-page popup override', () => {
    const css = style();
    // Any override that sets its own max-height must still clamp to the space
    // actually available, otherwise that dropdown re-breaks in a short viewport.
    const overrides = [...css.matchAll(/^[^\n@]*\.sect-sort-pop[^{]*\{[^}]*?max-height:[^;]+;/gms)];
    expect(overrides.length).toBeGreaterThan(1);
    for (const match of overrides) {
      const maxHeight = /max-height:([^;]+);/.exec(match[0])?.[1] ?? '';
      // The sticky search input is a child rule with its own fixed height.
      if (match[0].includes('sect-sort-search')) continue;
      expect(maxHeight, `override must clamp to --dropdown-popover-space: ${match[0].slice(0, 120)}`)
        .toContain('--dropdown-popover-space');
    }
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

  it('detects the applied direction from geometry, not computed style', () => {
    const source = readFileSync(new URL('../src/dashboard/web/dashboard-components.tsx', import.meta.url), 'utf8');
    // getComputedStyle().top resolves `auto` to a used pixel value on a
    // positioned box, so a style probe reports "not flipped" for every popup.
    expect(source).not.toMatch(/getComputedStyle\(pop\)\.top === 'auto'/);
    expect(source).toMatch(/popBox\.bottom <= trigger\.top \+ 1/);
    expect(source).toMatch(/forceDropUp: renderedUp/);
  });

  it('has a drop-up rule for the flipped state', () => {
    expect(style()).toMatch(/\.sect-sort-menu\.is-drop-up\s*>\s*\.sect-sort-pop\s*\{[^}]*bottom:\s*calc\(100% \+ 8px\)/);
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

  it('walks the popup ancestry from the popup and stops at a fixed ancestor', () => {
    const source = readFileSync(new URL('../src/dashboard/web/dashboard-components.tsx', import.meta.url), 'utf8');
    // Starting the walk at the <details> would skip the menu itself, which a
    // per-page overflow rule could turn into a clipper.
    expect(source).toMatch(/clippingAncestorBoxes\(pop\)/);
    // A `position: fixed` panel is laid out against the viewport, so overflow
    // boxes above it do not crop it; treating them as clippers would shrink
    // every modal dropdown to a container it visibly escapes.
    expect(source).toMatch(/style\.position === 'fixed'/);
    // The measured band must actually reach the placement maths.
    expect(source).toMatch(/frameTop: frame\.top/);
    expect(source).toMatch(/frameBottom: frame\.bottom/);
  });

  it('records a fixed ancestor own box before stopping at it', () => {
    // `showModal()` makes a <dialog> `position: fixed` via the UA stylesheet, and
    // the dashboard's modals add their own overflow, so the stopping node is
    // itself a clipper. Breaking before the push would drop it: today the
    // viewport clamp hides that (a fixed box cannot leave the viewport), but a
    // modal that dropped its inner scroll container would silently regress.
    const source = readFileSync(new URL('../src/dashboard/web/dashboard-components.tsx', import.meta.url), 'utf8');
    const walk = source.slice(
      source.indexOf('function clippingAncestorBoxes'),
      source.indexOf('export function DropdownMenu'));
    expect(walk).not.toBe('');
    const pushAt = walk.indexOf('boxes.push(');
    const breakAt = walk.indexOf("if (style.position === 'fixed') break;");
    expect(pushAt).toBeGreaterThan(-1);
    expect(breakAt).toBeGreaterThan(-1);
    // Order is the whole point: record, then stop.
    expect(pushAt).toBeLessThan(breakAt);
    // And the push must not be nested under the fixed check (which would make
    // the ordering vacuous) — it is gated on cropping only.
    expect(walk).toMatch(/const crops = !\(style\.overflowY === 'visible' && style\.overflowX === 'visible'\);/);
    expect(walk).toMatch(/if \(crops\) \{/);
  });
});
