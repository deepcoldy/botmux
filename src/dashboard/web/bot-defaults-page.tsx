import { useEffect, useRef } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';
import { wireBotDefaultsPage } from './bot-defaults.js';

// Render-once scaffold: React owns the route shell, while wireBotDefaultsPage
// owns the roster/detail subtree with delegated events and targeted DOM
// updates. Keep this component free of useState/useStoreSelector until those
// controller sections are migrated to React components.
function BotDefaultsPage() {
  const tr = useT();
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!rootRef.current) return undefined;
    return wireBotDefaultsPage(rootRef.current);
  }, []);

  return (
    <section className="page" ref={rootRef}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.botDefaults')}</p>
          <h1>{tr('botDefaults.title')}</h1>
          <p>{tr('botDefaults.subtitle')}</p>
        </div>
      </div>
      <form id="bd-filters" className="filters sessions-filters">
        <input type="search" name="q" placeholder={tr('botDefaults.search')} />
        <button type="button" id="bd-refresh">{tr('botDefaults.refresh')}</button>
      </form>
      <div className="bd-layout">
        <aside id="bd-roster" className="bd-roster" />
        <div id="bd-list" className="bd-detail" />
      </div>
    </section>
  );
}

export function renderBotDefaultsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <BotDefaultsPage />);
}
