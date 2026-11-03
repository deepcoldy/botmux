import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HerdrConfigSection } from '../../../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../../../src/dashboard/web/bot-defaults.js';

const initial: BotDefaultsRow = {
  larkAppId: 'cli_synthetic_demo',
  botName: '示例机器人',
  cliId: 'claude-code',
  backendType: 'herdr',
  herdr: { sessionName: 'default', placement: 'split', tab: '3 评审', splitDirection: 'right', chatTypes: ['group'] },
};

function Fixture() {
  const [bot, setBot] = useState<BotDefaultsRow>(initial);
  return (
    <main className="bot-defaults-page" style={{ padding: 16, maxWidth: 720, margin: '0 auto' }}>
      <article className="bd-card bd-profile" data-appid={bot.larkAppId}>
        <div className="bd-body bd-tab-panels">
          <div className="bd-tab-panel">
            <div className="bd-tab-grid">
              <section className="bd-tile">
                <HerdrConfigSection
                  bot={bot}
                  patchBot={(_appId, patch) => setBot(current => ({
                    ...current,
                    ...(typeof patch === 'function' ? patch(current) : patch),
                  }))}
                />
              </section>
            </div>
          </div>
        </div>
      </article>
    </main>
  );
}

createRoot(document.getElementById('app-root')!).render(<Fixture />);
