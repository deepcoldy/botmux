/**
 * Native modal dialogs live in the browser's top layer. A floating element
 * portaled to document.body therefore stays behind an open dialog regardless
 * of its z-index. Keep floating UI in the nearest open dialog when there is
 * one, while retaining document.body as the normal page-level host.
 */
export function floatingPortalHost(anchor: Element | null, fallback: HTMLElement): Element {
  return anchor?.closest('dialog[open]') ?? fallback;
}

/** {@link floatingPortalHost} with the page body as fallback, typed for a Base UI Portal `container`. */
export function floatingPortalContainer(anchor: Element | null): HTMLElement {
  return floatingPortalHost(anchor, document.body) as HTMLElement;
}
