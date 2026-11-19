import type React from 'react';
import { useMemo, useState } from 'react';
import type { ScheduleBotGrant } from '../../global-config.js';
import { isScheduleBotGrant, overlappingScheduleBotGrants, scheduleBotGrantFieldValid as valid } from '../../core/schedule-bot-grant.js';
import { BotMultiSelect } from './bot-multi-select.js';
import { DropdownMenu, FieldTitle, dropdownLabel } from './dashboard-components.js';
import { confirm } from './confirm-modal.js';
import { useT } from './react-hooks.js';

export interface ScheduleBotGrantBotOption {
  larkAppId: string;
  botName: string | null;
}

interface Draft {
  id: string;
  sourceAppId: string;
  targetAppIds: Set<string>;
  chats: string;
  controllerUnionId: string;
}

const emptyDraft = (): Draft => ({ id: '', sourceAppId: '', targetAppIds: new Set(), chats: '', controllerUnionId: '' });

function draftOf(grant: ScheduleBotGrant): Draft {
  return {
    id: grant.id, sourceAppId: grant.sourceAppId, targetAppIds: new Set(grant.targetAppIds),
    chats: grant.chatIds.join(', '), controllerUnionId: grant.controllerUnionId,
  };
}

function grantOf(draft: Draft): ScheduleBotGrant {
  return {
    id: draft.id.trim(),
    sourceAppId: draft.sourceAppId,
    targetAppIds: [...draft.targetAppIds],
    chatIds: [...new Set(draft.chats.split(/[\s,，、]+/).filter(Boolean))],
    controllerUnionId: draft.controllerUnionId.trim(),
  };
}

/** First reason the draft cannot be saved next to `others`, as an i18n key
 *  (plus the conflicting grant id, if any); null when it is savable. The same
 *  predicate and overlap rule the server applies, so a save never bounces. */
export function scheduleBotGrantDraftProblem(
  grant: ScheduleBotGrant,
  others: readonly ScheduleBotGrant[],
): { key: string; other?: string } | null {
  if (!grant.id) return { key: 'settings.scheduleBotGrantsIdRequired' };
  if (!valid.id(grant.id)) return { key: 'settings.scheduleBotGrantsIdInvalid' };
  if (!valid.appId(grant.sourceAppId)) return { key: 'settings.scheduleBotGrantsSourceRequired' };
  if (grant.targetAppIds.length === 0) return { key: 'settings.scheduleBotGrantsTargetsRequired' };
  if (grant.chatIds.length === 0 || !grant.chatIds.every(valid.chatId)) {
    return { key: 'settings.scheduleBotGrantsChatsInvalid' };
  }
  if (!valid.unionId(grant.controllerUnionId)) return { key: 'settings.scheduleBotGrantsControllerInvalid' };
  // Backstop for any field not covered above (e.g. a target app id).
  if (!isScheduleBotGrant(grant)) return { key: 'settings.scheduleBotGrantsInvalid' };
  const duplicate = others.find(other => other.id === grant.id);
  if (duplicate) return { key: 'settings.scheduleBotGrantsIdDuplicate', other: duplicate.id };
  const overlap = overlappingScheduleBotGrants([grant, ...others]).find(([a]) => a === grant.id);
  if (overlap) return { key: 'settings.scheduleBotGrantsOverlap', other: overlap[1] };
  return null;
}

/**
 * Global settings → experimental: `scheduleDelegation.botGrants`. Each change
 * saves the whole list; an empty list removes the key from config.json.
 */
export function ScheduleBotGrantsEditor(props: {
  grants: ScheduleBotGrant[];
  /** Hand-edited entries the server could not load; saving the list drops them. */
  ignoredCount?: number;
  botOptions: ScheduleBotGrantBotOption[];
  createEnabled: boolean;
  disabled: boolean;
  onSave(grants: ScheduleBotGrant[]): Promise<void> | void;
}): React.JSX.Element {
  const tr = useT();
  // null = not editing; -1 = adding a new grant; otherwise the edited index.
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const botName = (appId: string) => props.botOptions.find(bot => bot.larkAppId === appId)?.botName || appId;
  const sourceOptions = useMemo(() => [
    { value: '', label: tr('settings.scheduleBotGrantsSourcePlaceholder') },
    ...props.botOptions.map(bot => ({ value: bot.larkAppId, label: bot.botName || bot.larkAppId })),
  ], [props.botOptions, tr]);
  const targetOptions = props.botOptions
    .filter(bot => bot.larkAppId !== draft.sourceAppId)
    .map(bot => ({ larkAppId: bot.larkAppId, ...(bot.botName ? { botName: bot.botName } : {}) }));

  const others = editing === null ? props.grants : props.grants.filter((_, i) => i !== editing);
  const candidate = grantOf(draft);
  const problem = editing === null ? null : scheduleBotGrantDraftProblem(candidate, others);

  const startEdit = (index: number) => {
    setEditing(index);
    setDraft(index === -1 ? emptyDraft() : draftOf(props.grants[index]));
  };
  const submit = async () => {
    if (editing === null || problem || props.disabled) return;
    const next = editing === -1
      ? [...props.grants, candidate]
      : props.grants.map((grant, i) => (i === editing ? candidate : grant));
    await props.onSave(next);
    setEditing(null);
  };
  const remove = async (grant: ScheduleBotGrant) => {
    const ok = await confirm({
      title: tr('settings.scheduleBotGrantsRemoveTitle'),
      message: tr('settings.scheduleBotGrantsRemoveMessage', { id: grant.id }),
      confirmLabel: tr('settings.scheduleBotGrantsRemove'),
      cancelLabel: tr('settings.scheduleBotGrantsCancel'),
    });
    if (ok) await props.onSave(props.grants.filter(item => item !== grant));
  };

  return (
    <div className="settings-subfield settings-bot-grants" data-schedule-bot-grants>
      <FieldTitle help={tr('settings.scheduleBotGrantsHelp')}>{tr('settings.scheduleBotGrants')}</FieldTitle>
      {props.grants.length > 0 && !props.createEnabled ? (
        <p className="hint-warn-inline" data-bot-grants-inactive>
          {tr('settings.scheduleBotGrantsInactive')}
        </p>
      ) : null}
      {props.ignoredCount ? (
        <p className="hint-warn-inline" data-bot-grants-ignored={props.ignoredCount}>
          {tr('settings.scheduleBotGrantsIgnored', { n: props.ignoredCount })}
        </p>
      ) : null}
      {props.grants.length === 0 ? (
        <p className="settings-subfield-hint">{tr('settings.scheduleBotGrantsEmpty')}</p>
      ) : (
        <ul className="settings-bot-grant-list">
          {props.grants.map((grant, index) => (
            <li key={grant.id} className="settings-bot-grant" data-bot-grant={grant.id}>
              <div className="settings-bot-grant-main">
                <code>{grant.id}</code>
                <span>{botName(grant.sourceAppId)} → {grant.targetAppIds.map(botName).join('、')}</span>
                <small>
                  {tr('settings.scheduleBotGrantsChatsLabel')}: {grant.chatIds.join(', ')}
                  {' · '}
                  {tr('settings.scheduleBotGrantsControllerLabel')}: {grant.controllerUnionId}
                </small>
              </div>
              <div className="actions">
                <button type="button" data-action="edit-grant" disabled={props.disabled || editing !== null}
                  onClick={() => startEdit(index)}>{tr('settings.scheduleBotGrantsEdit')}</button>
                <button type="button" data-action="remove-grant" disabled={props.disabled || editing !== null}
                  onClick={() => void remove(grant)}>{tr('settings.scheduleBotGrantsRemove')}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing === null ? (
        <div className="actions">
          <button type="button" data-action="add-grant" disabled={props.disabled}
            onClick={() => startEdit(-1)}>{tr('settings.scheduleBotGrantsAdd')}</button>
        </div>
      ) : (
        <div className="settings-codex-notifier-details settings-bot-grant-form" data-bot-grant-form>
          <div className="settings-field-row">
            <FieldTitle help={tr('settings.scheduleBotGrantsIdHelp')}>{tr('settings.scheduleBotGrantsId')}</FieldTitle>
            <input className="settings-text-input" type="text" data-input="grant-id" value={draft.id}
              disabled={props.disabled} placeholder="team-polling"
              onChange={event => { const id = event.currentTarget.value; setDraft(d => ({ ...d, id })); }} />
          </div>
          <div className="settings-field-row">
            <FieldTitle help={tr('settings.scheduleBotGrantsSourceHelp')}>{tr('settings.scheduleBotGrantsSource')}</FieldTitle>
            <DropdownMenu
              className="settings-field-menu"
              ariaLabel={tr('settings.scheduleBotGrantsSource')}
              disabled={props.disabled}
              searchable
              value={draft.sourceAppId}
              label={dropdownLabel(sourceOptions, draft.sourceAppId)}
              options={sourceOptions}
              onChange={sourceAppId => setDraft(d => {
                const targetAppIds = new Set(d.targetAppIds);
                targetAppIds.delete(sourceAppId);
                return { ...d, sourceAppId, targetAppIds };
              })}
            />
          </div>
          <div className="settings-bot-grant-targets">
            <FieldTitle help={tr('settings.scheduleBotGrantsTargetsHelp')}>{tr('settings.scheduleBotGrantsTargets')}</FieldTitle>
            <BotMultiSelect
              bots={targetOptions}
              selected={draft.targetAppIds}
              onToggle={(appId, checked) => setDraft(d => {
                const targetAppIds = new Set(d.targetAppIds);
                if (checked) targetAppIds.add(appId); else targetAppIds.delete(appId);
                return { ...d, targetAppIds };
              })}
              searchPlaceholder={tr('settings.scheduleBotGrantsTargetsSearch')}
              noMatchLabel={tr('settings.scheduleBotGrantsTargetsNoMatch')}
              emptyLabel={tr('settings.scheduleBotGrantsTargetsEmpty')}
              selectedCountLabel={n => tr('settings.scheduleBotGrantsTargetsSelected', { n })}
            />
          </div>
          <div className="settings-field-row">
            <FieldTitle help={tr('settings.scheduleBotGrantsChatsHelp')}>{tr('settings.scheduleBotGrantsChats')}</FieldTitle>
            <input className="settings-text-input" type="text" data-input="grant-chats" value={draft.chats}
              disabled={props.disabled} placeholder="oc_…"
              onChange={event => { const chats = event.currentTarget.value; setDraft(d => ({ ...d, chats })); }} />
          </div>
          <div className="settings-field-row">
            <FieldTitle help={tr('settings.scheduleBotGrantsControllerHelp')}>{tr('settings.scheduleBotGrantsController')}</FieldTitle>
            <input className="settings-text-input" type="text" data-input="grant-controller" value={draft.controllerUnionId}
              disabled={props.disabled} placeholder="on_…"
              onChange={event => {
                const controllerUnionId = event.currentTarget.value;
                setDraft(d => ({ ...d, controllerUnionId }));
              }} />
          </div>
          {problem ? (
            <p className="hint-warn-inline" data-bot-grant-problem={problem.key}>
              {tr(problem.key, { other: problem.other ?? '' })}
            </p>
          ) : null}
          <div className="actions">
            <button type="button" className="page-primary-action" data-action="save-grant"
              disabled={props.disabled || !!problem} onClick={() => void submit()}>
              {tr('settings.scheduleBotGrantsSave')}
            </button>
            <button type="button" data-action="cancel-grant" disabled={props.disabled}
              onClick={() => setEditing(null)}>{tr('settings.scheduleBotGrantsCancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
