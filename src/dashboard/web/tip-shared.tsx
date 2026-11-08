import type React from 'react';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** Hover delay before InfoTip, OverflowText and IconTip popups open: long enough to ignore a pointer passing over. */
export const TIP_OPEN_DELAY_MS = 120;

export type InfoTipProps = {
  children: ReactNode;
  label?: string;
  className?: string;
  trigger?: ReactNode;
  preventClick?: boolean;
  focusable?: boolean;
};

export function infoTipClassName(props: InfoTipProps): string {
  return ['ui-info-tip', props.className].filter(Boolean).join(' ');
}

/** A node's text when it is plain text, for naming a control after it. */
export function plainText(node: ReactNode): string | undefined {
  return typeof node === 'string' || typeof node === 'number' ? String(node) : undefined;
}

/** The mark is a button to screen readers; without a `label` it takes its name from plain-text help. */
export function infoTipLabel(props: InfoTipProps): string | undefined {
  return props.label ?? plainText(props.children);
}

export function infoTipTrigger(props: InfoTipProps): ReactNode {
  return props.trigger ?? <span className="ui-info-mark" aria-hidden="true">?</span>;
}

export type OverflowTextProps = {
  text: string;
  children?: ReactNode;
  className?: string;
  textClassName?: string;
  popoverClassName?: string;
  showPopover?: boolean;
  durationMs?: number;
};

/**
 * Whether the text is wider than its box. Re-measured when the box resizes and
 * on `measure()`: a late web font widens the text without resizing the box.
 */
export function useOverflowText(text: string) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  const measure = useCallback((): boolean => {
    const anchor = ref.current;
    if (!anchor) return false;
    const scroll = anchor.querySelector<HTMLElement>('.ui-overflow-scroll') ?? anchor;
    const next = scroll.scrollWidth > anchor.clientWidth + 1;
    setOverflowing(next);
    return next;
  }, []);

  useEffect(() => {
    const anchor = ref.current;
    if (!anchor || typeof window === 'undefined') return undefined;
    const raf = window.requestAnimationFrame(measure);
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => measure())
      : null;
    resizeObserver?.observe(anchor);
    window.addEventListener('resize', measure);
    return () => {
      window.cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, text]);

  return { ref, overflowing, measure };
}

export function overflowTextRootProps(props: OverflowTextProps, overflowing: boolean): {
  className: string;
  style?: CSSProperties;
} {
  return {
    className: ['ui-overflow-text', overflowing ? 'is-overflowing' : '', props.className].filter(Boolean).join(' '),
    style: props.durationMs ? { '--ui-overflow-duration': `${props.durationMs}ms` } as CSSProperties : undefined,
  };
}

export function OverflowTextScroll(props: OverflowTextProps): React.JSX.Element {
  return (
    <span className={['ui-overflow-scroll', props.textClassName].filter(Boolean).join(' ')}>
      {props.children ?? props.text}
    </span>
  );
}
