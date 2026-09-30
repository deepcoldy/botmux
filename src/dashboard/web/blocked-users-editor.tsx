import { useEffect, useRef, useState } from 'react';
import { toast } from './toast.js';

type Tr = (key: string, values?: Record<string, string | number>) => string;
type JsonResponse = { ok: boolean; status: number; body: any };

async function sendJson(method: string, url: string, body?: unknown): Promise<JsonResponse> {
  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await r.json().catch(() => ({}));
  return { ok: r.ok && parsed?.ok !== false, status: r.status, body: parsed };
}

/**
 * Bot 默认配置 · 安全页：blockedUsers 原始条目编辑。
 *
 * 只编辑黑名单这一条纯否决腿；allowedUsers（owner-identity 红线）不在此提供任何
 * 写入口。保存整表 PUT；空表保存即清空。
 */
export function BlockedUsersEditor(props: {
  larkAppId: string;
  tr: Tr;
}) {
  const { larkAppId, tr } = props;
  const [entries, setEntries] = useState<string[] | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    const seq = ++seqRef.current;
    setEntries(null);
    void (async () => {
      try {
        const res = await sendJson('GET', `/api/bots/${encodeURIComponent(larkAppId)}/blocked-users`);
        if (seq !== seqRef.current) return;
        if (res.ok) {
          setEntries(Array.isArray(res.body.raw)
            ? res.body.raw.filter((x: unknown) => typeof x === 'string')
            : []);
        } else {
          setEntries([]);
          toast(`${tr('blocked.loadFailed')}: ${res.body?.error ?? res.status}`, { kind: 'error' });
        }
      } catch (err) {
        if (seq !== seqRef.current) return;
        setEntries([]);
        toast(`Network error: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
      }
    })();
  }, [active, larkAppId, tr]);

  function addDraft(): void {
    const parts = draft.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    setEntries(cur => [...new Set([...(cur ?? []), ...parts])]);
    setDraft('');
  }

  async function save(next: string[]): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      const res = await sendJson(
        'PUT',
        `/api/bots/${encodeURIComponent(larkAppId)}/blocked-users`,
        { entries: next },
      );
      if (res.ok) {
        setEntries(Array.isArray(res.body.raw) ? res.body.raw : next);
        toast(tr('blocked.saved'), { kind: 'success' });
      } else if (res.status === 409 || res.body?.error === 'cannot_block_admin') {
        toast(tr('blocked.conflict'), { kind: 'warning' });
      } else if (res.status === 422 || res.body?.error === 'empty_resolved') {
        toast(tr('blocked.emptyResolved'), { kind: 'warning' });
      } else if (res.status === 400 || res.body?.error === 'invalid_entries') {
        toast(tr('blocked.invalidEntries'), { kind: 'warning' });
      } else {
        toast(`${tr('blocked.saveFailed')}: ${res.body?.error ?? res.status}`, { kind: 'error' });
      }
    } catch (err) {
      toast(`Network error: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="bd-section" data-blocked-users-editor>
      <details data-blocked-users-toggle onToggle={ev => setActive(ev.currentTarget.open)}>
        <summary><h3 className="bd-section-title">{tr('blocked.sectionTitle')}</h3></summary>
        <p><small>{tr('blocked.sectionHelp')}</small></p>
        {active && entries === null ? (
          <p className="empty">{tr('blocked.loading')}</p>
        ) : active && entries !== null ? (
        <>
          {entries.length === 0 ? <p className="empty">{tr('blocked.empty')}</p> : (
            <ul className="bd-blocked-list" data-blocked-list>
              {entries.map(entry => (
                <li key={entry} data-blocked-entry={entry}>
                  <code>{entry}</code>
                  <button
                    type="button"
                    data-action="remove-entry"
                    disabled={saving}
                    onClick={() => setEntries(cur => (cur ?? []).filter(item => item !== entry))}
                  >{tr('blocked.remove')}</button>
                </li>
              ))}
            </ul>
          )}
          <div className="bd-blocked-add">
            <input
              type="text"
              data-action="add-input"
              value={draft}
              disabled={saving}
              placeholder={tr('blocked.addPlaceholder')}
              onChange={ev => setDraft(ev.currentTarget.value)}
              onKeyDown={ev => {
                if (ev.key === 'Enter') {
                  ev.preventDefault();
                  addDraft();
                }
              }}
            />
            <button type="button" data-action="add-draft" disabled={saving} onClick={addDraft}>
              {tr('blocked.add')}
            </button>
          </div>
          <div className="actions">
            <button
              type="button"
              className="primary"
              data-action="save"
              disabled={saving}
              onClick={() => void save(entries)}
            >{tr('blocked.save')}</button>
            <button
              type="button"
              data-action="clear-all"
              disabled={saving}
              onClick={() => void save([])}
            >{tr('blocked.clearAll')}</button>
          </div>
        </>
        ) : null}
      </details>
    </section>
  );
}
