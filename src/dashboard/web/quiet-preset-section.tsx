import { useEffect, useState } from 'react';
import { toast } from './toast.js';

type Tr = (key: string, values?: Record<string, string | number>) => string;
type JsonResponse = { ok: boolean; status: number; body: any };

/**
 * 「静默模式」一键预设：思考卡关 + 静默表情回应开 + 流式卡关。
 *
 * 这是一次性写入的便捷开关，不与三个独立开关的状态绑定：
 * - 打开 = 恰好一次 PUT，body 恰好三个键；
 * - 关闭 = 不产生任何写请求，三个开关保持原值；
 * - 用户随后单独拨动任一项导致派生条件不成立时，预设标记自动熄灭。
 */
export function QuietPresetSection(props: {
  tr: Tr;
  thinkingCard: boolean;
  silentReactions: boolean;
  disableStreaming: boolean;
  putCardPref(patch: {
    thinkingCard: boolean;
    silentTurnReactions: boolean;
    disableStreamingCard: boolean;
  }): Promise<JsonResponse>;
  onApplied(): void;
}) {
  const { tr } = props;
  const derived = props.thinkingCard === false
    && props.silentReactions === true
    && props.disableStreaming === true;
  const [on, setOn] = useState(derived);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!derived) setOn(false);
  }, [derived]);

  async function toggle(next: boolean): Promise<void> {
    if (busy || next === on) return;
    if (!next) {
      // 关闭只灭预设标记：不动开关，不发请求。
      setOn(false);
      return;
    }
    setBusy(true);
    setOn(true);
    try {
      const res = await props.putCardPref({
        thinkingCard: false,
        silentTurnReactions: true,
        disableStreamingCard: true,
      });
      if (res.ok) {
        props.onApplied();
        toast(tr('quietPreset.onToast'), { kind: 'success' });
      } else {
        setOn(false);
        toast(`${res.body?.error ?? res.status}`, { kind: 'error' });
      }
    } catch (err) {
      setOn(false);
      toast(`Network error: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bd-card-setting-group" data-quiet-preset>
      <h4 className="bd-card-setting-heading">{tr('quietPreset.title')}</h4>
      <p><small>{tr('quietPreset.description')}</small></p>
      <label className="toggle-row">
        <input
          type="checkbox"
          data-action="quiet-preset-switch"
          checked={on}
          disabled={busy}
          onChange={ev => void toggle(ev.currentTarget.checked)}
        />
        <span className="switch" aria-hidden="true" />
        <span className="toggle-tx">
          <strong>{tr('quietPreset.switch')}</strong>
        </span>
      </label>
      {on ? (
        <details data-quiet-preset-details>
          <summary>{tr('quietPreset.detailsSummary')}</summary>
          <ul>
            <li>{tr('quietPreset.thinkingOff')}</li>
            <li>{tr('quietPreset.silentOn')}</li>
            <li>{tr('quietPreset.streamingOff')}</li>
          </ul>
        </details>
      ) : (
        <p data-quiet-preset-off-note><small>{tr('quietPreset.offNote')}</small></p>
      )}
    </section>
  );
}
