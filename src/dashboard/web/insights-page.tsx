import { useEffect, useRef } from 'react';
import { useT } from './react-hooks.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import {
  initialInsightTab,
  renderDetailShell,
  renderTabBar,
  TIME_WINDOWS,
  wireInsightsPage,
} from './insights.js';

function Html(props: { html: string }) {
  return <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: props.html }} />;
}

// Render-once scaffold: React owns the translated page shell and unmount
// lifecycle; wireInsightsPage owns the tab/detail/modal controller until the
// insight workbench is split into smaller reactive components.
function InsightsPage() {
  const tr = useT();
  const rootRef = useRef<HTMLElement | null>(null);
  const tab = initialInsightTab();

  useEffect(() => {
    if (!rootRef.current) return undefined;
    return wireInsightsPage(rootRef.current);
  }, []);

  return (
    <section className="page insights-page" ref={rootRef}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.insights')}</p>
          <h1>{tr('insights.title')}</h1>
          <p>{tr('insights.subtitle')}</p>
        </div>
        <div className="insight-head-acts">
          <button type="button" id="insight-palette-open" className="ins-clear">{tr('insights.paletteOpen')}</button>
          <button type="button" id="insight-refresh" className="primary">{tr('insights.refresh')}</button>
        </div>
      </div>
      <form id="insight-filters" className="filters insights-filters">
        <input type="search" name="q" placeholder={tr('insights.search')} />
        <select id="insight-project" className="ins-select" aria-label={tr('insights.projectAll')} />
        <select id="insight-time" className="ins-select" aria-label={tr('insights.timeAll')}>
          {TIME_WINDOWS.map(w => <option key={w.key} value={w.key}>{tr(w.label)}</option>)}
        </select>
        <div className="segmented" role="group" aria-label={tr('insights.filter')}>
          <button type="button" data-filter="all">{tr('insights.filterAll')}</button>
          <button type="button" data-filter="review">{tr('insights.filterReview')}</button>
          <button type="button" data-filter="failed">{tr('insights.filterFailed')}</button>
          <button type="button" data-filter="slow">{tr('insights.filterSlow')}</button>
        </div>
        <div id="insight-cli-filter" className="spanfilter cli-filter" role="group" aria-label={tr('insights.filter')} />
        <label className="ins-toggle"><input type="checkbox" id="insight-noise" /> {tr('insights.showAll')}</label>
        <button type="button" id="insight-clear" className="ins-clear">{tr('insights.clear')}</button>
      </form>
      <div id="insight-tabbar"><Html html={renderTabBar(tab)} /></div>
      <div id="insight-status" className="insight-page-status" />
      <div className="insight-panel" role="tabpanel" data-tabpanel="overview"><div id="insight-overview" /></div>
      <div className="insight-panel" role="tabpanel" data-tabpanel="sessions" hidden>
        <div id="insight-list-view">
          <div className="insight-list-head">
            <span id="insight-list-subtitle" />
            <div className="sesssort" id="insight-sort" />
          </div>
          <div id="insight-list" />
        </div>
        <div id="insight-detail-view" hidden>
          <button type="button" id="insight-back" className="ins-back">← {tr('insights.backToList')}</button>
          <div id="insight-detail"><Html html={renderDetailShell(undefined)} /></div>
        </div>
      </div>
      <div className="insight-panel" role="tabpanel" data-tabpanel="flow" hidden><div id="insight-flow" /></div>
      <div className="insight-panel" role="tabpanel" data-tabpanel="dist" hidden><div id="insight-dist" /></div>
      <div className="insight-panel" role="tabpanel" data-tabpanel="hot" hidden><div id="insight-hot" /></div>
      <div id="insight-modal" className="insight-modal" hidden />
      <div id="insight-palette" className="insight-palette" hidden />
      <div id="insight-tip" className="ins-tip" role="tooltip" hidden />
    </section>
  );
}

export function renderInsightsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <InsightsPage />);
}
