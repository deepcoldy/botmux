import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type BotDefault } from '../api.js';
import { useT } from '../i18n.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card.js';
import { Input, Checkbox } from '../components/ui/Input.js';
import { Button } from '../components/ui/Button.js';
import { StatusText, type Status } from '../components/ui/StatusText.js';
import { Spinner } from '../components/ui/Spinner.js';
import { RefreshButton } from '../components/ui/RefreshButton.js';
import { BotAvatar } from '../components/ui/BotAvatar.js';
import { fmtDate } from '../lib/utils.js';

export function BotDefaultsPage() {
  const t = useT();
  const [q, setQ] = useState('');
  const [bots, setBots] = useState<BotDefault[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const body = await api.bots();
      setBots(body.bots ?? []);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setBots([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return bots.filter(
      (b) =>
        !ql ||
        (b.botName ?? '').toLowerCase().includes(ql) ||
        (b.larkAppId ?? '').toLowerCase().includes(ql),
    );
  }, [bots, q]);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            placeholder={t.botDefaults.searchPlaceholder}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-w-72 flex-1"
          />
          <RefreshButton onClick={reload} loading={loading} title={t.common.refresh} />
        </div>
      </Card>

      <Card className="p-4 bg-amber-50 border-amber-200">
        <p className="text-sm text-amber-900">{t.botDefaults.hint}</p>
      </Card>

      {err && (
        <Card className="p-4 bg-red-50 border-red-200 text-sm text-red-800 space-y-1">
          <div>{t.botDefaults.errorLoading(err)}</div>
          <div>{t.botDefaults.errorRetry}</div>
        </Card>
      )}

      {loading && bots.length === 0 && (
        <Card className="p-12 text-center"><Spinner label={t.common.loading} /></Card>
      )}

      {!err && !loading && filtered.length === 0 && (
        <Card className="p-10 text-center text-slate-400">{t.botDefaults.noBots}</Card>
      )}

      <div className="grid gap-3">
        {filtered.map((b) => (
          <BotCard
            key={b.larkAppId}
            bot={b}
            onUpdate={(patch) => {
              setBots((prev) => prev.map((x) => (x.larkAppId === b.larkAppId ? { ...x, ...patch } : x)));
            }}
          />
        ))}
      </div>
    </div>
  );
}

function BotCard({ bot, onUpdate }: { bot: BotDefault; onUpdate: (patch: Partial<BotDefault>) => void }) {
  const t = useT();
  const def = bot.defaultOncall ?? { enabled: false, workingDir: '', since: 0 };
  const [enabled, setEnabled] = useState(!!def.enabled);
  const [wd, setWd] = useState(def.workingDir ?? '');
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const avatarSrc = bot.botAvatarUrl ? `/api/bots/${encodeURIComponent(bot.larkAppId)}/avatar` : undefined;

  if (bot.error) {
    return (
      <Card className="border-amber-200 bg-amber-50/40">
        <CardHeader className="flex items-center gap-3">
          <BotAvatar src={avatarSrc} name={bot.botName ?? bot.larkAppId} size={32} />
          <div>
            <CardTitle>{bot.botName ?? bot.larkAppId}</CardTitle>
            <p className="font-mono text-[11px] text-slate-500">{bot.larkAppId}</p>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-amber-800 text-sm">{t.botDefaults.queryFailed(bot.error)}</p>
        </CardContent>
      </Card>
    );
  }

  async function save() {
    setStatus(null);
    const workingDir = wd.trim();
    if (enabled && !workingDir) {
      setStatus({ kind: 'err', text: t.botDefaults.wdRequired });
      return;
    }
    setBusy(true);
    try {
      const r = await api.setBotDefault(bot.larkAppId, { enabled, workingDir });
      if (r.ok) {
        setStatus({
          kind: 'ok',
          text: enabled ? t.botDefaults.savedOk(r.resolvedPath ?? '') : t.botDefaults.savedOkDisabled,
        });
        if (r.defaultOncall) onUpdate({ defaultOncall: r.defaultOncall });
      } else {
        setStatus({ kind: 'err', text: t.botDefaults.savedError(r.error ?? 'failed') });
      }
    } catch (e: any) {
      setStatus({ kind: 'err', text: t.botDefaults.savedError(e?.message ?? String(e)) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex items-center gap-3">
        <BotAvatar src={avatarSrc} name={bot.botName ?? bot.larkAppId} size={36} />
        <div className="flex items-baseline gap-3">
          <CardTitle>{bot.botName ?? bot.larkAppId}</CardTitle>
          <span className="font-mono text-[11px] text-slate-400">{bot.larkAppId}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Checkbox
            checked={enabled}
            onChange={(e) => { setEnabled(e.target.checked); setStatus(null); }}
          />
          <span className="text-sm">
            <strong>{t.botDefaults.toggle}</strong>{' '}
            <small className="text-slate-500">{t.botDefaults.toggleDesc}</small>
          </span>
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-slate-500">{t.botDefaults.workingDir}</span>
          <Input
            placeholder="e.g. /root/iserver/botmux"
            value={wd}
            onChange={(e) => { setWd(e.target.value); setStatus(null); }}
            disabled={!enabled}
            className="w-full font-mono text-xs"
          />
        </label>

        <div className="flex gap-4 text-[11px] text-slate-500">
          <span>{t.botDefaults.lastEnabled(fmtDate(bot.defaultOncall?.since ?? 0))}</span>
          <span>{t.botDefaults.autoboundCount(bot.autoboundChatCount ?? 0)}</span>
        </div>

        <div className="flex items-center gap-3">
          <StatusText status={status} />
          <Button onClick={save} disabled={busy} variant="primary" className="ml-auto">
            {busy ? t.botDefaults.saving : t.botDefaults.save}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
