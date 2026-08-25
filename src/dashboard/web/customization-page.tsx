import { useEffect, useState, useCallback } from 'react';
import { LoadingState } from './dashboard-components.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { confirm } from './confirm-modal.js';

// ─── Types (mirror src/dashboard/customization-api.ts payloads) ──────────────

type FragmentKind = 'editable' | 'placeholder' | 'conditional';
interface FragmentLocaleState { factory: string; override: string | null }
interface Fragment {
  key: string;
  block: string;
  label: string;
  kind: FragmentKind;
  placeholders?: string[];
  gate?: string;
  locales: Record<string, FragmentLocaleState>;
  conditionForced?: boolean | null;
}
interface SkillRow {
  name: string;
  description: string;
  factory: string;
  override: string | null;
  disabled: boolean;
}
interface Snapshot {
  id: string;
  at: string;
  label: string;
  summary: { promptKeys: number; skills: number; enabled: boolean };
}
interface CustomizationSnapshotPayload {
  enabled: boolean;
  fragments: Fragment[];
  skills: SkillRow[];
  history: Snapshot[];
}

const BLOCK_LABELS: Record<string, string> = {
  botmux_routing: '<botmux_routing> 路由说明',
  identity: '<identity> 身份规则',
  shell_hints: 'Shell 提示（codex/gemini 等）',
  available_bots: '<available_bots> 协作 bot',
  attachments: '<attachments> 附件',
  followup: '跟进轮提醒',
};

function rel(ts: string): string {
  const t = Date.parse(ts);
  if (!t) return ts || '-';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s 前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m 前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h 前`;
  return `${Math.floor(h / 24)}d 前`;
}

async function apiJson(url: string, init?: RequestInit): Promise<any> {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${r.status}`);
  return body;
}

// ─── Fragment editor ─────────────────────────────────────────────────────────

function FragmentRow(props: {
  frag: Fragment;
  locale: string;
  onSaved: (snap: CustomizationSnapshotPayload) => void;
  onError: (msg: string) => void;
}) {
  const { frag, locale } = props;
  const ls = frag.locales[locale] ?? { factory: '', override: null };
  const modified = ls.override !== null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(ls.override ?? ls.factory);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setDraft(ls.override ?? ls.factory); setEditing(false); }, [ls.override, ls.factory, locale]);

  const save = async (value: string | null) => {
    setBusy(true);
    try {
      const res = await apiJson('/api/customization/prompt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale, key: frag.key, value }),
      });
      props.onSaved(res.snapshot);
      setEditing(false);
    } catch (e: any) {
      props.onError(e?.message ?? '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const toggleCond = async (value: boolean | null) => {
    setBusy(true);
    try {
      const res = await apiJson('/api/customization/condition', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: frag.key, value }),
      });
      props.onSaved(res.snapshot);
    } catch (e: any) { props.onError(e?.message ?? '保存失败'); }
    finally { setBusy(false); }
  };

  return (
    <div className={`cz-frag cz-frag-${frag.kind}${modified ? ' cz-mod' : ''}`}>
      <div className="cz-frag-bar" />
      <div className="cz-frag-inner">
        <div className="cz-frag-top">
          <span className="cz-frag-label">{frag.label}</span>
          <code className="cz-frag-key">{frag.key}</code>
          <span className="cz-frag-badges">
            {modified ? <span className="cz-chip cz-chip-mod">已修改</span> : null}
            {frag.kind === 'placeholder' ? <span className="cz-chip cz-chip-ph">占位符 {(frag.placeholders ?? []).map(p => `{${p}}`).join(' ')}</span> : null}
            {frag.kind === 'conditional' ? (
              <span className="cz-chip cz-chip-cond">
                条件行
                <select
                  className="cz-cond-select"
                  disabled={busy}
                  value={frag.conditionForced === null || frag.conditionForced === undefined ? 'default' : frag.conditionForced ? 'on' : 'off'}
                  onChange={e => {
                    const v = e.target.value;
                    void toggleCond(v === 'default' ? null : v === 'on');
                  }}
                >
                  <option value="default">跟随默认</option>
                  <option value="on">强制显示</option>
                  <option value="off">强制隐藏</option>
                </select>
              </span>
            ) : null}
            {modified ? <button className="cz-link cz-link-reset" disabled={busy} onClick={() => void save(null)}>恢复出厂</button> : null}
          </span>
        </div>
        {editing ? (
          <div className="cz-edit">
            <textarea className="cz-textarea" value={draft} rows={Math.max(2, Math.ceil(draft.length / 52))} onChange={e => setDraft(e.target.value)} autoFocus />
            <div className="cz-edit-actions">
              <button className="cz-btn cz-btn-primary" disabled={busy} onClick={() => void save(draft)}>保存</button>
              <button className="cz-btn cz-btn-ghost" disabled={busy} onClick={() => { setDraft(ls.override ?? ls.factory); setEditing(false); }}>取消</button>
              {frag.kind === 'placeholder' ? <span className="cz-hint">保留 {(frag.placeholders ?? []).map(p => `{${p}}`).join('、')} 才能保存</span> : null}
            </div>
          </div>
        ) : (
          <div className="cz-frag-text" onClick={() => setEditing(true)} title="点击编辑">
            {ls.override ?? ls.factory}
            <span className="cz-edit-hint">✎</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Skill editor ──────────────────────────────────────────────────────────

function SkillRowView(props: {
  skill: SkillRow;
  onSaved: (snap: CustomizationSnapshotPayload) => void;
  onError: (msg: string) => void;
}) {
  const { skill } = props;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(skill.override ?? skill.factory);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(skill.override ?? skill.factory); }, [skill.override, skill.factory]);

  const put = async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await apiJson('/api/customization/skill', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skill.name, ...payload }),
      });
      props.onSaved(res.snapshot);
    } catch (e: any) { props.onError(e?.message ?? '保存失败'); }
    finally { setBusy(false); }
  };

  return (
    <div className={`cz-skill${skill.disabled ? ' cz-skill-off' : ''}`}>
      <div className="cz-skill-head" onClick={() => setOpen(o => !o)}>
        <span className={`cz-caret${open ? ' cz-caret-open' : ''}`}>▶</span>
        <code className="cz-skill-name">{skill.name}</code>
        <span className="cz-skill-desc">{skill.description}</span>
        <span className="cz-skill-badges">
          {skill.disabled ? <span className="cz-chip cz-chip-off">已停用</span>
            : skill.override !== null ? <span className="cz-chip cz-chip-mod">正文已改</span>
              : <span className="cz-chip cz-chip-factory">出厂默认</span>}
          {skill.override !== null ? <button className="cz-link cz-link-reset" disabled={busy} onClick={e => { e.stopPropagation(); void put({ body: null }); }}>恢复正文</button> : null}
          <button className={`cz-link${skill.disabled ? '' : ' cz-link-danger'}`} disabled={busy} onClick={e => { e.stopPropagation(); void put({ disabled: !skill.disabled }); }}>
            {skill.disabled ? '启用' : '停用'}
          </button>
        </span>
      </div>
      {open ? (
        <div className="cz-skill-body">
          <textarea className="cz-textarea cz-skill-textarea" value={draft} onChange={e => setDraft(e.target.value)} disabled={skill.disabled} rows={12} />
          <div className="cz-edit-actions">
            <button className="cz-btn cz-btn-primary" disabled={busy || skill.disabled} onClick={() => void put({ body: draft })}>保存正文覆盖</button>
            <span className="cz-hint">留空并保存 = 用出厂默认；完整 SKILL.md（frontmatter + 正文）</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Import modal ────────────────────────────────────────────────────────────

function ImportModal(props: { onClose: () => void; onApplied: (snap: CustomizationSnapshotPayload) => void; onError: (m: string) => void }) {
  const [json, setJson] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const doPreview = async (apply: boolean) => {
    setBusy(true);
    try {
      const res = await apiJson('/api/customization/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json, apply }),
      });
      if (apply && res.applied) { props.onApplied(res.snapshot); props.onClose(); return; }
      setPreview(res.preview);
    } catch (e: any) { props.onError(e?.message ?? '导入失败'); }
    finally { setBusy(false); }
  };

  const onFile = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => { setJson(String(reader.result ?? '')); setPreview(null); };
    reader.readAsText(f);
  };

  return (
    <div className="cz-mask" onClick={e => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="cz-modal">
        <header><h3>导入 bundle</h3><button className="cz-x" onClick={props.onClose}>×</button></header>
        <div className="cz-modal-body">
          <label
            className="cz-drop"
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
          >
            拖入 .json 文件，或点此选择
            <input type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
          </label>
          <textarea className="cz-textarea" placeholder="或直接粘贴 bundle JSON…" value={json} rows={6} onChange={e => { setJson(e.target.value); setPreview(null); }} />
          {preview ? (
            <div className="cz-diff">
              <div className="cz-diff-sum">新增 {preview.summary.adds} · 替换 {preview.summary.replaces} · 停用 {preview.summary.disables} · 无变化 {preview.summary.unchanged}</div>
              {preview.diff.map((d: any, i: number) => (
                <div key={i} className={`cz-diff-row cz-diff-${d.action}`}>
                  <span className="cz-diff-mark">{d.action === 'add' ? '＋' : d.action === 'replace' ? '↻' : d.action === 'disable' ? '⊘' : '＝'}</span>
                  <span className="cz-diff-id">{d.kind}:{d.id}{d.locale ? ` (${d.locale})` : ''}</span>
                  {d.after ? <span className="cz-diff-after">{d.after}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <footer>
          <button className="cz-btn cz-btn-ghost" onClick={props.onClose}>取消</button>
          {preview
            ? <button className="cz-btn cz-btn-primary" disabled={busy} onClick={() => void doPreview(true)}>确认导入（先存快照）</button>
            : <button className="cz-btn cz-btn-primary" disabled={busy || !json.trim()} onClick={() => void doPreview(false)}>预览差异</button>}
        </footer>
      </div>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────

function CustomizationPage() {
  const [data, setData] = useState<CustomizationSnapshotPayload | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [locale, setLocale] = useState<string>('zh');
  const [showImport, setShowImport] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const flash = useCallback((m: string) => { setToast(m); window.setTimeout(() => setToast(null), 2400); }, []);
  const onError = useCallback((m: string) => flash(`⚠ ${m}`), [flash]);
  const onSaved = useCallback((snap: CustomizationSnapshotPayload) => { setData(snap); flash('已保存 · 下个会话即生效'); }, [flash]);

  const load = useCallback(async () => {
    try { setData(await apiJson('/api/customization')); }
    catch (e: any) { setLoadErr(e?.message ?? '加载失败'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const post = async (path: string, body?: unknown) => {
    try {
      const res = await apiJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (res.snapshot) setData(res.snapshot);
      return res;
    } catch (e: any) { onError(e?.message ?? '操作失败'); }
  };

  const setEnabled = async (enabled: boolean) => {
    try {
      const res = await apiJson('/api/customization/enabled', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
      setData(res.snapshot);
      flash(enabled ? '自定义已启用' : '自定义已停用（覆盖保留）');
    } catch (e: any) { onError(e?.message ?? '操作失败'); }
  };

  if (loadErr) return <div className="cz-page"><div className="cz-error">加载失败：{loadErr}</div></div>;
  if (!data) return <LoadingState label="加载自定义配置…" />;

  const blocks = Array.from(new Set(data.fragments.map(f => f.block)));
  const promptModified = data.fragments.filter(f => f.locales[locale]?.override !== null).length;
  const skillsModified = data.skills.filter(s => s.override !== null || s.disabled).length;

  return (
    <section className="cz-page">
      <style>{PAGE_CSS}</style>

      <div className="cz-head">
        <div>
          <h1>自定义中心</h1>
          <p>调优 botmux 内置的框架 prompt 与内置 skill。所有改动<b>下一个会话即生效，无需重启 daemon</b>；随时可逐项恢复出厂或整体回滚。</p>
        </div>
      </div>

      {/* master switch */}
      <div className="cz-master">
        <div className="cz-master-txt">
          <b>启用自定义</b>
          <span>关闭后所有覆盖立即停用、但不删除——排查「是不是我改的 prompt 导致的」时一键回到出厂行为。</span>
        </div>
      {/* Reuse the dashboard's proven .toggle-row/.switch (label + hidden
          checkbox + span) instead of a bare <button>: the global `button` rule
          forces min-height:32px + horizontal padding, which inflated a
          hand-rolled switch and pushed its knob outside the track. */}
      <label className="toggle-row cz-master-switch">
        <input type="checkbox" checked={data.enabled} onChange={e => void setEnabled(e.currentTarget.checked)} />
        <span className="switch" aria-hidden="true" />
      </label>
      </div>

      <div className={`cz-dim${data.enabled ? '' : ' cz-dim-off'}`}>

        {/* toolbar */}
        <div className="cz-toolbar">
          <div className="cz-locale-tabs">
            {Object.keys(data.fragments[0]?.locales ?? { zh: 0, en: 0 }).map(loc => (
              <button key={loc} className={`cz-tab${locale === loc ? ' cz-tab-on' : ''}`} onClick={() => setLocale(loc)}>{loc.toUpperCase()}</button>
            ))}
          </div>
          <div className="cz-toolbar-spacer" />
          <button className="cz-btn cz-btn-ghost" onClick={() => setShowHistory(h => !h)}>历史 / 回滚 ({data.history.length})</button>
          <a className="cz-btn cz-btn-ghost" href="/api/customization/export" download>导出 bundle</a>
          <button className="cz-btn cz-btn-ghost" onClick={() => setShowImport(true)}>导入 bundle</button>
          <button className="cz-btn cz-btn-danger" onClick={async () => { if (await confirm({ title: '全部恢复出厂', message: '把所有 prompt/skill 覆盖恢复出厂？会先存快照，可回滚撤回。', danger: true, confirmLabel: '恢复出厂' })) { await post('/api/customization/reset-all'); flash('已全部恢复出厂'); } }}>全部恢复出厂</button>
        </div>

        {showHistory ? (
          <div className="cz-section">
            <header><span className="cz-dot" /><h2>改动历史</h2><span className="cz-sub">回滚本身也存快照，非破坏式</span></header>
            <div className="cz-section-body">
              {data.history.length === 0 ? <div className="cz-hint">（暂无历史）</div> : data.history.map(s => (
                <div key={s.id} className="cz-hist-row">
                  <span className="cz-hist-when">{rel(s.at)}</span>
                  <span className="cz-hist-label">{s.label}</span>
                  <span className="cz-hist-sum">prompt {s.summary.promptKeys} · skill {s.summary.skills} · {s.summary.enabled ? 'on' : 'off'}</span>
                  <button className="cz-link" onClick={async () => { if (await confirm({ title: '回滚快照', message: '回滚到此快照？回滚本身也会存快照，非破坏式。', confirmLabel: '回滚' })) { await post('/api/customization/rollback', { id: s.id }); flash('已回滚'); } }}>回滚到此</button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* prompt fragments */}
        <div className="cz-section">
          <header>
            <span className="cz-dot" /><h2>内置 Prompt 片段</h2>
            <span className="cz-sub">实际注入模型的内容 · {promptModified} 处已改（{locale.toUpperCase()}）</span>
          </header>
          <div className="cz-section-body">
            <div className="cz-legend">
              <span><i className="cz-sq cz-sq-editable" />可编辑：点击就地改</span>
              <span><i className="cz-sq cz-sq-conditional" />条件行：下拉决定是否注入</span>
              <span className="cz-chip cz-chip-ph" style={{ fontSize: 10 }}>{'{占位符}'}</span> 删不得，保存时校验
            </div>
            <div className="cz-callout">⚠ 逃生阀：可以删掉命脉指令（如 <code>botmux send</code>），但机器人可能因此无法把回复发回飞书。拿不准就点「恢复出厂」。</div>
            {blocks.map(block => (
              <div key={block} className="cz-block">
                <div className="cz-block-label"><span className="cz-block-tag">{BLOCK_LABELS[block] ?? block}</span><span className="cz-block-line" /></div>
                {data.fragments.filter(f => f.block === block).map(f => (
                  <FragmentRow key={f.key} frag={f} locale={locale} onSaved={onSaved} onError={onError} />
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* skills */}
        <div className="cz-section">
          <header>
            <span className="cz-dot" /><h2>内置 Skill 覆盖</h2>
            <span className="cz-sub">{data.skills.length} 个内置技能 · {skillsModified} 个已改/停用</span>
          </header>
          <div className="cz-section-body">
            {data.skills.map(s => <SkillRowView key={s.name} skill={s} onSaved={onSaved} onError={onError} />)}
          </div>
        </div>

      </div>

      {toast ? <div className="cz-toast">{toast}</div> : null}
      {showImport ? <ImportModal onClose={() => setShowImport(false)} onApplied={onSaved} onError={onError} /> : null}
    </section>
  );
}

export function renderCustomizationPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <CustomizationPage />);
}

// ─── Scoped CSS (uses shared design tokens; cz- prefix avoids collisions) ────

const PAGE_CSS = `
.cz-page{max-width:960px;padding:20px 22px 80px;}
.cz-head h1{font-size:22px;margin:0 0 4px;font-weight:680;}
.cz-head p{margin:0;color:var(--muted);font-size:13.5px;max-width:66ch;}
.cz-error{color:var(--danger);padding:20px;}
.cz-master{margin:18px 0 20px;display:flex;align-items:center;gap:16px;padding:14px 18px;border:1px solid var(--border-soft);border-radius:var(--radius);background:linear-gradient(100deg,var(--accent-soft),transparent 70%);}
.cz-master-txt{flex:1;}
.cz-master-txt b{font-size:14.5px;}
.cz-master-txt span{display:block;color:var(--muted);font-size:12.5px;margin-top:2px;}
.cz-master-switch{flex:none;padding:0;margin:0;align-items:center;}
.cz-dim{transition:opacity .2s,filter .2s;}
.cz-dim-off{opacity:.45;filter:grayscale(.5);pointer-events:none;}
.cz-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:18px;flex-wrap:wrap;}
.cz-locale-tabs{display:flex;gap:2px;background:var(--surface-muted);border:1px solid var(--border-soft);border-radius:10px;padding:2px;}
.cz-tab{border:none;background:none;color:var(--muted);padding:5px 12px;border-radius:8px;cursor:pointer;font-size:12.5px;font-family:inherit;min-height:0;}
.cz-tab-on{background:var(--surface);color:var(--fg);font-weight:600;box-shadow:var(--shadow);}
.cz-toolbar-spacer{flex:1;}
.cz-btn{border:none;border-radius:10px;height:32px;padding:0 13px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px;text-decoration:none;}
.cz-btn-primary{background:var(--accent);color:var(--on-accent);}
.cz-btn-ghost{background:var(--surface);border:1px solid var(--border);color:var(--fg);}
.cz-btn-ghost:hover{border-color:var(--accent);color:var(--accent-strong);}
.cz-btn-danger{background:var(--danger-soft);color:var(--danger);}
.cz-btn:disabled{opacity:.5;cursor:default;}
.cz-section{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius);margin-bottom:18px;overflow:hidden;box-shadow:var(--shadow);}
.cz-section > header{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border-soft);}
.cz-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none;}
.cz-section > header h2{font-size:15px;margin:0;font-weight:640;}
.cz-section > header .cz-sub{color:var(--faint);font-size:12px;margin-left:auto;}
.cz-section-body{padding:10px 18px 16px;}
.cz-legend{display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:6px 0 12px;color:var(--muted);font-size:11.5px;border-bottom:1px solid var(--border-soft);margin-bottom:10px;}
.cz-legend span{display:inline-flex;align-items:center;gap:6px;}
.cz-sq{width:10px;height:10px;border-radius:3px;display:inline-block;}
.cz-sq-editable{background:var(--accent);}
.cz-sq-conditional{background:var(--warning);}
.cz-callout{background:var(--warning-soft);border:1px solid color-mix(in srgb,var(--warning) 30%,transparent);border-radius:10px;padding:9px 13px;color:var(--warning);font-size:12px;margin-bottom:14px;}
.cz-callout code{background:rgba(0,0,0,.08);padding:0 4px;border-radius:4px;}
.cz-block{margin-bottom:14px;}
.cz-block-label{display:flex;align-items:center;gap:8px;margin:14px 0 6px;}
.cz-block-tag{font-family:var(--mono);font-size:11.5px;color:var(--accent-strong);background:var(--accent-soft);padding:2px 9px;border-radius:6px;}
.cz-block-line{flex:1;height:1px;background:var(--border-soft);}
.cz-frag{border:1px solid transparent;border-radius:10px;padding:8px 10px;margin:3px 0;position:relative;}
.cz-frag-bar{position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:3px;}
.cz-frag-editable .cz-frag-bar,.cz-frag-placeholder .cz-frag-bar{background:var(--accent);}
.cz-frag-conditional .cz-frag-bar{background:var(--warning);}
.cz-frag-inner{padding-left:12px;}
.cz-frag-top{display:flex;align-items:center;gap:8px;margin-bottom:3px;flex-wrap:wrap;}
.cz-frag-label{font-size:12.5px;font-weight:600;}
.cz-frag-key{font-family:var(--mono);font-size:10.5px;color:var(--faint);}
.cz-frag-badges{margin-left:auto;display:flex;gap:6px;align-items:center;}
.cz-chip{font-size:10.5px;padding:2px 8px;border-radius:999px;font-weight:600;white-space:nowrap;}
.cz-chip-mod{background:var(--warning-soft);color:var(--warning);}
.cz-chip-factory{background:var(--surface-muted);color:var(--faint);border:1px solid var(--border-soft);}
.cz-chip-off{background:var(--danger-soft);color:var(--danger);}
.cz-chip-ph{background:var(--accent-soft);color:var(--accent-strong);}
.cz-chip-cond{background:var(--accent-soft);color:var(--accent-strong);display:inline-flex;align-items:center;gap:6px;}
.cz-cond-select{border:1px solid var(--border);background:var(--surface);color:var(--fg);border-radius:6px;font-size:11px;padding:1px 4px;font-family:inherit;}
.cz-link{background:none;border:none;color:var(--accent);cursor:pointer;font-size:12px;font-family:inherit;padding:2px 4px;border-radius:6px;min-height:0;}
.cz-link:hover{background:var(--accent-soft);}
.cz-link-danger{color:var(--danger);}
.cz-link-reset{color:var(--warning);}
.cz-link:disabled{opacity:.5;cursor:default;}
.cz-frag-text{font-family:var(--mono);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;cursor:text;padding:4px 0;position:relative;}
.cz-frag-text:hover{background:var(--accent-soft);border-radius:6px;}
.cz-edit-hint{opacity:0;color:var(--accent);margin-left:6px;font-size:11px;}
.cz-frag-text:hover .cz-edit-hint{opacity:1;}
.cz-textarea{width:100%;background:var(--surface-muted);border:1px solid var(--border);border-radius:8px;padding:9px 11px;font-family:var(--mono);font-size:12px;line-height:1.6;color:var(--fg);resize:vertical;}
.cz-textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);}
.cz-edit-actions{display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap;}
.cz-hint{color:var(--faint);font-size:11.5px;}
.cz-skill{border-bottom:1px solid var(--border-soft);}
.cz-skill:last-child{border-bottom:none;}
.cz-skill-head{display:flex;align-items:center;gap:11px;padding:11px 2px;cursor:pointer;}
.cz-caret{color:var(--faint);font-size:10px;width:11px;transition:transform .15s;}
.cz-caret-open{transform:rotate(90deg);}
.cz-skill-name{font-family:var(--mono);font-size:12.5px;font-weight:500;}
.cz-skill-desc{color:var(--muted);font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cz-skill-badges{display:flex;align-items:center;gap:8px;flex:none;}
.cz-skill-off .cz-skill-name{text-decoration:line-through;opacity:.6;}
.cz-skill-body{padding:2px 2px 14px;}
.cz-skill-textarea{min-height:180px;}
.cz-mask{position:fixed;inset:0;background:rgba(10,14,18,.5);display:grid;place-items:center;z-index:40;padding:20px;}
.cz-modal{background:var(--surface);border:1px solid var(--border);border-radius:14px;max-width:600px;width:100%;box-shadow:0 24px 80px rgba(0,0,0,.3);max-height:84vh;display:flex;flex-direction:column;}
.cz-modal header{padding:15px 20px;border-bottom:1px solid var(--border-soft);display:flex;align-items:center;}
.cz-modal header h3{margin:0;font-size:15px;}
.cz-x{margin-left:auto;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;line-height:1;min-height:0;padding:0;}
.cz-modal-body{padding:16px 20px;overflow:auto;display:flex;flex-direction:column;gap:12px;}
.cz-modal footer{padding:13px 20px;border-top:1px solid var(--border-soft);display:flex;gap:10px;justify-content:flex-end;}
.cz-drop{border:1.5px dashed var(--border);border-radius:10px;padding:16px;text-align:center;color:var(--faint);font-size:12.5px;cursor:pointer;display:block;}
.cz-drop:hover{border-color:var(--accent);color:var(--accent-strong);background:var(--accent-soft);}
.cz-diff{border:1px solid var(--border-soft);border-radius:10px;padding:10px;background:var(--surface-muted);max-height:260px;overflow:auto;}
.cz-diff-sum{font-size:12px;font-weight:600;margin-bottom:8px;}
.cz-diff-row{display:flex;gap:8px;align-items:baseline;font-size:11.5px;padding:2px 0;font-family:var(--mono);}
.cz-diff-mark{flex:none;width:14px;}
.cz-diff-add .cz-diff-mark{color:var(--success);}
.cz-diff-replace .cz-diff-mark{color:var(--warning);}
.cz-diff-disable .cz-diff-mark{color:var(--danger);}
.cz-diff-id{color:var(--fg);flex:none;}
.cz-diff-after{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cz-hist-row{display:flex;align-items:center;gap:12px;padding:8px 2px;border-bottom:1px solid var(--border-soft);font-size:12.5px;}
.cz-hist-row:last-child{border-bottom:none;}
.cz-hist-when{color:var(--faint);font-size:11.5px;width:56px;flex:none;}
.cz-hist-label{flex:1;}
.cz-hist-sum{color:var(--faint);font-size:11px;font-family:var(--mono);}
.cz-toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:10px 18px;border-radius:10px;font-size:13px;z-index:50;box-shadow:var(--shadow);}
`;
