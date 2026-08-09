import type React from 'react';
import { useEffect, useRef } from 'react';

export type FeedGroupPickerOption = { groupId: string; name: string };

export function FeedGroupPicker(props: {
  groups: FeedGroupPickerOption[];
  selectedId: string;
  newName: string;
  disabled?: boolean;
  onChange(selectedId: string, newName: string): void;
}): React.JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const selectedName = props.groups.find(group => group.groupId === props.selectedId)?.name;
  const label = props.newName.trim()
    ? `新建标签：${props.newName.trim()}`
    : selectedName || '不选择标签';

  useEffect(() => {
    const closeOnOutside = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (!details?.open) return;
      if (event.target instanceof Node && details.contains(event.target)) return;
      details.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && detailsRef.current?.open) detailsRef.current.open = false;
    };
    document.addEventListener('pointerdown', closeOnOutside, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  return (
    <details ref={detailsRef} className={`feed-group-picker${props.disabled ? ' is-disabled' : ''}`}>
      <summary
        aria-label="飞书标签"
        aria-disabled={props.disabled || undefined}
        onClick={event => { if (props.disabled) event.preventDefault(); }}
      >
        <span>{label}</span>
      </summary>
      <div className="feed-group-picker-pop">
        <label className="feed-group-picker-new">
          <span>新建标签</span>
          <input
            type="text"
            maxLength={60}
            value={props.newName}
            placeholder="输入新标签名称"
            onChange={event => props.onChange('', event.currentTarget.value.trimStart())}
            onKeyDown={event => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
        </label>
        <button
          type="button"
          aria-current={!props.selectedId && !props.newName.trim() ? 'true' : undefined}
          onClick={() => { props.onChange('', ''); detailsRef.current?.removeAttribute('open'); }}
        >
          不选择标签
        </button>
        {props.groups.map(group => (
          <button
            key={group.groupId}
            type="button"
            aria-current={props.selectedId === group.groupId && !props.newName.trim() ? 'true' : undefined}
            onClick={() => { props.onChange(group.groupId, ''); detailsRef.current?.removeAttribute('open'); }}
          >
            {group.name}
          </button>
        ))}
      </div>
    </details>
  );
}
