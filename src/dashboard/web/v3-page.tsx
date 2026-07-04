import { useEffect, useRef } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { v3RunIdFromHash, wireV3RunsPage } from './v3.js';

function V3ListShell() {
  return (
    <>
      <div className="page-head">
        <h1>工作流</h1>
        <p className="muted">LLM 编排的 workflow 运行 — DAG 图 + 每节点终端</p>
      </div>
      <table className="data-table">
        <thead><tr><th>Run</th><th>状态</th><th>节点数</th></tr></thead>
        <tbody id="v3-tbody" />
      </table>
      <div id="v3-empty" className="muted" hidden style={{ padding: '1rem' }}>
        暂无工作流运行（用 <code>/workflow new</code> 发起一个）
      </div>
    </>
  );
}

function V3DetailShell(props: { runId: string }) {
  return (
    <>
      <div className="page-head">
        <a href="#/workflows" className="btn-link">← 工作流</a>
        <h1 className="v3r-title">{props.runId}</h1>
        <span id="v3-runstatus" className="v3r-pill" />
      </div>
      <div className="v3r-wrap">
        <div className="v3r-graph-card">
          <div id="v3-graph" className="v3r-graph" />
          <div className="v3r-legend">
            <span className="lg st-pending">待机</span>
            <span className="lg st-running">运行中</span>
            <span className="lg st-gateWaiting">等审批</span>
            <span className="lg st-done">完成</span>
            <span className="lg st-skipped">已跳过</span>
            <span className="lg st-cancelled">已取消</span>
            <span className="lg st-blocked">受阻</span>
            <span className="lg st-failed">失败</span>
            <span className="lg lg-loop">⟳ 循环容器</span>
          </div>
        </div>
        <div id="v3-node-panel" className="v3r-panel">
          <p className="muted">点一个节点看详情与终端</p>
        </div>
      </div>
    </>
  );
}

// Render-once scaffold: React owns the route shell and unmount lifecycle, while
// v3.ts owns the poll loop, SVG graph, loop timeline, and terminal slot so live
// terminal iframes keep their existing no-remount behavior across poll ticks.
function V3RunsPage() {
  const rootRef = useRef<HTMLElement | null>(null);
  const runId = v3RunIdFromHash();

  useEffect(() => {
    if (!rootRef.current) return undefined;
    return wireV3RunsPage(rootRef.current);
  }, []);

  return (
    <section className="page" ref={rootRef}>
      {runId ? <V3DetailShell runId={runId} /> : <V3ListShell />}
    </section>
  );
}

export function renderV3RunsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <V3RunsPage />);
}
