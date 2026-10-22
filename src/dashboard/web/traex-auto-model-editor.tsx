import { DropdownField, ModelPickerField } from './field-controls.js';
import { InfoTip } from './dashboard-components.js';
import { isCodexReasoningEffort, reasoningEffortsForCliModel } from '../../services/codex-reasoning-effort.js';
import type { TraexAutoModelSettings } from '../../services/traex-auto-model.js';
import type { ModelCapabilities } from './bot-defaults.js';
import { useT } from './react-hooks.js';

export function TraexAutoModelEditor(props: {
  enabled: boolean;
  reselectPerTurn: boolean;
  models: string[];
  modelSettings: Record<string, TraexAutoModelSettings>;
  timeoutSeconds: string;
  cooldownSeconds: string;
  candidates: string[];
  capabilities?: ModelCapabilities[];
  busy: boolean;
  dirty?: boolean;
  storageFailed?: boolean;
  saveStatus?: string;
  onSave?: () => void;
  onEnabled: (enabled: boolean) => void;
  onReselectPerTurn: (enabled: boolean) => void;
  onModels: (models: string[]) => void;
  onSettings: (model: string, settings: TraexAutoModelSettings) => void;
  onTimeout: (seconds: string) => void;
  onCooldown: (seconds: string) => void;
}) {
  const tr = useT();
  function move(index: number, delta: number) {
    const next = [...props.models];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    props.onModels(next);
  }
  const capacityLabel = (tokens: number) => tokens >= 1_000_000
    ? `${Number((tokens / 1_000_000).toFixed(2))}M` : `${Number((tokens / 1_000).toFixed(1))}K`;
  return (
    <div className="bd-auto-model" data-traex-auto-model="">
      <label className="bd-auto-model-toggle">
        <input type="checkbox" data-input="autoModelEnabled" checked={props.enabled}
          disabled={props.busy} onChange={event => props.onEnabled(event.currentTarget.checked)} />
        <span>{tr('botDefaults.autoModelTitle')}</span>
      </label>
      <div className="bd-auto-model-description">
        <span>{tr('botDefaults.autoModelSummary')}</span>
        <InfoTip label={tr('botDefaults.autoModelDetails')} className="bd-info-tip" trigger="?">
          {tr('botDefaults.autoModelHelp')}
        </InfoTip>
      </div>
      {props.enabled ? <>
        <label className="bd-auto-model-toggle">
          <input type="checkbox" data-input="autoModelReselectPerTurn" checked={props.reselectPerTurn}
            disabled={props.busy} onChange={event => props.onReselectPerTurn(event.currentTarget.checked)} />
          <span>{tr('botDefaults.autoModelReselectPerTurn')}</span>
          <InfoTip label={tr('botDefaults.autoModelDetails')} className="bd-info-tip" trigger="?">
            {tr('botDefaults.autoModelReselectPerTurnHelp')}
          </InfoTip>
        </label>
        <ol className="bd-auto-model-list">
          {props.models.map((model, index) => {
            const settings = props.modelSettings[model] ?? {};
            const capability = props.capabilities?.find(entry => entry.slug.toLowerCase() === model.toLowerCase());
            const variant = capability?.contextVariants?.find(entry => entry.id === settings.modelBackendVariant);
            const efforts = (variant?.reasoningEfforts ?? capability?.reasoningEfforts
              ?? reasoningEffortsForCliModel('traex', model)).filter(isCodexReasoningEffort);
            const contextOptions = [
              { value: '', label: capability?.contextWindow
                ? `${tr('botDefaults.autoModelDefault')} · ${capacityLabel(capability.contextWindow)}`
                : tr('botDefaults.autoModelDefault') },
              ...(capability?.contextVariants ?? []).map(entry => ({
                value: entry.id, label: `${entry.id === 'max' ? 'Max' : 'Standard'} · ${capacityLabel(entry.contextWindow)}`,
              })),
            ];
            if (settings.modelBackendVariant && !contextOptions.some(entry => entry.value === settings.modelBackendVariant)) {
              contextOptions.push({ value: settings.modelBackendVariant, label: settings.modelBackendVariant === 'max' ? 'Max' : 'Standard' });
            }
            return <li key={index}>
              <div className="bd-auto-model-main">
              <span className="bd-auto-model-rank">{index === 0 ? tr('botDefaults.autoModelPreferred') : `${index + 1}`}</span>
              <div className="bd-auto-model-picker">
                <ModelPickerField value={model} options={props.candidates.filter(candidate =>
                  !props.models.some((entry, at) => at !== index && entry.toLowerCase() === candidate.toLowerCase()))}
                  disabled={props.busy} dataInput={`autoModel${index}`} ariaLabel={`${tr('botDefaults.agentModel')} ${index + 1}`}
                  defaultLabel={tr('botDefaults.modelPickerDefault')} customLabel={tr('botDefaults.modelPickerCustom')}
                  menuClassName="bd-field-menu"
                  onChange={value => props.onModels(props.models.map((entry, at) => at === index ? value : entry))} />
              </div>
              <button type="button" aria-label={tr('botDefaults.autoModelUp')} disabled={props.busy || index === 0}
                onClick={() => move(index, -1)}>↑</button>
              <button type="button" aria-label={tr('botDefaults.autoModelDown')} disabled={props.busy || index === props.models.length - 1}
                onClick={() => move(index, 1)}>↓</button>
              <button type="button" aria-label={tr('botDefaults.autoModelRemove')} disabled={props.busy || props.models.length === 1}
                onClick={() => props.onModels(props.models.filter((_, at) => at !== index))}>×</button>
              </div>
              <div className="bd-auto-model-settings">
                <div className="bd-auto-model-setting">
                  <span>{tr('botDefaults.agentReasoningEffort')}</span>
                  <DropdownField dataInput={`autoModelEffort${index}`} ariaLabel={`${model} ${tr('botDefaults.agentReasoningEffort')}`}
                    value={settings.reasoningEffort ?? ''} disabled={props.busy || !model}
                    options={[{ value: '', label: tr('botDefaults.autoModelDefault') },
                      ...efforts.map(effort => ({ value: effort, label: effort }))]}
                    onChange={effort => props.onSettings(model, {
                      ...settings, reasoningEffort: isCodexReasoningEffort(effort) ? effort : undefined,
                    })} />
                </div>
                <div className="bd-auto-model-setting">
                  <span>{tr('botDefaults.autoModelContext')}</span>
                  <DropdownField dataInput={`autoModelContext${index}`} ariaLabel={`${model} ${tr('botDefaults.autoModelContext')}`}
                    value={settings.modelBackendVariant ?? ''} disabled={props.busy || !model}
                    options={contextOptions}
                    onChange={value => {
                      const nextVariant = value === 'standard' || value === 'max' ? value : undefined;
                      const allowed = capability?.contextVariants?.find(entry => entry.id === nextVariant)?.reasoningEfforts
                        ?? capability?.reasoningEfforts ?? efforts;
                      props.onSettings(model, { ...settings, modelBackendVariant: nextVariant,
                        reasoningEffort: settings.reasoningEffort && allowed.includes(settings.reasoningEffort)
                          ? settings.reasoningEffort : undefined });
                    }} />
                </div>
              </div>
            </li>
          })}
        </ol>
        <button type="button" data-action="autoModelAdd" disabled={props.busy}
          onClick={() => props.onModels([...props.models, ''])}>{tr('botDefaults.autoModelAdd')}</button>
        <span className="bd-auto-model-count">{tr('botDefaults.autoModelCount', { count: props.models.length })}</span>
        <label className="bd-auto-model-timeout">
          <span>{tr('botDefaults.autoModelTimeout')}</span>
          <input type="number" min="5" max="300" step="1" data-input="autoModelTimeout"
            value={props.timeoutSeconds} disabled={props.busy}
            onChange={event => props.onTimeout(event.currentTarget.value)} />
        </label>
        <label className="bd-auto-model-timeout">
          <span>{tr('botDefaults.autoModelCooldown')}</span>
          <input type="number" min="5" max="300" step="1" data-input="autoModelCooldown"
            value={props.cooldownSeconds} disabled={props.busy}
            onChange={event => props.onCooldown(event.currentTarget.value)} />
        </label>
      </> : null}
      <div className="bd-auto-model-save">
        <button type="button" className="primary" data-action="save-auto-model"
          disabled={props.busy || !props.dirty} onClick={props.onSave}>
          {tr('botDefaults.autoModelSave')}
        </button>
        <span data-auto-model-save-state="" role="status">
          {props.dirty
            ? [props.saveStatus, tr(props.storageFailed ? 'botDefaults.autoModelDraftStorageFailed' : 'botDefaults.autoModelDraftKept')].filter(Boolean).join(' · ')
            : props.saveStatus ?? tr('botDefaults.autoModelSaved')}
        </span>
      </div>
    </div>
  );
}
