import { useEffect, useState } from 'react';
import { ui } from './ui.js';
import { store } from './store.js';
import { modelPinText, modelPinClearErrorText } from '../../core/model-pin.js';
import { toast } from './toast.js';

export function ModelPinChip({ row }: { row: Record<string, any> }) {
  const pin = row.modelPin;
  if (!pin) return null;
  return <span className="model-pin-chip" data-model-pin="" onClick={e => e.stopPropagation()}>
    <span title={pin.inactiveReason || pin.shadowNote || pin.effortDowngradeNote || pin.pendingEffortNote || `固定来源：${pin.source}`}>{modelPinText(pin)}</span>
    {ui.authed ? <button type="button" onClick={async () => {
      const res = await fetch(`/api/sessions/${encodeURIComponent(row.sessionId)}/model-pin`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok || !body.ok) { toast(modelPinClearErrorText(body)); return; }
      store.applySse('session.update', { sessionId: row.sessionId, patch: { modelPin: null } });
      toast('已解除固定，下次启动 CLI 生效；可空闲后重启 CLI。');
    }}>解除固定</button> : null}
  </span>;
}

export function BotModelPinSummary({ appId, model }: { appId: string; model?: string }) {
  const [stats, setStats] = useState<{ total: number; protected: number } | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let current = true;
    let sequence = 0;
    const signature = () => JSON.stringify([...store.sessions.values()]
      .filter(row => row.larkAppId === appId).map(row => [row.sessionId, row.status, row.modelPin]));
    let previous = signature();
    const refresh = () => {
      const requested = ++sequence;
      void fetch(`/api/bots/${encodeURIComponent(appId)}/model-pins`).then(async r => {
        const body = await r.json(); if (current && requested === sequence && r.ok && body.ok) setStats(body);
      }).catch(() => { if (current && requested === sequence) setStats(null); });
    };
    refresh();
    const off = store.on(() => {
      const next = signature();
      if (next !== previous) { previous = next; refresh(); }
    });
    return () => { current = false; off(); };
  }, [appId, model]);
  if (!stats || stats.total === 0) return message ? <p role="status">{message}</p> : null;
  return <div className="model-pin-summary" data-model-pin-summary="">
    <p>{stats.protected} 个活跃会话有话题固定，不受 bot 默认模型修改影响（含已关闭共 {stats.total} 个固定）。</p>
    {ui.authed ? <button type="button" onClick={async () => {
      const res = await fetch(`/api/bots/${encodeURIComponent(appId)}/model-pins`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok || !body.ok) { setMessage(modelPinClearErrorText(body)); return; }
      for (const sessionId of body.cleared) store.applySse('session.update', { sessionId, patch: { modelPin: null } });
      setStats({ total: 0, protected: 0 }); setMessage('已清除本 bot 全部话题固定，下次启动 CLI 生效。');
    }}>清除本 bot 全部话题固定</button> : null}
    <span role="status">{message}</span>
  </div>;
}
