import { describe, expect, it, vi } from 'vitest';

import { floatingPortalHost } from '../src/dashboard/web/dashboard-components.js';

describe('dashboard floating tooltip layering', () => {
  it('portals into the nearest open native dialog', () => {
    const dialog = {} as HTMLDialogElement;
    const fallback = {} as HTMLElement;
    const closest = vi.fn().mockReturnValue(dialog);
    const anchor = { closest } as unknown as Element;

    expect(floatingPortalHost(anchor, fallback)).toBe(dialog);
    expect(closest).toHaveBeenCalledWith('dialog[open]');
  });

  it('uses the page host when the trigger is outside a modal dialog', () => {
    const fallback = {} as HTMLElement;
    const anchor = { closest: vi.fn().mockReturnValue(null) } as unknown as Element;

    expect(floatingPortalHost(anchor, fallback)).toBe(fallback);
    expect(floatingPortalHost(null, fallback)).toBe(fallback);
  });
});
