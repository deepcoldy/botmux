import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Header } from './components/Header.js';
import { bootstrap, store } from './store.js';
import { LangProvider } from './i18n.js';
import { SessionsPage } from './pages/Sessions.js';
import { SchedulesPage } from './pages/Schedules.js';
import { GroupsPage } from './pages/Groups.js';
import { BotDefaultsPage } from './pages/BotDefaults.js';

function App() {
  const [hash, setHash] = useState<string>(() => location.hash || '#/');

  useEffect(() => {
    const onHash = () => setHash(location.hash || '#/');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  let page;
  if (hash.startsWith('#/schedules')) page = <SchedulesPage />;
  else if (hash.startsWith('#/groups')) page = <GroupsPage />;
  else if (hash.startsWith('#/bot-defaults')) page = <BotDefaultsPage />;
  else page = <SessionsPage />;

  return (
    <LangProvider>
      <div className="min-h-screen bg-slate-50">
        <Header active={hash} />
        <main className="max-w-7xl mx-auto px-6 py-6">{page}</main>
      </div>
    </LangProvider>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');
const root = createRoot(rootEl);
root.render(<App />);

void (async () => {
  try {
    await bootstrap();
  } catch (err) {
    console.error('botmux dashboard bootstrap failed', err);
    store.setOnline(false);
  }
})();
