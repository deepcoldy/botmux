import type React from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export type DropdownOption<T extends string> = {
  value: T;
  label: ReactNode;
  /** Non-selectable informational entry (e.g. a mode the current CLI can't use). */
  disabled?: boolean;
};

export function dropdownLabel<T extends string>(options: DropdownOption<T>[], value: T): ReactNode {
  return options.find(option => option.value === value)?.label ?? value;
}

export function Html(props: { html: string; as?: 'span' | 'div' }): React.JSX.Element {
  const Tag = props.as ?? 'span';
  return <Tag style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: props.html }} />;
}

export function LoadingState(props: {
  label: ReactNode;
  className?: string;
  compact?: boolean;
}): React.JSX.Element {
  const className = [
    'page-loading',
    props.compact ? 'page-loading-compact' : '',
    props.className,
  ].filter(Boolean).join(' ');

  return (
    <div className={className} role="status" aria-live="polite">
      <i className="page-loading-spin" aria-hidden="true" />
      <span>{props.label}</span>
    </div>
  );
}

export function SectionHeader(props: {
  title: ReactNode;
  count?: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="sect-head overview-panel-head">
      <h2>{props.title}</h2>
      {props.count ? <span className="sect-head-count">{props.count}</span> : null}
      {props.hint ? <span className="sect-head-hint">{props.hint}</span> : null}
      {props.children}
    </div>
  );
}

export function HeaderAction(props: {
  href: string;
  children: ReactNode;
}): React.JSX.Element {
  return <a className="sect-head-action" href={props.href}>{props.children}</a>;
}

export function HeaderControls(props: { children: ReactNode }): React.JSX.Element {
  return <div className="sect-head-controls">{props.children}</div>;
}

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
};

function ActionGlyph(props: { kind: 'plus' | 'refresh' }): React.JSX.Element {
  if (props.kind === 'plus') {
    return (
      <svg className="ui-action-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 3.25v9.5M3.25 8h9.5" />
      </svg>
    );
  }
  return (
    <svg className="ui-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.1 6.55A5.35 5.35 0 1 0 13 10.1" />
      <path d="M13.15 2.95v3.7H9.45" />
    </svg>
  );
}

export function CreateActionButton(props: ActionButtonProps): React.JSX.Element {
  const { children, className, type = 'button', ...buttonProps } = props;
  return (
    <button {...buttonProps} type={type} className={['ui-create-action', className].filter(Boolean).join(' ')}>
      <ActionGlyph kind="plus" />
      <span className="ui-create-action-label">{children}</span>
    </button>
  );
}

export function RefreshIconButton(props: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  label: string;
  busy?: boolean;
}): React.JSX.Element {
  const { label, busy = false, className, type = 'button', ...buttonProps } = props;
  return (
    <button
      {...buttonProps}
      type={type}
      className={['ui-refresh-button', busy ? 'is-loading' : '', className].filter(Boolean).join(' ')}
      title={label}
      aria-label={label}
      aria-busy={busy || undefined}
    >
      <ActionGlyph kind="refresh" />
    </button>
  );
}

/**
 * Native modal dialogs live in the browser's top layer. A floating element
 * portaled to document.body therefore stays behind an open dialog regardless
 * of its z-index. Keep floating UI in the nearest open dialog when there is
 * one, while retaining document.body as the normal page-level host.
 */
export function floatingPortalHost(anchor: Element | null, fallback: HTMLElement): Element {
  return anchor?.closest('dialog[open]') ?? fallback;
}

export function InfoTip(props: {
  children: ReactNode;
  label?: string;
  className?: string;
  trigger?: ReactNode;
  preventClick?: boolean;
  focusable?: boolean;
}): React.JSX.Element {
  const tipRef = useRef<HTMLSpanElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; placement: 'top' | 'bottom' } | null>(null);

  const updatePosition = useCallback(() => {
    const tip = tipRef.current;
    if (!tip || typeof window === 'undefined') return;
    const rect = tip.getBoundingClientRect();
    const maxWidth = Math.min(360, Math.max(160, window.innerWidth - 48));
    const minLeft = 24 + maxWidth / 2;
    const maxLeft = window.innerWidth - 24 - maxWidth / 2;
    const centered = rect.left + rect.width / 2;
    const left = Math.min(Math.max(centered, minLeft), Math.max(minLeft, maxLeft));
    const useBottom = rect.top < 80;
    setPosition({
      left,
      top: useBottom ? rect.bottom + 8 : rect.top - 8,
      placement: useBottom ? 'bottom' : 'top',
    });
  }, []);

  const show = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    updatePosition();
    setOpen(true);
  }, [updatePosition]);

  // Delay the hide so the pointer can travel from the trigger to the
  // body-portaled popover without it vanishing — required to select/copy the
  // popover text. Hovering the popover itself cancels the pending hide (show).
  const hide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setOpen(false), 160);
  }, []);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  useEffect(() => {
    if (!open) return undefined;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  const popover = open && position && typeof document !== 'undefined'
    ? createPortal(
      <span
        className={`ui-info-pop ui-info-pop-floating ui-info-pop-${position.placement}`}
        role="tooltip"
        style={{ left: position.left, top: position.top }}
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        {props.children}
      </span>,
      floatingPortalHost(tipRef.current, document.body),
    )
    : null;

  return (
    <span
      ref={tipRef}
      className={['ui-info-tip', props.className].filter(Boolean).join(' ')}
      tabIndex={props.focusable === false ? undefined : 0}
      aria-label={props.label}
      onClick={props.preventClick === false ? undefined : event => event.preventDefault()}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {props.trigger ?? <span className="ui-info-mark" aria-hidden="true">?</span>}
      {popover}
    </span>
  );
}

export function OverflowText(props: {
  text: string;
  children?: ReactNode;
  className?: string;
  textClassName?: string;
  popoverClassName?: string;
  showPopover?: boolean;
  durationMs?: number;
}): React.JSX.Element {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; placement: 'top' | 'bottom' } | null>(null);

  const measureOverflow = useCallback((): boolean => {
    const anchor = anchorRef.current;
    if (!anchor) return false;
    const text = anchor.querySelector<HTMLElement>('.ui-overflow-scroll') ?? anchor;
    const nextOverflowing = text.scrollWidth > anchor.clientWidth + 1;
    setOverflowing(nextOverflowing);
    if (!nextOverflowing) setOpen(false);
    return nextOverflowing;
  }, []);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === 'undefined') return;
    const rect = anchor.getBoundingClientRect();
    const maxWidth = Math.min(460, Math.max(220, window.innerWidth - 48));
    const minLeft = 24 + maxWidth / 2;
    const maxLeft = window.innerWidth - 24 - maxWidth / 2;
    const centered = rect.left + rect.width / 2;
    const left = Math.min(Math.max(centered, minLeft), Math.max(minLeft, maxLeft));
    const useBottom = rect.top < 84;
    setPosition({
      left,
      top: useBottom ? rect.bottom + 8 : rect.top - 8,
      placement: useBottom ? 'bottom' : 'top',
    });
  }, []);

  const show = useCallback(() => {
    if (!props.text.trim() || !measureOverflow()) return;
    if (props.showPopover === false) {
      setOpen(false);
      return;
    }
    updatePosition();
    setOpen(true);
  }, [measureOverflow, props.showPopover, props.text, updatePosition]);

  const hide = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === 'undefined') return undefined;
    const raf = window.requestAnimationFrame(measureOverflow);
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => measureOverflow())
      : null;
    resizeObserver?.observe(anchor);
    window.addEventListener('resize', measureOverflow);
    return () => {
      window.cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measureOverflow);
    };
  }, [measureOverflow, props.text]);

  useEffect(() => {
    if (!open) return undefined;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  const popover = props.showPopover !== false && open && position && typeof document !== 'undefined'
    ? createPortal(
      <span
        className={[
          'ui-info-pop',
          'ui-info-pop-floating',
          `ui-info-pop-${position.placement}`,
          'ui-overflow-popover',
          props.popoverClassName,
        ].filter(Boolean).join(' ')}
        role="tooltip"
        style={{ left: position.left, top: position.top }}
      >
        {props.text}
      </span>,
      floatingPortalHost(anchorRef.current, document.body),
    )
    : null;

  return (
    <span
      ref={anchorRef}
      className={['ui-overflow-text', overflowing ? 'is-overflowing' : '', props.className].filter(Boolean).join(' ')}
      style={props.durationMs ? { '--ui-overflow-duration': `${props.durationMs}ms` } as CSSProperties : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <span className={['ui-overflow-scroll', props.textClassName].filter(Boolean).join(' ')}>
        {props.children ?? props.text}
      </span>
      {popover}
    </span>
  );
}

export function FieldTitle(props: {
  children: ReactNode;
  help?: ReactNode;
  helpLabel?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={['ui-field-title', props.className].filter(Boolean).join(' ')}>
      <span className="ui-field-title-text">{props.children}</span>
      {props.help ? <InfoTip label={props.helpLabel}>{props.help}</InfoTip> : null}
    </span>
  );
}

export function OverviewList(props: {
  id?: string;
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  return <ul className={['overview-list', props.className].filter(Boolean).join(' ')} id={props.id}>{props.children}</ul>;
}

export function OverviewListItem(props: HTMLAttributes<HTMLLIElement> & {
  kind?: 'session' | 'schedule' | 'group';
  children: ReactNode;
}): React.JSX.Element {
  const { kind, className, children, ...rest } = props;
  const kindClass = kind ? `overview-list-item-${kind}` : '';
  return <li {...rest} className={['overview-list-item', kindClass, className].filter(Boolean).join(' ')}>{children}</li>;
}

export function OverviewListMain(props: { children: ReactNode }): React.JSX.Element {
  return <div className="overview-list-main">{props.children}</div>;
}

export function OverviewListTail(props: { children: ReactNode }): React.JSX.Element {
  return <div className="overview-list-tail">{props.children}</div>;
}

type DropdownMenuProps<T extends string> = {
  id?: string;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
  hidden?: boolean;
  style?: CSSProperties;
  label: ReactNode;
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  /** Filter box at the top of the popup, for long option lists (e.g. 20+ CLIs). */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Shown instead of options when the filter matches nothing. */
  searchEmptyLabel?: ReactNode;
};

/**
 * Where a dropdown popup should go, and how tall it may be.
 *
 * A dropdown's ancestors are mostly `overflow: hidden` (main / .chrome-body /
 * .app-shell), so a popup hanging past the viewport edge is clipped away: those
 * options cannot be seen, and pointer/wheel events never reach them either
 * (the popup is not under the cursor down there). Plain CSS cannot know how
 * much room is left below the trigger, so the component measures it and hands
 * the budget to style.css as a custom property.
 *
 * Pure function of the geometry so it can be unit-tested without a DOM.
 */
export function dropdownPlacement(input: {
  /** Trigger box, viewport-relative (getBoundingClientRect). */
  triggerTop: number;
  triggerBottom: number;
  /** Unconstrained popup height (scrollHeight), i.e. what the content wants. */
  naturalHeight: number;
  viewportHeight: number;
  /**
   * Size for this direction instead of deciding one. Used when a per-page rule
   * pins the direction with higher specificity than the `.is-drop-up` class, so
   * the budget must match what actually rendered rather than what we asked for.
   */
  forceDropUp?: boolean;
}): { dropUp: boolean; maxHeight: number } {
  const margin = 12;
  const gap = 8;
  const roomBelow = input.viewportHeight - input.triggerBottom - gap - margin;
  const roomAbove = input.triggerTop - gap - margin;
  // Flip up only when below genuinely cannot fit AND above is roomier;
  // otherwise stay below (predictable) and just cap the height.
  const dropUp = input.forceDropUp ?? (input.naturalHeight > roomBelow && roomAbove > roomBelow);
  // Floor: in a viewport too short for either side, a tiny sliver would be
  // worse than a popup that slightly overhangs but is still scrollable.
  const maxHeight = Math.max(140, Math.floor(dropUp ? roomAbove : roomBelow));
  return { dropUp, maxHeight };
}

export function DropdownMenu<T extends string>(props: DropdownMenuProps<T>): React.JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const choose = (next: T) => {
    detailsRef.current?.removeAttribute('open');
    // Belt-and-braces: `onToggle` normally syncs this, but WebKit before Safari
    // 15.4 did not fire toggle for programmatic open changes, which would leave
    // `open` stuck true and the placement effect skipped on the next open (stale
    // budget / drop-up class). Setting it here closes that loop; on browsers that
    // do fire toggle React bails out of the identical-state update, so it is free.
    setOpen(false);
    // Re-selecting the already-active value is a no-op: close the menu but skip
    // onChange, so auto-saving dropdowns don't fire a redundant write + "saved" flash.
    if (next === props.value) return;
    props.onChange(next);
  };
  const queryNorm = query.trim().toLowerCase();
  // Match on the visible label when it is plain text, plus the value itself
  // (users search either "Claude" or "claude-code").
  const visibleOptions = props.searchable && queryNorm
    ? props.options.filter(option =>
      option.value.toLowerCase().includes(queryNorm)
      || (typeof option.label === 'string' && option.label.toLowerCase().includes(queryNorm)))
    : props.options;

  // Keep the popup inside the viewport; see dropdownPlacement above.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const details = detailsRef.current;
      const pop = popRef.current;
      if (!details || !pop) return;
      const trigger = details.getBoundingClientRect();
      const { dropUp, maxHeight } = dropdownPlacement({
        triggerTop: trigger.top,
        triggerBottom: trigger.bottom,
        naturalHeight: pop.scrollHeight,
        viewportHeight: window.innerHeight,
      });
      details.classList.toggle('is-drop-up', dropUp);
      // A per-page rule may pin the direction regardless of the class — e.g.
      // `.connector-create-modal #cn-verify .sect-sort-pop` sets `bottom` with
      // ID specificity, so that popup always opens upward. Budgeting for the
      // side we merely *asked* for would then clip it off the opposite edge, so
      // detect where it actually landed and size for that side.
      //
      // Measure geometry, not `getComputedStyle().top`: for a positioned box the
      // computed value resolves `auto` to a used pixel value, never the string
      // 'auto', so a style probe reports "not flipped" for every popup.
      const popBox = pop.getBoundingClientRect();
      const renderedUp = popBox.height > 0 && popBox.bottom <= trigger.top + 1;
      const effective = renderedUp === dropUp
        ? maxHeight
        : dropdownPlacement({
          triggerTop: trigger.top,
          triggerBottom: trigger.bottom,
          naturalHeight: pop.scrollHeight,
          viewportHeight: window.innerHeight,
          forceDropUp: renderedUp,
        }).maxHeight;
      pop.style.setProperty('--dropdown-popover-space', `${effective}px`);
    };
    const frame = window.requestAnimationFrame(place);
    window.addEventListener('resize', place);
    // Capture phase: the scroller is an ancestor (main), not window.
    window.addEventListener('scroll', place, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, visibleOptions.length]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const close = () => {
      if (detailsRef.current?.open) detailsRef.current.open = false;
      // Same reason as in choose(): don't rely solely on toggle firing.
      setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (!details?.open) return;
      const target = event.target;
      if (target instanceof Node && details.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  useEffect(() => {
    if (!props.disabled) return;
    if (detailsRef.current?.open) detailsRef.current.open = false;
    // Third programmatic close path — keep it in sync too (see choose()).
    setOpen(false);
  }, [props.disabled]);

  const className = ['sect-sort-menu', props.disabled ? 'is-disabled' : '', props.className].filter(Boolean).join(' ');

  return (
    <details
      id={props.id}
      className={className}
      ref={detailsRef}
      hidden={props.hidden}
      style={props.style}
      onToggle={event => {
        // <details> fires toggle for programmatic `.open = false` too, so this is
        // the single place that keeps the placement effect in sync with reality.
        const isOpen = event.currentTarget.open;
        setOpen(isOpen);
        if (!props.searchable || !isOpen) return;
        setQuery('');
        searchRef.current?.focus();
      }}
    >
      <summary
        aria-label={props.ariaLabel}
        aria-disabled={props.disabled ? true : undefined}
        tabIndex={props.disabled ? -1 : undefined}
        onClick={event => {
          if (props.disabled) event.preventDefault();
        }}
        onKeyDown={event => {
          if (props.disabled && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
        }}
      >
        <span className="sect-sort-value">{props.label}</span>
      </summary>
      <div className="sect-sort-pop" ref={popRef}>
        {props.searchable ? (
          <input
            ref={searchRef}
            className="sect-sort-search"
            type="search"
            placeholder={props.searchPlaceholder}
            aria-label={props.searchPlaceholder}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={event => setQuery(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter') return;
              // The dropdown often sits inside a <form>: never let Enter submit
              // it. Enter picks the first matching option instead.
              event.preventDefault();
              const first = visibleOptions.find(option => !option.disabled);
              if (first) choose(first.value);
            }}
          />
        ) : null}
        {visibleOptions.map(option => (
          <button
            key={option.value}
            type="button"
            disabled={option.disabled}
            aria-current={props.value === option.value ? 'true' : undefined}
            onClick={() => choose(option.value)}
          >
            {option.label}
          </button>
        ))}
        {props.searchable && visibleOptions.length === 0
          ? <p className="sect-sort-empty">{props.searchEmptyLabel}</p>
          : null}
      </div>
    </details>
  );
}

export function SortMenu<T extends string>(props: DropdownMenuProps<T>): React.JSX.Element {
  return <DropdownMenu {...props} />;
}
