#!/usr/bin/env tsx
/**
 * Midscene 报告 dashboard：本地 http 服务，按 run 批次聚合展示 case，
 * 支持状态标记、搜索、删除。
 *
 * 数据布局（依赖 scripts/run-e2e.ts 生成）：
 *   midscene_run/runs/<run-id>/report/*.html
 *
 * 启动：
 *   pnpm report:dashboard          # :7788
 *   pnpm report:dashboard --port 8080 --host 0.0.0.0
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createReadStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// ──────────────────────────────────────────────────────── 配置 & 参数

const ROOT = resolve(process.cwd(), 'midscene_run');
const RUNS_DIR = join(ROOT, 'runs');
const CACHE_FILE = join(ROOT, '.dashboard-cache.json');

interface Args { port: number; host: string; }
function parseArgs(): Args {
  const a: Args = { port: 7788, host: '127.0.0.1' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--port') a.port = Number(argv[++i]);
    else if (k === '--host') a.host = argv[++i];
  }
  return a;
}

// ──────────────────────────────────────────────────────── Case 元数据

type Status = 'pass' | 'fail' | 'unknown';
interface CaseMeta {
  file: string;       // basename only
  size: number;
  mtime: number;      // ms
  ts: number;         // ms, from filename timestamp (falls back to mtime)
  title: string;
  status: Status;
}

/** 磁盘缓存：key = "<runId>/<file>" */
let cache: Record<string, CaseMeta & { _v: number }> = {};
const CACHE_VERSION = 1;

function loadCache(): void {
  if (!existsSync(CACHE_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (data && typeof data === 'object') cache = data;
  } catch { cache = {}; }
}
let cacheDirty = false;
let cacheFlushTimer: NodeJS.Timeout | null = null;
function scheduleCacheFlush(): void {
  if (cacheFlushTimer) return;
  cacheFlushTimer = setTimeout(() => {
    cacheFlushTimer = null;
    if (!cacheDirty) return;
    cacheDirty = false;
    try { writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch {}
  }, 500);
}

/** 从文件名提取时间戳（ms），失败返回 NaN */
function tsFromName(name: string): number {
  const m = name.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).getTime();
}

/** 从一个 midscene 报告 HTML 里提取首个 dump JSON */
function extractDumpJson(html: string): any | null {
  const re = /<script type="midscene_web_dump"[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const body = m[1].trim();
    if (!body.startsWith('{')) continue;
    try { return JSON.parse(body); } catch { /* skip */ }
  }
  return null;
}

function computeStatus(dump: any): Status {
  if (!dump?.executions || !Array.isArray(dump.executions)) return 'unknown';
  let sawTask = false;
  for (const exec of dump.executions) {
    const tasks = exec?.tasks;
    if (!Array.isArray(tasks)) continue;
    for (const t of tasks) {
      sawTask = true;
      const st = typeof t?.status === 'string' ? t.status.toLowerCase() : '';
      if (st === 'failed' || st === 'error' || st === 'cancelled') return 'fail';
    }
  }
  return sawTask ? 'pass' : 'unknown';
}

function parseMeta(absPath: string, runId: string, file: string): CaseMeta {
  const st = statSync(absPath);
  const cacheKey = `${runId}/${file}`;
  const cached = cache[cacheKey];
  if (cached && cached._v === CACHE_VERSION && cached.size === st.size && cached.mtime === st.mtimeMs) {
    const { _v, ...clean } = cached;
    return clean;
  }
  let title = file;
  let status: Status = 'unknown';
  try {
    const html = readFileSync(absPath, 'utf8');
    const dump = extractDumpJson(html);
    if (dump) {
      const firstExec = Array.isArray(dump.executions) ? dump.executions[0] : null;
      if (firstExec?.name) title = String(firstExec.name);
      else if (dump.groupName) title = String(dump.groupName);
      status = computeStatus(dump);
    }
  } catch { /* leave defaults */ }

  const ts = tsFromName(file);
  const meta: CaseMeta = {
    file,
    size: st.size,
    mtime: st.mtimeMs,
    ts: Number.isFinite(ts) ? ts : st.mtimeMs,
    title,
    status,
  };
  cache[cacheKey] = { ...meta, _v: CACHE_VERSION };
  cacheDirty = true;
  scheduleCacheFlush();
  return meta;
}

// ──────────────────────────────────────────────────────── Batch

interface BatchSummary {
  id: string;
  createdAt: number;
  caseCount: number;
  passCount: number;
  failCount: number;
  unknownCount: number;
  totalSize: number;
}

function listRuns(): string[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    // 最新在前：run-id 是 YYYY-MM-DD_HH-MM-SS，字符串降序即时间降序
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

function listCasesInRun(runId: string): CaseMeta[] {
  const reportDir = join(RUNS_DIR, runId, 'report');
  if (!existsSync(reportDir)) return [];
  const files = readdirSync(reportDir).filter((f) => f.endsWith('.html'));
  return files.map((f) => parseMeta(join(reportDir, f), runId, f));
}

function summarizeBatch(runId: string): BatchSummary {
  const cases = listCasesInRun(runId);
  let pass = 0, fail = 0, unk = 0, size = 0, createdAt = 0;
  for (const c of cases) {
    if (c.status === 'pass') pass++;
    else if (c.status === 'fail') fail++;
    else unk++;
    size += c.size;
    if (!createdAt || c.ts < createdAt) createdAt = c.ts;
  }
  if (!createdAt) {
    // 兜底：没有 case 时用 run-id 解析
    const ts = tsFromName(runId);
    createdAt = Number.isFinite(ts) ? ts : Date.now();
  }
  return {
    id: runId,
    createdAt,
    caseCount: cases.length,
    passCount: pass,
    failCount: fail,
    unknownCount: unk,
    totalSize: size,
  };
}

// ──────────────────────────────────────────────────────── HTTP

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'application/json; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, JSON.stringify(data));
}

/** run-id 校验：只允许字母数字和 `_` `-`，避免路径穿越 */
function isSafeRunId(id: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(id) && !id.includes('..');
}
function isSafeFileName(name: string): boolean {
  return /^[A-Za-z0-9_.-]+\.html$/.test(name) && !name.includes('..');
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/' && method === 'GET') {
    return send(res, 200, INDEX_HTML, 'text/html; charset=utf-8');
  }
  if (path === '/api/batches' && method === 'GET') {
    const runs = listRuns();
    const batches = runs.map(summarizeBatch).sort((a, b) => b.createdAt - a.createdAt);
    return sendJson(res, 200, { batches });
  }

  let m = path.match(/^\/api\/batches\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!isSafeRunId(id)) return sendJson(res, 400, { error: 'bad id' });
    if (!existsSync(join(RUNS_DIR, id))) return sendJson(res, 404, { error: 'not found' });
    if (method === 'GET') {
      const cases = listCasesInRun(id).sort((a, b) => b.ts - a.ts);
      return sendJson(res, 200, { id, cases });
    }
    if (method === 'DELETE') {
      rmSync(join(RUNS_DIR, id), { recursive: true, force: true });
      // 清缓存里该 run 的条目
      for (const k of Object.keys(cache)) if (k.startsWith(`${id}/`)) delete cache[k];
      cacheDirty = true; scheduleCacheFlush();
      return sendJson(res, 200, { ok: true });
    }
  }

  m = path.match(/^\/api\/reports\/([^/]+)\/([^/]+)$/);
  if (m && method === 'DELETE') {
    const id = decodeURIComponent(m[1]);
    const file = decodeURIComponent(m[2]);
    if (!isSafeRunId(id) || !isSafeFileName(file)) return sendJson(res, 400, { error: 'bad path' });
    const abs = join(RUNS_DIR, id, 'report', file);
    if (!existsSync(abs)) return sendJson(res, 404, { error: 'not found' });
    rmSync(abs, { force: true });
    delete cache[`${id}/${file}`];
    cacheDirty = true; scheduleCacheFlush();
    return sendJson(res, 200, { ok: true });
  }

  m = path.match(/^\/report\/([^/]+)\/([^/]+)$/);
  if (m && method === 'GET') {
    const id = decodeURIComponent(m[1]);
    const file = decodeURIComponent(m[2]);
    if (!isSafeRunId(id) || !isSafeFileName(file)) return send(res, 400, 'bad path', 'text/plain');
    const abs = join(RUNS_DIR, id, 'report', file);
    if (!existsSync(abs)) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    createReadStream(abs).pipe(res);
    return;
  }

  // 附带挂接 run 目录里的 screenshots / 其他 asset（html-and-external-assets 模式需要）
  m = path.match(/^\/report\/([^/]+)\/(.+)$/);
  if (m && method === 'GET') {
    const id = decodeURIComponent(m[1]);
    const rest = decodeURIComponent(m[2]);
    if (!isSafeRunId(id) || rest.includes('..')) return send(res, 400, 'bad path', 'text/plain');
    const abs = join(RUNS_DIR, id, 'report', rest);
    if (!existsSync(abs) || !statSync(abs).isFile()) return send(res, 404, 'not found', 'text/plain');
    const ext = rest.split('.').pop()?.toLowerCase();
    const type =
      ext === 'png' ? 'image/png' :
      ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
      ext === 'js' ? 'application/javascript' :
      ext === 'css' ? 'text/css' :
      'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    createReadStream(abs).pipe(res);
    return;
  }

  send(res, 404, 'not found', 'text/plain');
}

// ──────────────────────────────────────────────────────── 前端 HTML

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Midscene Reports</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; color: #222; background: #f5f6f8; }
  header { padding: 12px 16px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; gap: 12px; }
  header h1 { margin: 0; font-size: 16px; font-weight: 600; }
  header .muted { color: #6b7280; font-size: 12px; }
  main { display: flex; height: calc(100vh - 49px); }
  aside { width: 280px; flex: none; overflow-y: auto; background: #fff; border-right: 1px solid #e5e7eb; }
  .batch { padding: 10px 14px; border-bottom: 1px solid #f1f2f4; cursor: pointer; }
  .batch:hover { background: #f8fafc; }
  .batch.active { background: #eef4ff; border-left: 3px solid #3b82f6; padding-left: 11px; }
  .batch .title { font-weight: 500; font-size: 13px; color: #111827; }
  .batch .stats { margin-top: 4px; font-size: 12px; color: #6b7280; display: flex; gap: 8px; align-items: center; }
  .batch .del { margin-left: auto; color: #9ca3af; font-size: 12px; display: none; border: none; background: transparent; cursor: pointer; }
  .batch:hover .del { display: inline; }
  .batch .del:hover { color: #ef4444; }
  section { flex: 1; overflow-y: auto; padding: 16px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
  .toolbar input { flex: 1; padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; }
  .toolbar select { padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; background: #fff; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #f1f2f4; font-size: 13px; }
  th { background: #f9fafb; color: #6b7280; font-weight: 500; font-size: 12px; }
  tr:last-child td { border-bottom: none; }
  tr:hover { background: #fafbfc; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .dot.pass { background: #22c55e; }
  .dot.fail { background: #ef4444; }
  .dot.unknown { background: #d1d5db; }
  .pill { display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 10px; font-size: 11px; background: #f3f4f6; color: #374151; }
  .pill.pass { background: #dcfce7; color: #166534; }
  .pill.fail { background: #fee2e2; color: #991b1b; }
  td a { color: #2563eb; text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .num { color: #6b7280; font-variant-numeric: tabular-nums; }
  .empty { color: #6b7280; padding: 40px; text-align: center; }
  button.row-del { border: none; background: transparent; color: #9ca3af; cursor: pointer; font-size: 12px; }
  button.row-del:hover { color: #ef4444; }
</style>
</head>
<body>
<header>
  <h1>Midscene Reports</h1>
  <span class="muted" id="hint">加载中…</span>
  <span style="flex:1"></span>
  <button id="refresh" style="padding:4px 10px;border:1px solid #d1d5db;background:#fff;border-radius:6px;cursor:pointer;font-size:12px;">刷新</button>
</header>
<main>
  <aside id="batches"></aside>
  <section>
    <div class="toolbar">
      <input id="search" placeholder="过滤当前批次的标题…">
      <select id="sort">
        <option value="ts-desc">时间 ↓</option>
        <option value="ts-asc">时间 ↑</option>
        <option value="size-desc">大小 ↓</option>
        <option value="size-asc">大小 ↑</option>
        <option value="status">状态</option>
      </select>
    </div>
    <div id="cases"></div>
  </section>
</main>
<script>
const fmtSize = (n) => {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
};
const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
const fmtTimeShort = (ts) => {
  const d = new Date(ts), pad = (n) => String(n).padStart(2, '0');
  return \`\${d.getFullYear()}-\${pad(d.getMonth()+1)}-\${pad(d.getDate())} \${pad(d.getHours())}:\${pad(d.getMinutes())}:\${pad(d.getSeconds())}\`;
};

let state = { batches: [], activeId: null, cases: [], filter: '', sort: 'ts-desc' };

async function loadBatches() {
  const res = await fetch('/api/batches');
  const data = await res.json();
  state.batches = data.batches;
  if (!state.batches.length) {
    document.getElementById('hint').textContent = '0 个批次';
    document.getElementById('batches').innerHTML = '<div class="empty">还没有测试报告。<br>运行 <code>pnpm test:e2e-browser</code> 生成。</div>';
    document.getElementById('cases').innerHTML = '';
    return;
  }
  document.getElementById('hint').textContent = state.batches.length + ' 个批次';
  // 默认选最新
  if (!state.activeId || !state.batches.find(b => b.id === state.activeId)) {
    state.activeId = state.batches[0].id;
  }
  renderBatches();
  loadCases(state.activeId);
}

function renderBatches() {
  const root = document.getElementById('batches');
  root.innerHTML = state.batches.map(b => {
    const active = b.id === state.activeId ? 'active' : '';
    const parts = [];
    if (b.passCount) parts.push(\`<span class="pill pass">✓ \${b.passCount}</span>\`);
    if (b.failCount) parts.push(\`<span class="pill fail">✗ \${b.failCount}</span>\`);
    if (b.unknownCount) parts.push(\`<span class="pill">? \${b.unknownCount}</span>\`);
    return \`
      <div class="batch \${active}" data-id="\${b.id}">
        <div class="title">\${fmtTimeShort(b.createdAt)}</div>
        <div class="stats">
          \${parts.join(' ')}
          <span class="num">\${fmtSize(b.totalSize)}</span>
          <button class="del" data-del="\${b.id}" title="删除整批">🗑</button>
        </div>
      </div>\`;
  }).join('');
  root.querySelectorAll('.batch').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.dataset.del) return;
      state.activeId = el.dataset.id;
      renderBatches();
      loadCases(state.activeId);
    });
  });
  root.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.del;
      if (!confirm('删除批次 ' + id + ' ？此操作不可恢复')) return;
      await fetch('/api/batches/' + encodeURIComponent(id), { method: 'DELETE' });
      if (state.activeId === id) state.activeId = null;
      loadBatches();
    });
  });
}

async function loadCases(id) {
  document.getElementById('cases').innerHTML = '<div class="empty">加载中…</div>';
  const res = await fetch('/api/batches/' + encodeURIComponent(id));
  if (!res.ok) {
    document.getElementById('cases').innerHTML = '<div class="empty">加载失败</div>';
    return;
  }
  const data = await res.json();
  state.cases = data.cases;
  renderCases();
}

function renderCases() {
  let cases = state.cases.slice();
  if (state.filter) {
    const q = state.filter.toLowerCase();
    cases = cases.filter(c => c.title.toLowerCase().includes(q) || c.file.toLowerCase().includes(q));
  }
  const [key, dir] = state.sort.split('-');
  cases.sort((a, b) => {
    if (key === 'status') {
      const rank = { fail: 0, unknown: 1, pass: 2 };
      return rank[a.status] - rank[b.status];
    }
    const cmp = key === 'size' ? a.size - b.size : a.ts - b.ts;
    return dir === 'asc' ? cmp : -cmp;
  });
  const root = document.getElementById('cases');
  if (!cases.length) {
    root.innerHTML = '<div class="empty">这批没有匹配的 case</div>';
    return;
  }
  root.innerHTML = \`
    <table>
      <thead><tr><th style="width:60px">状态</th><th style="width:160px">时间</th><th style="width:90px">大小</th><th>标题</th><th style="width:40px"></th></tr></thead>
      <tbody>
        \${cases.map(c => \`
          <tr>
            <td><span class="dot \${c.status}"></span>\${c.status}</td>
            <td class="num">\${fmtTime(c.ts)}</td>
            <td class="num">\${fmtSize(c.size)}</td>
            <td><a href="/report/\${encodeURIComponent(state.activeId)}/\${encodeURIComponent(c.file)}" target="_blank" title="\${c.file}">\${escapeHtml(c.title)}</a></td>
            <td><button class="row-del" data-file="\${c.file}" title="删除">✕</button></td>
          </tr>\`).join('')}
      </tbody>
    </table>\`;
  root.querySelectorAll('.row-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const file = btn.dataset.file;
      if (!confirm('删除报告 ' + file + ' ？')) return;
      await fetch('/api/reports/' + encodeURIComponent(state.activeId) + '/' + encodeURIComponent(file), { method: 'DELETE' });
      loadCases(state.activeId);
      loadBatches();
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.getElementById('search').addEventListener('input', (e) => { state.filter = e.target.value; renderCases(); });
document.getElementById('sort').addEventListener('change', (e) => { state.sort = e.target.value; renderCases(); });
document.getElementById('refresh').addEventListener('click', () => loadBatches());

loadBatches();
</script>
</body>
</html>`;

// ──────────────────────────────────────────────────────── 启动

function main(): void {
  if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true });
  loadCache();
  const { port, host } = parseArgs();
  const server = createServer(handle);
  server.listen(port, host, () => {
    const url = `http://${host}:${port}/`;
    console.log(`[report-dashboard] listening on ${url}`);
    console.log(`[report-dashboard] report root: ${RUNS_DIR}`);
  });
}

main();
