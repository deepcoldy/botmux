import type React from 'react';
import { t } from './ui.js';

function sandboxModeName(mode: unknown): string {
  if (mode === 'oncall') return t('botDefaults.sandboxModeOncall');
  if (mode === 'scratch') return t('botDefaults.sandboxModeScratch');
  return t('botDefaults.sandboxModeOff');
}

/** 会话冻结的沙盒模式与 bot 当前配置不一致时标一下（改配置只影响新会话）。
 *  会话表格行与看板卡共用，故放在不依赖页面/看板组件的叶子模块。 */
export function SandboxDriftChip(props: { row: any }): React.JSX.Element | null {
  const drift = props.row.sandboxDrift;
  if (!drift) return null;
  const text = t('sessions.sandboxDrift', { session: sandboxModeName(drift.session), current: sandboxModeName(drift.current) });
  return <span className="session-lock-badge" data-sandbox-drift="" title={text} aria-label={text}>{t('sessions.sandboxDriftShort')}</span>;
}
