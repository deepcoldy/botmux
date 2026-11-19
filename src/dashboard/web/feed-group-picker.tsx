import type React from 'react';
import { lazyWithFallback } from './dashboard-components.js';

export type FeedGroupPickerOption = { groupId: string; name: string };

export type FeedGroupPickerProps = {
  groups: FeedGroupPickerOption[];
  selectedId: string;
  newName: string;
  disabled?: boolean;
  onChange(selectedId: string, newName: string): void;
};

/** What the closed picker shows, worked out once by the shell for both implementations. */
export type FeedGroupPickerImplProps = FeedGroupPickerProps & { label: string };

export function feedGroupPickerLabel(props: FeedGroupPickerProps): string {
  const selectedName = props.groups.find(group => group.groupId === props.selectedId)?.name;
  return props.newName.trim()
    ? `新建标签：${props.newName.trim()}`
    : selectedName || '不选择标签';
}

function FeedGroupPickerFallback(props: FeedGroupPickerImplProps): React.JSX.Element {
  return (
    <div className={`feed-group-picker${props.disabled ? ' is-disabled' : ''}`}>
      <div
        className="feed-group-picker-trigger"
        role="button"
        aria-label={`飞书标签，当前：${props.label}`}
        aria-disabled={props.disabled || undefined}
      >
        <span>{props.label}</span>
      </div>
    </div>
  );
}

const FeedGroupPickerPopover = lazyWithFallback(
  () => import('./feed-group-picker-popover.js'),
  FeedGroupPickerFallback,
  'feed group picker',
  { browserOnly: true },
);

export function FeedGroupPicker(props: FeedGroupPickerProps): React.JSX.Element {
  return <FeedGroupPickerPopover {...props} label={feedGroupPickerLabel(props)} />;
}
