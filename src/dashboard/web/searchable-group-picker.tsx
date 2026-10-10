import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

export function SearchableGroupPicker(props: {
  id: string;
  className?: string;
  label: string;
  groups: Array<{ chatId: string; name?: string }>;
  value: string | string[];
  multiple?: boolean;
  disabled?: boolean;
  allLabel?: string;
  placeholder: string;
  selectedContent?: React.ReactNode;
  searchPlaceholder: string;
  emptyLabel: string;
  selectedCountLabel(count: number): string;
  onChange(value: string | string[]): void;
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const values = Array.isArray(props.value) ? props.value : (props.value ? [props.value] : []);
  const valueSet = useMemo(() => new Set(values), [values]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredGroups = useMemo(() => {
    if (!normalizedQuery) return props.groups;
    return props.groups.filter(group => `${group.name} ${group.chatId}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [normalizedQuery, props.groups]);
  const selectedLabel = props.multiple
    ? (values.length === 0 ? props.allLabel || props.placeholder : props.selectedCountLabel(values.length))
    : (props.groups.find(group => group.chatId === values[0])?.name || values[0] || props.placeholder);
  const rootClassName = ['connector-group-picker', props.className, open ? 'open' : ''].filter(Boolean).join(' ');

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [open]);

  useEffect(() => { if (props.disabled) setOpen(false); }, [props.disabled]);

  function select(chatId: string): void {
    if (!props.multiple) {
      props.onChange(chatId);
      setOpen(false);
      setQuery('');
      return;
    }
    props.onChange(valueSet.has(chatId) ? values.filter(id => id !== chatId) : [...values, chatId]);
  }

  return (
    <div ref={rootRef} className={rootClassName}>
      <button
        id={props.id}
        type="button"
        className="connector-group-picker-trigger"
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => setOpen(current => !current)}
      >
        {props.selectedContent ?? (
          <span className={values.length || (props.multiple && props.allLabel) ? '' : 'muted'}>{selectedLabel}</span>
        )}
        <span className="connector-group-picker-chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div className="connector-group-picker-popover">
          <label className="connector-group-search" htmlFor={`${props.id}-search`}>
            <span className="connector-group-search-icon" aria-hidden="true" />
            <input
              id={`${props.id}-search`}
              type="search"
              aria-label={props.searchPlaceholder}
              autoComplete="off"
              autoFocus
              value={query}
              placeholder={props.searchPlaceholder}
              onChange={event => setQuery(event.currentTarget.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setOpen(false);
                  rootRef.current?.querySelector<HTMLButtonElement>('.connector-group-picker-trigger')?.focus();
                }
              }}
            />
          </label>
          <div className="connector-group-options" role="listbox" aria-label={props.label} aria-multiselectable={props.multiple || undefined}>
            {props.multiple && props.allLabel && !normalizedQuery ? (
              <button
                type="button"
                className={`connector-group-option connector-group-option-all${values.length === 0 ? ' selected' : ''}`}
                role="option"
                aria-selected={values.length === 0}
                onClick={() => props.onChange([])}
              >
                <span className="connector-group-check" aria-hidden="true" />
                <span><b>{props.allLabel}</b><small>{props.placeholder}</small></span>
              </button>
            ) : null}
            {filteredGroups.map(group => {
              const selected = valueSet.has(group.chatId);
              return (
                <button
                  type="button"
                  className={`connector-group-option${selected ? ' selected' : ''}`}
                  role="option"
                  aria-selected={selected}
                  key={group.chatId}
                  onClick={() => select(group.chatId)}
                >
                  <span className="connector-group-check" aria-hidden="true" />
                  <span><b>{group.name || group.chatId}</b>{group.name ? <small>{group.chatId}</small> : null}</span>
                </button>
              );
            })}
            {!filteredGroups.length ? <p className="connector-group-empty">{props.emptyLabel}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
