import { useId, type ReactNode } from 'react';

type StatusTone = 'ok' | 'warn' | 'muted';

function statusToneClass(tone?: StatusTone): string {
  switch (tone) {
    case 'ok':
      return 'hint-ok';
    case 'muted':
      return 'hint-muted';
    case 'warn':
    default:
      return 'hint-warn-inline';
  }
}

export function StreamingCardPinToggle(props: {
  scope: 'bot-defaults' | 'group-manage';
  checked: boolean;
  disabled?: boolean;
  title: ReactNode;
  help?: ReactNode;
  description?: ReactNode;
  describedBy?: string;
  detail?: ReactNode;
  detailTone?: StatusTone;
  detailAttrs?: Record<string, string>;
  status?: ReactNode;
  statusTone?: StatusTone;
  statusAttrs?: Record<string, string>;
  className?: string;
  dataAction?: string;
  dataAppId?: string;
  onChange(checked: boolean): void;
}) {
  const className = [
    'streaming-card-pin-toggle',
    `streaming-card-pin-toggle-${props.scope}`,
    props.className ?? '',
  ].filter(Boolean).join(' ');
  const baseId = useId();
  const descriptionId = props.description ? `${baseId}-description` : '';
  const helpId = props.help ? `${baseId}-help` : '';
  const ariaDescribedBy = [props.describedBy, descriptionId, helpId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={className} data-streaming-card-pin-toggle={props.scope}>
      <label className="toggle-row streaming-card-pin-toggle-row">
        <input
          type="checkbox"
          data-action={props.dataAction}
          data-app-id={props.dataAppId}
          aria-describedby={ariaDescribedBy}
          checked={props.checked}
          disabled={props.disabled}
          onChange={event => props.onChange(event.currentTarget.checked)}
        />
        <span className="switch" aria-hidden="true" />
        <span className="toggle-tx">
          <strong>{props.title}</strong>
          {props.description ? <small id={descriptionId}>{props.description}</small> : null}
        </span>
      </label>
      {props.help ? (
        <p
          id={helpId}
          className="streaming-card-pin-toggle-help hint-muted"
          data-streaming-card-pin-help={props.scope}
        >
          {props.help}
        </p>
      ) : null}
      {props.detail ? (
        <p
          className={`streaming-card-pin-toggle-detail ${statusToneClass(props.detailTone)}`}
          {...(props.detailAttrs ?? {})}
        >
          {props.detail}
        </p>
      ) : null}
      {props.status ? (
        <p
          className={`streaming-card-pin-toggle-status ${statusToneClass(props.statusTone)}`}
          role="status"
          aria-live="polite"
          {...(props.statusAttrs ?? {})}
        >
          {props.status}
        </p>
      ) : null}
    </div>
  );
}
