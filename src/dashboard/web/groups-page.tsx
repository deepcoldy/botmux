import { useEffect, useRef } from 'react';
import { loadingHtml } from './ui.js';
import { useT } from './react-hooks.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { wireGroupsPage } from './groups.js';

function Html(props: { html: string }) {
  return <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: props.html }} />;
}

// Render-once scaffold: React owns the translated route shell, while
// wireGroupsPage owns the matrix and dialog flows until those controllers are
// split into reactive components. Keep ui-change rerenders as full remounts.
function GroupsPage() {
  const tr = useT();
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!rootRef.current) return undefined;
    return wireGroupsPage(rootRef.current);
  }, []);

  return (
    <section className="page" ref={rootRef}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.groups')}</p>
          <h1>{tr('groups.title')}</h1>
          <p>{tr('groups.subtitle')}</p>
        </div>
      </div>
      <form id="g-filters" className="filters">
        <input type="search" name="q" placeholder={tr('groups.search')} />
        <label><input type="checkbox" name="missing" /> {tr('groups.missingOnly')}</label>
        <button type="button" id="g-refresh">{tr('groups.refresh')}</button>
        <button type="button" id="g-create" className="primary">{tr('groups.create')}</button>
      </form>
      <div id="g-loading"><Html html={loadingHtml()} /></div>
      <div className="table-scroll matrix-scroll" id="g-table-wrap" hidden>
        <table>
          <thead id="g-head" />
          <tbody id="g-body" />
        </table>
      </div>
      <dialog id="g-drawer" />
    </section>
  );
}

export function renderGroupsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <GroupsPage />);
}
