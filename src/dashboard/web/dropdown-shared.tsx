import type React from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { floatingPortalHost } from './floating-host.js';

// Pieces shared by DropdownMenu's eager shell (dashboard-components.tsx) and its
// on-demand Base UI implementations (dropdown-select.tsx, dropdown-combobox.tsx).
// Nothing here may import Base UI, or it lands back in app.js.

export type DropdownOption<T extends string> = {
  value: T;
  label: ReactNode;
  /**
   * Optional second line under the label, shown in the popup only (the
   * collapsed trigger keeps rendering `label` alone via dropdownLabel).
   * Lets option lists double as inline help for hard-to-name settings.
   */
  hint?: ReactNode;
  /** Non-selectable informational entry (e.g. a mode the current CLI can't use). */
  disabled?: boolean;
};

export function dropdownLabel<T extends string>(options: DropdownOption<T>[], value: T): ReactNode {
  return options.find(option => option.value === value)?.label ?? value;
}

export type DropdownMenuProps<T extends string> = {
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
  /** Manual-save selectors may need to distinguish an explicit same-value choice. */
  notifyOnReselect?: boolean;
  /** Filter box at the top of the popup, for long option lists (e.g. 20+ CLIs). */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Shown instead of options when the filter matches nothing. */
  searchEmptyLabel?: ReactNode;
};

/** `is-open` stands in for the old `<details open>` so page CSS can style an open trigger. */
export function dropdownRootClassName(props: DropdownMenuProps<string>, open: boolean): string {
  return ['sect-sort-menu', props.disabled ? 'is-disabled' : '', open ? 'is-open' : '', props.className]
    .filter(Boolean)
    .join(' ');
}

export function commitDropdownChoice(props: DropdownMenuProps<string>, next: string): void {
  // Base UI reports picking the already-selected option as a change. Treat it as
  // a no-op so auto-saving dropdowns don't fire a redundant write + "saved" flash.
  if (next === props.value && !props.notifyOnReselect) return;
  props.onChange(next);
}

/**
 * Base UI gives a focused, closed trigger typeahead: a printable key commits the
 * next matching option without the popup ever showing, and most dashboard
 * dropdowns save on change. It has no switch for that, so swallow printable
 * keys in the capture phase until the popup is open. Space must still get
 * through: the trigger is not a native button, so it opens from Base UI's own
 * key handlers rather than a browser default action.
 */
export function swallowClosedTypeahead(event: KeyboardEvent, open: boolean): void {
  if (open || event.key.length !== 1 || event.key === ' ') return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  event.stopPropagation();
}

export type DropdownPopupPlacement = {
  container: HTMLElement | null;
  align: 'start' | 'center' | 'end';
};

export const DEFAULT_POPUP_PLACEMENT: DropdownPopupPlacement = { container: null, align: 'center' };

/**
 * Read at open time where the popup mounts and how it lines up with the
 * trigger. The popup is portaled away from the page, so page CSS cannot reach
 * it through ancestors; a menu that should hang from its left or right edge
 * says so with `--dropdown-align: start | end` on the trigger root, which page
 * CSS can still scope.
 */
export function dropdownPopupPlacement(root: HTMLElement | null): DropdownPopupPlacement {
  if (!root) return DEFAULT_POPUP_PLACEMENT;
  const align = window.getComputedStyle(root).getPropertyValue('--dropdown-align').trim();
  return {
    container: floatingPortalHost(root, document.body) as HTMLElement,
    align: align === 'start' || align === 'end' ? align : 'center',
  };
}

export function DropdownTriggerValue(props: { label: ReactNode }): React.JSX.Element {
  return <span className="sect-sort-value">{props.label}</span>;
}

export function DropdownOptionContent(props: { option: DropdownOption<string> }): React.JSX.Element {
  const { option } = props;
  if (!option.hint) return <>{option.label}</>;
  return (
    <span className="sect-sort-option">
      <span className="sect-sort-option-title">{option.label}</span>
      <span className="sect-sort-option-hint">{option.hint}</span>
    </span>
  );
}

/** Match on the visible label when it is plain text, plus the value itself (users search either "Claude" or "claude-code"). */
export function filterDropdownOptions<T extends string>(options: DropdownOption<T>[], query: string): DropdownOption<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter(option =>
    option.value.toLowerCase().includes(q)
    || (typeof option.label === 'string' && option.label.toLowerCase().includes(q)));
}
