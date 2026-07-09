type Axis = 'x' | 'y';

type FloatingBar = {
  target: HTMLElement;
  axis: Axis;
  track: HTMLDivElement;
  thumb: HTMLDivElement;
  hideTimer: number | undefined;
};

const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);
const BAR_MIN = 28;
const BAR_INSET = 3;
const BAR_THICKNESS = 6;

let initialized = false;
let rootEl: HTMLElement | null = null;
let layerByHost = new WeakMap<HTMLElement, HTMLDivElement>();
let bars = new Map<HTMLElement, Partial<Record<Axis, FloatingBar>>>();
let resizeObserver: ResizeObserver | null = null;
let mutationObserver: MutationObserver | null = null;
let frame = 0;
let mutationTimer = 0;
let hoveredTarget: HTMLElement | null = null;

function hostFor(target: HTMLElement): HTMLElement {
  return target.closest('dialog[open]') ?? document.body;
}

function layerFor(host: HTMLElement): HTMLDivElement {
  const existing = layerByHost.get(host);
  if (existing?.isConnected) return existing;
  const layer = document.createElement('div');
  layer.className = 'floating-scrollbar-layer';
  layer.setAttribute('aria-hidden', 'true');
  host.appendChild(layer);
  layerByHost.set(host, layer);
  return layer;
}

function overflowAllowsScroll(value: string): boolean {
  return SCROLLABLE_OVERFLOW.has(value);
}

function canScroll(target: HTMLElement, axis: Axis): boolean {
  const style = getComputedStyle(target);
  const overflow = axis === 'y' ? style.overflowY : style.overflowX;
  if (!overflowAllowsScroll(overflow)) return false;
  if (axis === 'y') return target.scrollHeight - target.clientHeight > 1;
  return target.scrollWidth - target.clientWidth > 1;
}

function isVisible(target: HTMLElement): boolean {
  if (!target.isConnected || target.closest('[hidden]')) return false;
  const rect = target.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

function readTargets(root: HTMLElement): HTMLElement[] {
  const nodes = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  return nodes.filter(node => isVisible(node) && (canScroll(node, 'x') || canScroll(node, 'y')));
}

function removeBar(bar: FloatingBar): void {
  if (bar.hideTimer !== undefined) window.clearTimeout(bar.hideTimer);
  bar.track.remove();
}

function getBar(target: HTMLElement, axis: Axis): FloatingBar {
  let entry = bars.get(target);
  if (!entry) {
    entry = {};
    bars.set(target, entry);
  }
  const current = entry[axis];
  const host = hostFor(target);
  const layer = layerFor(host);
  if (current?.track.parentElement === layer) return current;
  if (current) removeBar(current);

  const track = document.createElement('div');
  const thumb = document.createElement('div');
  track.className = `floating-scrollbar floating-scrollbar-${axis}`;
  thumb.className = 'floating-scrollbar-thumb';
  track.appendChild(thumb);
  layer.appendChild(track);

  const bar: FloatingBar = { target, axis, track, thumb, hideTimer: undefined };
  entry[axis] = bar;
  return bar;
}

function showBar(bar: FloatingBar, sticky = false): void {
  bar.track.classList.add('is-visible');
  if (bar.hideTimer !== undefined) window.clearTimeout(bar.hideTimer);
  bar.hideTimer = sticky
    ? undefined
    : window.setTimeout(() => {
      bar.track.classList.remove('is-visible', 'is-active');
      bar.hideTimer = undefined;
    }, 900);
}

function updateBar(bar: FloatingBar): void {
  const { target, axis, track, thumb } = bar;
  const rect = target.getBoundingClientRect();
  if (axis === 'y') {
    const top = Math.max(0, rect.top + BAR_INSET);
    const bottom = Math.min(window.innerHeight, rect.bottom - BAR_INSET);
    const trackLength = Math.max(0, bottom - top);
    if (trackLength < BAR_MIN || target.scrollHeight <= target.clientHeight) {
      track.hidden = true;
      return;
    }
    const thumbLength = Math.max(BAR_MIN, Math.round(trackLength * target.clientHeight / target.scrollHeight));
    const maxOffset = Math.max(1, target.scrollHeight - target.clientHeight);
    const thumbOffset = Math.round((trackLength - thumbLength) * target.scrollTop / maxOffset);
    track.hidden = false;
    track.style.left = `${Math.min(window.innerWidth - BAR_THICKNESS - BAR_INSET, Math.max(BAR_INSET, rect.right - BAR_THICKNESS - BAR_INSET))}px`;
    track.style.top = `${top}px`;
    track.style.width = `${BAR_THICKNESS}px`;
    track.style.height = `${trackLength}px`;
    thumb.style.width = '100%';
    thumb.style.height = `${thumbLength}px`;
    thumb.style.transform = `translate3d(0, ${thumbOffset}px, 0)`;
    return;
  }

  const left = Math.max(0, rect.left + BAR_INSET);
  const right = Math.min(window.innerWidth, rect.right - BAR_INSET);
  const trackLength = Math.max(0, right - left);
  if (trackLength < BAR_MIN || target.scrollWidth <= target.clientWidth) {
    track.hidden = true;
    return;
  }
  const thumbLength = Math.max(BAR_MIN, Math.round(trackLength * target.clientWidth / target.scrollWidth));
  const maxOffset = Math.max(1, target.scrollWidth - target.clientWidth);
  const thumbOffset = Math.round((trackLength - thumbLength) * target.scrollLeft / maxOffset);
  track.hidden = false;
  track.style.left = `${left}px`;
  track.style.top = `${Math.min(window.innerHeight - BAR_THICKNESS - BAR_INSET, Math.max(BAR_INSET, rect.bottom - BAR_THICKNESS - BAR_INSET))}px`;
  track.style.width = `${trackLength}px`;
  track.style.height = `${BAR_THICKNESS}px`;
  thumb.style.width = `${thumbLength}px`;
  thumb.style.height = '100%';
  thumb.style.transform = `translate3d(${thumbOffset}px, 0, 0)`;
}

function scheduleUpdate(): void {
  if (frame) return;
  frame = window.requestAnimationFrame(() => {
    frame = 0;
    updateFloatingScrollbars();
  });
}

// Structural churn (the React shell re-renders on every SSE tick) is coalesced on a short
// timer so the full-tree rescan in readTargets() runs at most ~once per 120ms instead of on
// every animation frame during activity. Scroll/resize stay on the immediate rAF path.
function scheduleRescan(): void {
  if (mutationTimer) return;
  mutationTimer = window.setTimeout(() => {
    mutationTimer = 0;
    scheduleUpdate();
  }, 120);
}

function updateFloatingScrollbars(): void {
  const root = rootEl;
  if (!root) return;
  const targets = new Set(readTargets(root));

  for (const [target, entry] of bars) {
    if (targets.has(target)) continue;
    if (entry.x) removeBar(entry.x);
    if (entry.y) removeBar(entry.y);
    bars.delete(target);
  }

  for (const target of targets) {
    const active = target === hoveredTarget;
    for (const axis of ['x', 'y'] as const) {
      const entry = bars.get(target);
      if (!canScroll(target, axis)) {
        const bar = entry?.[axis];
        if (bar) {
          removeBar(bar);
          delete entry?.[axis];
        }
        continue;
      }
      const bar = getBar(target, axis);
      updateBar(bar);
      if (active) showBar(bar, true);
    }
  }
}

function markScrollTarget(target: EventTarget | null): void {
  if (!(target instanceof HTMLElement)) return;
  const entry = bars.get(target);
  if (!entry) return;
  for (const bar of Object.values(entry)) {
    if (!bar) continue;
    bar.track.classList.add('is-active');
    showBar(bar);
  }
}

function scrollableAncestor(node: Element | null): HTMLElement | null {
  for (let current: Element | null = node; current; current = current.parentElement) {
    if (!(current instanceof HTMLElement)) continue;
    if (bars.has(current)) return current;
  }
  return null;
}

function setHoveredTarget(next: HTMLElement | null): void {
  if (hoveredTarget === next) return;
  const previous = hoveredTarget ? bars.get(hoveredTarget) : undefined;
  hoveredTarget = next;
  if (previous) {
    for (const bar of Object.values(previous)) {
      bar?.track.classList.remove('is-visible');
    }
  }
  const current = next ? bars.get(next) : undefined;
  if (current) {
    for (const bar of Object.values(current)) {
      if (bar) showBar(bar, true);
    }
  }
}

export function initFloatingScrollbars(root: HTMLElement): void {
  if (initialized) return;
  initialized = true;
  rootEl = root;
  document.documentElement.classList.add('floating-scrollbars-on');

  resizeObserver = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(scheduleUpdate);
  resizeObserver?.observe(root);

  mutationObserver = new MutationObserver(records => {
    // Skip mutations we cause ourselves (writing to the scrollbar layer/tracks); otherwise
    // updateBar's style/class writes on a layer mounted inside an open <dialog> (which lives
    // in the observed subtree) would re-trigger the observer → a self-sustaining rAF loop.
    for (const record of records) {
      const node = record.target;
      if (node instanceof Element && node.closest('.floating-scrollbar-layer')) continue;
      scheduleRescan();
      return;
    }
  });
  mutationObserver.observe(root, {
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open'],
    childList: true,
    subtree: true,
  });

  document.addEventListener('scroll', event => {
    markScrollTarget(event.target);
    scheduleUpdate();
  }, true);
  window.addEventListener('resize', scheduleUpdate);
  window.addEventListener('hashchange', scheduleUpdate);
  document.addEventListener('pointermove', event => {
    setHoveredTarget(scrollableAncestor(document.elementFromPoint(event.clientX, event.clientY)));
  });
  document.addEventListener('pointerleave', () => setHoveredTarget(null));

  scheduleUpdate();
}
