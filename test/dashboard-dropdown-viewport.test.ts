import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { dropdownPlacement } from '../src/dashboard/web/dashboard-components.js';

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
