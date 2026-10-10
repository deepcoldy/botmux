import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AutoStartControls } from '../../../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../../../src/dashboard/web/bot-defaults.js';

function Fixture() {
  const [bot, setBot] = useState<BotDefaultsRow>();
  useEffect(() => { void fetch('/api/bot-default-oncall').then(r => r.json()).then(body => setBot({ ...body, larkAppId: 'app_visual_test' })); }, []);
  return <main className="bot-defaults-page" style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
    <h2>Bot 设置 · UI 验收</h2>
    <p>独立测试配置 · 真实主动开工组件与配置接口</p>
    <div className="bd-body"><section className="bd-section">
      {bot && <AutoStartControls bot={bot} putCardPref={async patch => {
        const res = await fetch('/api/bot-card-prefs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
        const body = await res.json();
        if (res.ok) setBot(current => ({ ...current!, ...body }));
        return { ok: res.ok, status: res.status, body };
      }} />}
    </section></div>
  </main>;
}
createRoot(document.getElementById('app-root')!).render(<Fixture />);
