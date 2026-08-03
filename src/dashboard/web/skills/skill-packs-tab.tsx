import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../react-hooks.js';
import { LoadingState, RefreshIconButton, SectionHeader } from '../dashboard-components.js';
import type { SkillPackRow, SkillRow, StatusMessage } from './types.js';

interface SkillPacksTabProps {
  skills: SkillRow[];
  onRefresh: () => void;
  refreshKey: number;
}

type PackHealth = 'complete' | 'missing' | 'unassigned';

function healthStatus(pack: SkillPackRow): PackHealth {
  if ((pack.missingSkills?.length ?? 0) > 0) return 'missing';
  if ((pack.references?.length ?? 0) === 0) return 'unassigned';
  return 'complete';
}

export function SkillPacksTab(props: SkillPacksTabProps) {
  const tr = useT();
  const [packs, setPacks] = useState<SkillPackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SkillPackRow | null>(null);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ pack: SkillPackRow; references: Array<{ larkAppId: string; botName: string }> } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const mountedRef = useRef(true);

  const fetchPacks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/skill-packs');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      if (mountedRef.current) setPacks(Array.isArray(body.packs) ? body.packs : []);
    } catch (err: any) {
      if (mountedRef.current) setError(err?.message ?? String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void fetchPacks();
    return () => { mountedRef.current = false; };
  }, [fetchPacks, props.refreshKey]);

  const openCreate = () => { setEditing(null); setEditorOpen(true); };
  const openEdit = (pack: SkillPackRow) => { setEditing(pack); setEditorOpen(true); };

  const handleSaved = () => {
    setEditorOpen(false);
    setEditing(null);
    setStatus({ text: tr('skills.saved'), ok: true });
    void fetchPacks();
    props.onRefresh();
  };

  const handleDelete = async (pack: SkillPackRow) => {
    // First attempt WITHOUT force: lets the backend enforce the in-use guard.
    // If the pack is referenced by bots, the backend returns 409 IN_USE with the
    // list of affected bots — we then surface an explicit confirmation before
    // retrying with force=1. Never silently force-delete.
    try {
      const res = await fetch(`/api/skill-packs/${encodeURIComponent(pack.id)}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus({ text: tr('skills.packDeleted', { name: pack.name }), ok: true });
        void fetchPacks();
        props.onRefresh();
        return;
      }
      if (res.status === 409 && body?.error === 'SKILL_PACK_IN_USE') {
        const references = Array.isArray(body?.references) ? body.references : (pack.references ?? []);
        setDeleteConfirm({ pack, references });
        return;
      }
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    } catch (err: any) {
      setStatus({ text: `${tr('skills.failed')}: ${err?.message ?? err}`, ok: false });
    }
  };

  const confirmForceDelete = async () => {
    if (!deleteConfirm) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/skill-packs/${encodeURIComponent(deleteConfirm.pack.id)}?force=1`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setStatus({ text: tr('skills.packDeleted', { name: deleteConfirm.pack.name }), ok: true });
      setDeleteConfirm(null);
      void fetchPacks();
      props.onRefresh();
    } catch (err: any) {
      setStatus({ text: `${tr('skills.failed')}: ${err?.message ?? err}`, ok: false });
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <section className="skills-config-block">
      <SectionHeader
        title={tr('skills.packs')}
        count={tr('skills.packCount', { count: packs.length })}
        hint={tr('skills.packsHelp')}
      >
        <RefreshIconButton label={tr('skills.refresh')} onClick={() => void fetchPacks()} />
      </SectionHeader>
      {status && <p className={`hint-${status.ok ? 'ok' : 'warn'}`}>{status.text}</p>}
      {loading ? <LoadingState label={tr('common.loading')} /> : error ? <p className="hint-warn">{error}</p> : (
        <div className="bd-card skills-config-card">
          {packs.length === 0 ? (
            <div className="skills-empty-state">
              <p>{tr('skills.packsEmpty')}</p>
              <button className="bd-button primary" onClick={openCreate}>{tr('skills.packCreate')}</button>
            </div>
          ) : (
            <div className="skills-pack-list">
              <button className="bd-button primary skills-pack-create-btn" onClick={openCreate}>
                + {tr('skills.packCreate')}
              </button>
              {packs.map(pack => {
                const health = healthStatus(pack);
                return (
                  <div className="skills-pack-card" key={pack.id}>
                    <div className="skills-pack-card-head">
                      <div>
                        <strong>{pack.name}</strong>
                        <code className="skills-pack-id">{pack.id}</code>
                      </div>
                      <span className={`skills-pack-health skills-pack-health-${health}`}>
                        {health === 'complete' ? tr('skills.packHealthComplete') :
                         health === 'missing' ? tr('skills.packHealthMissing', { count: pack.missingSkills?.length ?? 0 }) :
                         tr('skills.packHealthUnassigned')}
                      </span>
                    </div>
                    {pack.description && <p className="skills-pack-desc">{pack.description}</p>}
                    <div className="skills-pack-meta">
                      <span>{tr('skills.skillCount', { count: pack.include.length })}</span>
                      <span>{tr('skills.packRefCount', { count: pack.references?.length ?? 0 })}</span>
                      {pack.tags && pack.tags.length > 0 && <span>{pack.tags.join(', ')}</span>}
                    </div>
                    {(pack.references?.length ?? 0) > 0 && (
                      <div className="skills-pack-refs">
                        <small>{tr('skills.packRefs')}: {pack.references!.map(r => r.botName).join(', ')}</small>
                      </div>
                    )}
                    {(pack.missingSkills?.length ?? 0) > 0 && (
                      <div className="skills-pack-missing">
                        <small>{tr('skills.packMissing')}: {pack.missingSkills!.join(', ')}</small>
                      </div>
                    )}
                    <div className="skills-pack-actions">
                      <button className="bd-button" onClick={() => openEdit(pack)}>{tr('skills.packEdit')}</button>
                      <button className="bd-button danger" onClick={() => void handleDelete(pack)}>{tr('skills.remove')}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {editorOpen && (
        <SkillPackEditor
          pack={editing}
          skills={props.skills}
          onClose={() => { setEditorOpen(false); setEditing(null); }}
          onSaved={handleSaved}
        />
      )}
      {deleteConfirm && (
        <dialog className="bd-dialog skills-pack-delete-confirm" open onClose={() => !deleteBusy && setDeleteConfirm(null)}>
          <form method="dialog" onSubmit={e => { e.preventDefault(); void confirmForceDelete(); }}>
            <h3>{tr('skills.packDeleteConfirmTitle')}</h3>
            <p>{tr('skills.packDeleteConfirmBody', { name: deleteConfirm.pack.name })}</p>
            {deleteConfirm.references.length > 0 && (
              <div className="skills-pack-delete-refs">
                <p><strong>{tr('skills.packDeleteAffectedBots')}:</strong></p>
                <ul>
                  {deleteConfirm.references.map(ref => (
                    <li key={ref.larkAppId}>{ref.botName}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="hint-warn">{tr('skills.packDeleteForceWarning')}</p>
            <div className="skills-dialog-actions">
              <button type="button" className="bd-button" onClick={() => setDeleteConfirm(null)} disabled={deleteBusy}>
                {tr('skills.cancel')}
              </button>
              <button type="submit" className="bd-button danger" disabled={deleteBusy}>
                {deleteBusy ? tr('skills.removing') : tr('skills.removeAnyway')}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </section>
  );
}

function SkillPackEditor(props: {
  pack: SkillPackRow | null;
  skills: SkillRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const tr = useT();
  const [id, setId] = useState(props.pack?.id ?? '');
  const [name, setName] = useState(props.pack?.name ?? '');
  const [description, setDescription] = useState(props.pack?.description ?? '');
  const [tags, setTags] = useState((props.pack?.tags ?? []).join(', '));
  const [selected, setSelected] = useState<Set<string>>(() => new Set(props.pack?.include.map(s => s.replace('skill:', '')) ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) dlg.showModal();
  }, []);

  const toggleSkill = (skillName: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(skillName)) next.delete(skillName); else next.add(skillName);
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        id,
        name,
        description: description || undefined,
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
        include: [...selected].map(s => `skill:${s}`),
        ...(props.pack ? { expectedRevision: props.pack.revision } : {}),
      };
      const url = props.pack ? `/api/skill-packs/${encodeURIComponent(props.pack.id)}` : '/api/skill-packs';
      const res = await fetch(url, {
        method: props.pack ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? body?.reason ?? `HTTP ${res.status}`);
      props.onSaved();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog className="bd-dialog skills-pack-editor" ref={dialogRef} onClose={props.onClose}>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <h3>{props.pack ? tr('skills.packEdit') : tr('skills.packCreate')}</h3>
        {error && <p className="hint-warn">{error}</p>}
        <div className="skills-control-block">
          <label>{tr('skills.packId')}</label>
          <input value={id} onChange={e => setId(e.target.value)} disabled={!!props.pack} placeholder="my-pack-slug" />
        </div>
        <div className="skills-control-block">
          <label>{tr('skills.packName')}</label>
          <input value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className="skills-control-block">
          <label>{tr('skills.packDescription')}</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} />
        </div>
        <div className="skills-control-block">
          <label>{tr('skills.packTags')}</label>
          <input value={tags} onChange={e => setTags(e.target.value)} placeholder="tag1, tag2" />
        </div>
        <div className="skills-control-block">
          <label>{tr('skills.packInclude')} ({selected.size})</label>
          <div className="skills-pack-skill-list">
            {props.skills.map(skill => (
              <label key={skill.name} className="skills-pack-skill-item">
                <input
                  type="checkbox"
                  checked={selected.has(skill.name)}
                  onChange={() => toggleSkill(skill.name)}
                />
                <span>{skill.name}</span>
                {skill.description && <small>{skill.description}</small>}
              </label>
            ))}
          </div>
        </div>
        <div className="skills-dialog-actions">
          <button type="button" className="bd-button" onClick={props.onClose}>{tr('skills.cancel')}</button>
          <button type="submit" className="bd-button primary" disabled={busy || selected.size === 0 || !name.trim()}>
            {busy ? tr('skills.saving') : tr('skills.saveSelection')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
