import { useMemo, useState } from 'react';
import { store, useStoreVersion } from '../store.js';
import { api } from '../api.js';
import { useT } from '../i18n.js';
import { Card } from '../components/ui/Card.js';
import { Input, Checkbox } from '../components/ui/Input.js';
import { Button } from '../components/ui/Button.js';
import { Dropdown } from '../components/ui/Dropdown.js';
import { Table, Thead, Tbody, Tr, Th, Td } from '../components/ui/Table.js';
import { fmtDate } from '../lib/utils.js';

export function SchedulesPage() {
  const version = useStoreVersion();
  const t = useT();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo(() => {
    const ql = q.toLowerCase();
    return [...store.schedules.values()]
      .filter((s) => !kind || s.parsed?.kind === kind)
      .filter((s) => !enabledOnly || s.enabled)
      .filter((s) => !ql || JSON.stringify(s).toLowerCase().includes(ql))
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        const aN = a.nextRunAt ? Date.parse(a.nextRunAt) : Infinity;
        const bN = b.nextRunAt ? Date.parse(b.nextRunAt) : Infinity;
        return aN - bN;
      });
  }, [version, q, kind, enabledOnly]);

  async function op(id: string, action: 'run' | 'pause' | 'resume') {
    setBusy(id + ':' + action);
    try {
      const r = await api.schedOp(id, action);
      if (!r.ok) alert(t.schedules.failed(r.error ?? ''));
    } catch (e: any) {
      alert(t.schedules.networkError(e?.message ?? String(e)));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            placeholder={t.schedules.searchPlaceholder}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-w-72 flex-1"
          />
          <Dropdown
            value={kind}
            onChange={setKind}
            placeholder={t.schedules.allKind}
            minWidth="min-w-32"
            options={[
              { value: '', label: t.schedules.allKind },
              { value: 'cron', label: 'cron' },
              { value: 'interval', label: 'interval' },
              { value: 'once', label: 'once' },
            ]}
          />
          <label className="flex items-center gap-1.5 text-sm text-slate-700 select-none cursor-pointer">
            <Checkbox checked={enabledOnly} onChange={(e) => setEnabledOnly(e.target.checked)} />
            {t.schedules.enabledOnly}
          </label>
          <span className="ml-auto text-xs text-slate-500">{t.schedules.count(rows.length)}</span>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <Table>
          <Thead>
            <Tr className="hover:bg-transparent">
              <Th>{t.schedules.cols.name}</Th>
              <Th>{t.schedules.cols.bot}</Th>
              <Th>{t.schedules.cols.schedule}</Th>
              <Th>{t.schedules.cols.next}</Th>
              <Th>{t.schedules.cols.last}</Th>
              <Th>{t.schedules.cols.repeat}</Th>
              <Th>{t.schedules.cols.enabled}</Th>
              <Th>{t.schedules.cols.actions}</Th>
            </Tr>
          </Thead>
          <Tbody>
            {rows.length === 0 && (
              <Tr className="hover:bg-transparent">
                <Td colSpan={8} className="text-center py-10 text-slate-400">{t.schedules.empty}</Td>
              </Tr>
            )}
            {rows.map((s) => (
              <Tr key={s.id}>
                <Td className="font-medium">{s.name ?? s.id}</Td>
                <Td className="text-slate-600">{s.botName ?? s.larkAppId ?? '-'}</Td>
                <Td>
                  <code className="px-1.5 py-0.5 rounded bg-slate-100 text-xs font-mono text-slate-700">
                    {s.parsed?.display ?? '?'}
                  </code>
                </Td>
                <Td className="text-xs text-slate-500">{fmtDate(s.nextRunAt)}</Td>
                <Td className="text-xs text-slate-500">
                  {fmtDate(s.lastRunAt)} {s.lastStatus === 'error' ? '⚠️' : ''}
                </Td>
                <Td className="text-xs text-slate-500">
                  {s.repeat ? `${s.repeat.completed}/${s.repeat.times ?? '∞'}` : '—'}
                </Td>
                <Td>
                  {s.enabled ? <span className="text-emerald-600">✓</span> : <span className="text-slate-300">✗</span>}
                </Td>
                <Td>
                  <div className="flex gap-1">
                    <Button size="sm" onClick={() => op(s.id, 'run')} disabled={busy === s.id + ':run'}>
                      {t.schedules.runNow}
                    </Button>
                    {s.enabled ? (
                      <Button size="sm" variant="outline" onClick={() => op(s.id, 'pause')} disabled={busy === s.id + ':pause'}>
                        {t.schedules.pause}
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => op(s.id, 'resume')} disabled={busy === s.id + ':resume'}>
                        {t.schedules.resume}
                      </Button>
                    )}
                  </div>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Card>
    </div>
  );
}
