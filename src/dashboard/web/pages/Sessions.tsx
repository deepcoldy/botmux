import { useMemo, useState } from 'react';
import { store, useStoreVersion } from '../store.js';
import { api, type Session } from '../api.js';
import { useT } from '../i18n.js';
import { Card } from '../components/ui/Card.js';
import { Input, Checkbox } from '../components/ui/Input.js';
import { Button } from '../components/ui/Button.js';
import { Dropdown } from '../components/ui/Dropdown.js';
import { Table, Thead, Tbody, Tr, Th, Td } from '../components/ui/Table.js';
import { CliBadge, StatusPill } from '../components/ui/Badge.js';
import { Dialog, DialogHeader, DialogBody, DialogFooter } from '../components/ui/Dialog.js';
import { KvLine } from '../components/ui/KvLine.js';
import { cn, relTime } from '../lib/utils.js';

const CLI_OPTIONS = ['claude-code', 'codex', 'cursor', 'gemini', 'opencode', 'aiden', 'coco', 'unknown'];
const STATUS_OPTIONS = ['starting', 'working', 'idle', 'analyzing', 'closed'];

type SortKey = 'botName' | 'cliId' | 'status' | 'title' | 'workingDir' | 'spawnedAt' | 'lastMessageAt' | 'adopt';
type SortDir = 'asc' | 'desc';

function sortValue(s: Session, key: SortKey): number | string | boolean {
  if (key === 'spawnedAt' || key === 'lastMessageAt') return Number(s[key] ?? 0);
  if (key === 'adopt') return !!s.adopt;
  return String(s[key] ?? '').toLowerCase();
}

export function SessionsPage() {
  const version = useStoreVersion();
  const t = useT();

  const [q, setQ] = useState('');
  const [cliFilter, setCliFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [adoptFilter, setAdoptFilter] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('lastMessageAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [openSession, setOpenSession] = useState<Session | null>(null);
  const [bulkBusy, setBulkBusy] = useState<{ done: number; total: number } | null>(null);

  const rows = useMemo(() => {
    const ql = q.toLowerCase();
    const list = [...store.sessions.values()]
      .filter((s) => !cliFilter.length || cliFilter.includes(s.cliId ?? 'unknown'))
      .filter((s) => !statusFilter || s.status === statusFilter)
      .filter((s) => !adoptFilter || (adoptFilter === 'yes') === !!s.adopt)
      .filter((s) => !activeOnly || s.status !== 'closed')
      .filter((s) => !ql || JSON.stringify(s).toLowerCase().includes(ql));
    list.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      let cmp = 0;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else if (typeof av === 'boolean' && typeof bv === 'boolean') cmp = Number(av) - Number(bv);
      else cmp = String(av).localeCompare(String(bv));
      if (cmp === 0) cmp = Number(a.lastMessageAt ?? 0) - Number(b.lastMessageAt ?? 0);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [version, q, cliFilter, statusFilter, adoptFilter, activeOnly, sortKey, sortDir]);

  const effectiveSelected = useMemo(() => {
    const out = new Set<string>();
    for (const sid of selected) {
      const s = store.sessions.get(sid);
      if (s && s.status !== 'closed') out.add(sid);
    }
    return out;
  }, [version, selected, rows]);

  const selectable = useMemo(() => rows.filter((r) => r.status !== 'closed'), [rows]);
  const selectedInView = selectable.filter((r) => effectiveSelected.has(r.sessionId)).length;
  const allSelected = selectable.length > 0 && selectedInView === selectable.length;
  const partialSelected = selectedInView > 0 && selectedInView < selectable.length;

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'spawnedAt' || key === 'lastMessageAt' ? 'desc' : 'asc');
    }
  }

  function toggleRow(id: string, on: boolean) {
    const next = new Set(effectiveSelected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  }

  function toggleAll(on: boolean) {
    const next = new Set(effectiveSelected);
    if (on) selectable.forEach((r) => next.add(r.sessionId));
    else selectable.forEach((r) => next.delete(r.sessionId));
    setSelected(next);
  }

  async function bulkClose() {
    const ids = [...effectiveSelected];
    if (ids.length === 0) return;
    if (!confirm(t.sessions.confirmCloseBulk(ids.length))) return;
    setBulkBusy({ done: 0, total: ids.length });
    let done = 0;
    let failed = 0;
    const failures: string[] = [];
    const queue = [...ids];
    async function worker() {
      while (queue.length) {
        const sid = queue.shift()!;
        try {
          const r = await api.closeSession(sid);
          if (!r.ok) {
            failed += 1;
            failures.push(`${sid.slice(0, 12)}…: ${r.error ?? 'failed'}`);
          }
        } catch (e: any) {
          failed += 1;
          failures.push(`${sid.slice(0, 12)}…: ${e?.message ?? e}`);
        } finally {
          done += 1;
          setBulkBusy({ done, total: ids.length });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, ids.length) }, () => worker()));
    setBulkBusy(null);
    setSelected(new Set());
    if (failed > 0) {
      const head = failures.slice(0, 3).join('\n');
      const more = failures.length > 3 ? `\n... +${failures.length - 3}` : '';
      alert(`${t.sessions.closeDone(ids.length - failed, failed)}\n${head}${more}`);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            placeholder={t.sessions.searchPlaceholder}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-w-72 flex-1"
          />
          <Dropdown
            value={statusFilter}
            onChange={setStatusFilter}
            placeholder={t.sessions.allStatus}
            minWidth="min-w-36"
            options={[
              { value: '', label: t.sessions.allStatus },
              ...STATUS_OPTIONS.map((s) => ({
                value: s,
                label: <StatusPill status={s} />,
                triggerLabel: <StatusPill status={s} />,
              })),
            ]}
          />
          <Dropdown
            value={adoptFilter}
            onChange={setAdoptFilter}
            placeholder={t.sessions.adoptAll}
            minWidth="min-w-32"
            options={[
              { value: '', label: t.sessions.adoptAll },
              { value: 'yes', label: <>{t.sessions.adoptYes} 🪞</> },
              { value: 'no', label: t.sessions.adoptNo },
            ]}
          />
          <CliMultiSelect value={cliFilter} onChange={setCliFilter} />
          <label className="flex items-center gap-1.5 text-sm text-slate-700 select-none cursor-pointer">
            <Checkbox checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
            {t.sessions.activeOnly}
          </label>
          <span className="ml-auto text-xs text-slate-500">{t.sessions.count(rows.length)}</span>
        </div>
      </Card>

      {effectiveSelected.size > 0 && (
        <div className="sticky top-14 z-10 flex items-center gap-3 px-4 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm shadow-sm">
          <span className="font-semibold">{t.sessions.selected(effectiveSelected.size)}</span>
          <Button size="sm" variant="destructive" onClick={bulkClose} disabled={!!bulkBusy}>
            {bulkBusy ? t.sessions.closeProgress(bulkBusy.done, bulkBusy.total) : t.sessions.closeSelected}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={!!bulkBusy}>
            {t.common.cancel}
          </Button>
        </div>
      )}

      <Card className="overflow-hidden">
        <Table>
          <Thead>
            <Tr className="hover:bg-transparent">
              <Th className="w-8">
                <Checkbox
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = partialSelected; }}
                  disabled={selectable.length === 0}
                  onChange={(e) => toggleAll(e.target.checked)}
                />
              </Th>
              <SortHeader k="botName" cur={sortKey} dir={sortDir} on={toggleSort}>{t.sessions.cols.bot}</SortHeader>
              <SortHeader k="cliId" cur={sortKey} dir={sortDir} on={toggleSort}>{t.sessions.cols.cli}</SortHeader>
              <SortHeader k="status" cur={sortKey} dir={sortDir} on={toggleSort}>{t.sessions.cols.status}</SortHeader>
              <SortHeader k="title" cur={sortKey} dir={sortDir} on={toggleSort}>{t.sessions.cols.title}</SortHeader>
              <SortHeader k="workingDir" cur={sortKey} dir={sortDir} on={toggleSort}>{t.sessions.cols.workingDir}</SortHeader>
              <SortHeader k="spawnedAt" cur={sortKey} dir={sortDir} on={toggleSort}>{t.sessions.cols.created}</SortHeader>
              <SortHeader k="lastMessageAt" cur={sortKey} dir={sortDir} on={toggleSort}>{t.sessions.cols.last}</SortHeader>
              <SortHeader k="adopt" cur={sortKey} dir={sortDir} on={toggleSort}>{t.sessions.cols.adopt}</SortHeader>
              <Th className="w-12" />
            </Tr>
          </Thead>
          <Tbody>
            {rows.length === 0 && (
              <Tr className="hover:bg-transparent">
                <Td colSpan={10} className="text-center py-10 text-slate-400">{t.sessions.empty}</Td>
              </Tr>
            )}
            {rows.map((s) => {
              const closed = s.status === 'closed';
              const sel = effectiveSelected.has(s.sessionId);
              return (
                <Tr key={s.sessionId} onClick={() => setOpenSession(s)} className="cursor-pointer">
                  <Td onClick={(e) => e.stopPropagation()} className="w-8">
                    <Checkbox checked={sel} disabled={closed} onChange={(e) => toggleRow(s.sessionId, e.target.checked)} />
                  </Td>
                  <Td>{s.botName ?? ''}</Td>
                  <Td><CliBadge cli={s.cliId} /></Td>
                  <Td><StatusPill status={s.status} /></Td>
                  <Td className="max-w-[200px] truncate" title={s.title ?? ''}>{(s.title ?? '').slice(0, 40)}</Td>
                  <Td className="max-w-[220px] truncate text-slate-500 font-mono text-xs" title={s.workingDir ?? ''}>
                    {(s.workingDir ?? '').slice(-30)}
                  </Td>
                  <Td className="text-slate-500 text-xs">{relTime(s.spawnedAt ?? 0)}</Td>
                  <Td className="text-slate-500 text-xs">{relTime(s.lastMessageAt ?? 0)}</Td>
                  <Td className="text-center">{s.adopt ? '🪞' : ''}</Td>
                  <Td className="text-slate-400">⋯</Td>
                </Tr>
              );
            })}
          </Tbody>
        </Table>
      </Card>

      <SessionDrawer session={openSession} onClose={() => setOpenSession(null)} />
    </div>
  );
}

function SortHeader({ k, cur, dir, on, children }: {
  k: SortKey; cur: SortKey; dir: SortDir;
  on: (k: SortKey) => void; children: React.ReactNode;
}) {
  const active = cur === k;
  return (
    <Th sortable onClick={() => on(k)} className={cn(active && 'text-slate-900 bg-slate-100')}>
      {children}
      <span className="ml-1 text-[10px] text-slate-400">{active ? (dir === 'asc' ? '▲' : '▼') : ''}</span>
    </Th>
  );
}

function CliMultiSelect({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button size="md" variant="outline" onClick={() => setOpen((o) => !o)}>
        cli{value.length ? `: ${value.length}` : ''} ▾
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 top-full mt-1 left-0 bg-white border border-slate-200 rounded-md shadow-lg p-2 min-w-44 max-h-64 overflow-auto scrollbar-thin">
            {CLI_OPTIONS.map((c) => (
              <label key={c} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-50 cursor-pointer text-sm">
                <Checkbox
                  checked={value.includes(c)}
                  onChange={(e) => {
                    if (e.target.checked) onChange([...value, c]);
                    else onChange(value.filter((x) => x !== c));
                  }}
                />
                <CliBadge cli={c} />
              </label>
            ))}
            {value.length > 0 && (
              <Button size="sm" variant="ghost" className="w-full mt-1" onClick={() => onChange([])}>
                {/* clear */}
                ×
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SessionDrawer({ session, onClose }: { session: Session | null; onClose: () => void }) {
  const t = useT();
  const [locating, setLocating] = useState(false);
  const [locateCool, setLocateCool] = useState(0);
  const [closing, setClosing] = useState(false);

  if (!session) return null;
  const closed = session.status === 'closed';

  async function locate() {
    if (!session) return;
    setLocating(true);
    try {
      const r = await api.locateSession(session.sessionId);
      if (r.ok) {
        let left = 30;
        setLocateCool(left);
        const tick = setInterval(() => {
          left -= 1;
          setLocateCool(left);
          if (left <= 0) { clearInterval(tick); setLocating(false); }
        }, 1000);
      } else {
        alert(t.sessions.locateFailed(r.error ?? 'unknown'));
        setLocating(false);
      }
    } catch (e: any) {
      alert(t.sessions.locateFailed(e?.message ?? String(e)));
      setLocating(false);
    }
  }

  async function closeSession() {
    if (!session) return;
    if (!confirm(t.sessions.confirmClose)) return;
    setClosing(true);
    try { await api.closeSession(session.sessionId); }
    finally { setClosing(false); onClose(); }
  }

  return (
    <Dialog open={!!session} onClose={onClose} maxWidth="max-w-2xl">
      <DialogHeader>{session.title ?? session.sessionId}</DialogHeader>
      <DialogBody>
        <KvLine label={t.sessions.drawer.sessionId} labelWidth="w-28" mono copy={session.sessionId}>{session.sessionId}</KvLine>
        <div className="flex gap-4 text-xs text-slate-600">
          <span><b className="text-slate-500">{t.sessions.drawer.bot}:</b> {session.botName ?? '-'}</span>
          <span><b className="text-slate-500">{t.sessions.drawer.cli}:</b> {session.cliId ?? '?'}</span>
          <span><b className="text-slate-500">{t.sessions.drawer.status}:</b> <StatusPill status={session.status} /></span>
        </div>
        <KvLine label={t.sessions.drawer.chatId} labelWidth="w-28" mono copy={session.chatId ?? ''}>{session.chatId ?? '—'}</KvLine>
        <KvLine label={t.sessions.drawer.rootMessageId} labelWidth="w-28" mono copy={session.rootMessageId ?? ''}>
          {session.rootMessageId ?? '—'}
        </KvLine>
        {session.threadId && <KvLine label={t.sessions.drawer.threadId} labelWidth="w-28" mono>{session.threadId}</KvLine>}
        <KvLine label={t.sessions.drawer.workingDir} labelWidth="w-28" mono>{session.workingDir ?? '—'}</KvLine>
      </DialogBody>
      <DialogFooter>
        <Button onClick={locate} disabled={locating || !session.chatId}>
          {locating && locateCool > 0
            ? t.sessions.drawer.locateCooldown(locateCool)
            : locating
              ? t.sessions.drawer.locating
              : t.sessions.drawer.locate}
        </Button>
        {session.webPort && (
          <a
            className="inline-flex items-center h-9 px-3.5 text-sm rounded-md border border-slate-300 bg-white hover:bg-slate-50"
            href={`http://${location.hostname}:${session.webPort}`}
            target="_blank"
            rel="noopener"
          >
            {t.sessions.drawer.openXterm}
          </a>
        )}
        {!closed && (
          <Button variant="destructive" onClick={closeSession} disabled={closing}>
            {closing ? t.sessions.drawer.closing : t.sessions.drawer.closeSession}
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>{t.common.close}</Button>
      </DialogFooter>
    </Dialog>
  );
}

