import { useEffect, useState } from 'react';
import type { WecomNativePlatformConfig } from '../../im/wecom/config/native-platform-config.js';
import type { StatusMessage } from './bot-defaults-save.js';
import { useT } from './react-hooks.js';
import { NativeField, NativeGroup, NativeNote, NativeSaveActions, NativeToggle } from './wecom-native-core-section.js';

/** `/summary` 未配置范围时的默认值：与飞书一致，最近 50 条、24 小时（网关同一默认）。 */
const SUMMARY_DEFAULT_LIMIT = 50;
const SUMMARY_DEFAULT_SINCE_HOURS = 24;
const SUMMARY_DEFAULT_PATH = '.botmux/wecom-summary.md';

/**
 * 会话页的「/summary 总结范围」。按会话覆盖反馈规则（chatFeedbackPolicies）与反馈 Webhook
 * （feedbackWebhooks）和飞书一样只在配置文件里维护，这里不提供界面、也不提交这两个键。
 */
export function WecomNativePlatformSection({ id, value, save }: {
  /** 格子的 DOM id（企业微信卡按登记表给出，⌘K 深链落到这里）。 */
  id?: string;
  value?: WecomNativePlatformConfig;
  save: (patch: { native: WecomNativePlatformConfig }) => Promise<void>;
}) {
  const tr = useT();
  const [draft, setDraft] = useState<WecomNativePlatformConfig>(value ?? {});
  const [status, setStatus] = useState<StatusMessage>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft(value ?? {});
  }, [value]);
  const change = (key: keyof WecomNativePlatformConfig, v: unknown) => setDraft(d => ({ ...d, [key]: v }));
  const range = (key: 'limit' | 'sinceHours', v: string) =>
    change('summaryRange', { ...draft.summaryRange, [key]: v.trim() === '' ? undefined : Number(v) });
  async function submit() {
    setBusy(true);
    setStatus(null);
    try {
      const patch: Record<string, unknown> = {};
      for (const key of ['summaryRange', 'summaryMemory', 'summaryMemoryPath'] as const) {
        if (key in draft) patch[key] = draft[key];
      }
      await save({ native: patch });
      setStatus({ ok: true, text: tr('botDefaults.wecom.platform.saved') });
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : tr('botDefaults.wecom.platform.saveFailed') });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="bd-tile" id={id} aria-label={tr('botDefaults.wecom.platform.aria')} data-provider-only="wecom">
      <NativeGroup title={tr('botDefaults.wecom.platform.sessionsTitle')}>
        <NativeField label={tr('botDefaults.wecom.platform.summaryLimit')}>
          <input
            type="number"
            min="1"
            max="1000"
            placeholder={String(SUMMARY_DEFAULT_LIMIT)}
            value={draft.summaryRange?.limit === undefined ? '' : String(draft.summaryRange.limit)}
            onChange={e => range('limit', e.target.value)}
          />
        </NativeField>
        <NativeField label={tr('botDefaults.wecom.platform.summarySinceHours')}>
          <input
            type="number"
            min="1"
            placeholder={String(SUMMARY_DEFAULT_SINCE_HOURS)}
            value={draft.summaryRange?.sinceHours === undefined ? '' : String(draft.summaryRange.sinceHours)}
            onChange={e => range('sinceHours', e.target.value)}
          />
        </NativeField>
        <NativeToggle
          label={tr('botDefaults.wecom.platform.summaryMemory')}
          checked={draft.summaryMemory === true}
          onChange={v => change('summaryMemory', v)}
        />
        <NativeField label={tr('botDefaults.wecom.platform.summaryMemoryPath')}>
          <input
            type="text"
            placeholder={SUMMARY_DEFAULT_PATH}
            value={draft.summaryMemoryPath ?? ''}
            onChange={e => change('summaryMemoryPath', e.target.value || undefined)}
          />
        </NativeField>
        <NativeNote>{tr('botDefaults.wecom.platform.summaryNote')}</NativeNote>
        <NativeSaveActions
          action="save-wecom-platform-sessions"
          label={tr('botDefaults.wecom.platform.save')}
          savingLabel={tr('botDefaults.wecom.saving')}
          busy={busy}
          status={status}
          onSave={() => void submit()}
        />
      </NativeGroup>
    </section>
  );
}
