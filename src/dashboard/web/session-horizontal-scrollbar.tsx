import { useEffect, useRef, type RefObject } from 'react';

/** Table-only sibling in a reserved bottom hit strip, outside scrollable content.
 * Shared stacking with the table preserves native popup/modal hit testing. */
export function SessionHorizontalScrollbar({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  // The scroller belongs to our parent; passive effect runs after its ref attaches.
  useEffect(() => {
    const target = scrollRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!target || !track || !thumb) return;
    const host = target.parentElement!;
    let timer: number | undefined;
    let frame = 0;
    let hovered = host.matches(':hover');
    let drag: { id: number; grab: number } | null = null;
    const usable = () => target.isConnected && !target.closest('[inert], [hidden]')
      && !track.hidden && !document.querySelector('dialog:modal');
    const show = () => {
      track.classList.add('is-visible');
      if (timer !== undefined) window.clearTimeout(timer);
      timer = hovered || drag ? undefined : window.setTimeout(() => {
        track.classList.remove('is-visible', 'is-active'); timer = undefined;
      }, 900);
    };
    const update = () => {
      const length = Math.max(0, target.clientWidth - 6);
      const range = target.scrollWidth - target.clientWidth;
      const overflow = getComputedStyle(target).overflowX;
      track.hidden = !['auto', 'scroll', 'overlay'].includes(overflow) || range <= 1 || length < 28;
      if (track.hidden) return;
      const size = Math.min(length, Math.max(28, Math.round(length * target.clientWidth / target.scrollWidth)));
      // A sibling is excluded from target.scrollWidth/Height. No scroll-offset
      // compensation: content shrink is clamped by the browser in one step.
      track.style.left = `${target.offsetLeft + target.clientLeft + 3}px`;
      track.style.width = `${length}px`;
      thumb.style.width = `${size}px`;
      thumb.style.transform = `translateX(${(length - size) * target.scrollLeft / range}px)`;
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; update(); });
    };
    const stop = () => {
      const current = drag; drag = null;
      track.classList.remove('is-dragging');
      if (current && track.hasPointerCapture(current.id)) track.releasePointerCapture(current.id);
      if (current) show();
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!usable() || !(event.buttons & 1) || !track.hasPointerCapture(event.pointerId)) { stop(); return; }
      update();
      if (track.hidden) { stop(); return; }
      const rect = track.getBoundingClientRect();
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      if (event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom && !track.contains(hit)) { stop(); return; }
      // CSS transforms/zoom scale client pointer coordinates, not scroll units.
      const scale = rect.width / track.offsetWidth;
      const travel = track.offsetWidth - thumb.offsetWidth;
      if (scale <= 0 || travel <= 0) return;
      const fraction = ((event.clientX - rect.left) / scale - drag.grab) / travel;
      target.scrollTo({ left: Math.max(0, Math.min(1, fraction)) * (target.scrollWidth - target.clientWidth), behavior: 'instant' });
      update();
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary || !usable() || drag) return;
      update();
      if (track.hidden) return;
      const rect = track.getBoundingClientRect();
      const scale = rect.width / track.offsetWidth;
      const box = thumb.getBoundingClientRect();
      const grab = thumb.contains(event.target as Node) ? (event.clientX - box.left) / scale : thumb.offsetWidth / 2;
      event.preventDefault(); event.stopPropagation();
      track.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, grab };
      track.classList.add('is-dragging', 'is-active'); show();
      if (!thumb.contains(event.target as Node)) move(event);
    };
    const up = (event: PointerEvent) => { if (event.pointerId === drag?.id) stop(); };
    const lost = (event: PointerEvent) => { if (event.pointerId === drag?.id) stop(); };
    const scroll = () => { update(); track.classList.add('is-active'); show(); };
    const enter = () => { hovered = true; update(); show(); };
    const leave = () => { hovered = false; show(); };
    const observer = new ResizeObserver(schedule);
    observer.observe(target);
    if (target.firstElementChild) observer.observe(target.firstElementChild);
    target.addEventListener('scroll', scroll);
    host.addEventListener('pointerenter', enter);
    host.addEventListener('pointerleave', leave);
    // Wheel over the scrolling content is left to the browser (the scroller is
    // in the event's scroll chain), so do not intercept it there. On the bar and
    // the reserved bottom gutter — siblings of the scroller, including when the
    // bar is hidden because the columns fit — the scroller is out of the chain:
    // listen on the host and forward those deltas locally.
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      if (target.contains(event.target as Node)) return;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      let left = event.deltaX * (event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? target.clientWidth : unit);
      let top = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? target.clientHeight : unit);
      if (event.shiftKey && !left) { left = top; top = 0; }
      target.scrollBy({ left, top, behavior: 'instant' });
      event.preventDefault();
    };
    host.addEventListener('wheel', wheel, { passive: false });
    track.addEventListener('pointerdown', down);
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
    track.addEventListener('lostpointercapture', lost);
    window.addEventListener('blur', stop);
    window.addEventListener('resize', schedule);
    update();
    if (hovered) show();
    return () => {
      stop(); observer.disconnect();
      if (timer !== undefined) window.clearTimeout(timer);
      if (frame) window.cancelAnimationFrame(frame);
      target.removeEventListener('scroll', scroll);
      host.removeEventListener('pointerenter', enter);
      host.removeEventListener('pointerleave', leave);
      host.removeEventListener('wheel', wheel);
      track.removeEventListener('pointerdown', down);
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', up);
      track.removeEventListener('pointercancel', up);
      track.removeEventListener('lostpointercapture', lost);
      window.removeEventListener('blur', stop);
      window.removeEventListener('resize', schedule);
    };
  }, [scrollRef]);

  return <div ref={trackRef} className="session-horizontal-scrollbar" aria-hidden="true" hidden>
    <div ref={thumbRef} className="floating-scrollbar-thumb" />
  </div>;
}
