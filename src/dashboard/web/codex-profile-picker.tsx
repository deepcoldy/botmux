import { useEffect, useMemo, useState } from 'react';
import type { CodexProfileCatalog } from '../../services/codex-profiles.js';
import { DropdownField } from './field-controls.js';
import { useT } from './react-hooks.js';

export function CodexProfilePicker(props: {
  appId: string; contextKey: unknown; value: string; disabled?: boolean; launchChanged?: boolean;
  onChange(value: string): void;
}) {
  const tr = useT();
  const [refresh, setRefresh] = useState(0);
  const key = useMemo(() => ({ appId: props.appId, context: props.contextKey, refresh }), [props.appId, props.contextKey, refresh]);
  const [loaded, setLoaded] = useState<{ key: typeof key; catalog: CodexProfileCatalog }>();
  const catalog = loaded?.key === key ? loaded.catalog : undefined;
  useEffect(() => {
    let stale = false;
    const abort = new AbortController();
    fetch(`/api/bots/${encodeURIComponent(props.appId)}/codex-profiles`, { signal: abort.signal })
      .then(async response => {
        if (!response.ok) throw new Error('scan_failed');
        const body = await response.json();
        if (body.larkAppId !== props.appId || !Array.isArray(body.candidates)) throw new Error('scan_failed');
        if (!stale) setLoaded({ key, catalog: body });
      }).catch(() => {
        if (!stale) setLoaded({ key, catalog: { status: 'scan_failed', candidates: [], error: 'scan_failed' } });
      });
    return () => { stale = true; abort.abort(); };
  }, [key]);
  const missing = !!props.value && !!catalog && !catalog.candidates.some(p => p.name === props.value && p.available);
  // Catalog-level failures carry a machine code; show a localized reason while
  // keeping the code in parentheses for diagnostics. Unknown codes still render.
  const errorDetail = (code: string): string => {
    const map: Record<string, string> = {
      unsupported_launch: tr('botDefaults.codexProfileErrorUnsupportedLaunch'),
      unsupported_rpc: tr('botDefaults.codexProfileErrorUnsupportedRpc'),
      unsupported_service_tier: tr('botDefaults.codexProfileErrorUnsupportedServiceTier'),
      capability_unconfirmed: tr('botDefaults.codexProfileErrorCapabilityUnconfirmed'),
      version_unknown: tr('botDefaults.codexProfileErrorVersionUnknown'),
      parameter_unsupported: tr('botDefaults.codexProfileErrorParameterUnsupported'),
      binary_unavailable: tr('botDefaults.codexProfileErrorBinaryUnavailable'),
      not_found: tr('botDefaults.codexProfileErrorNotFound'),
      unreadable: tr('botDefaults.codexProfileErrorUnreadable'),
      scan_failed: tr('botDefaults.codexProfileErrorScanFailed'),
      home_must_be_absolute: tr('botDefaults.codexProfileErrorHomeAbsolute'),
      instance_unavailable: tr('botDefaults.codexProfileErrorInstanceUnavailable'),
    };
    const text = map[code];
    return text ? `${text} (${code})` : code;
  };
  return <div className="bd-row bd-codex-profile" data-section="codex-profile">
    <label>Codex profile</label>
    <div className="bd-codex-profile-controls">
    <DropdownField className={missing ? 'codex-profile-unavailable' : undefined} dataInput="codexProfile" ariaLabel="Codex profile" searchable
      value={props.value} disabled={props.disabled}
      options={[
        { value: '', label: tr('botDefaults.codexProfileNone') },
        ...(props.value && !catalog?.candidates.some(p => p.name === props.value)
          ? [{ value: props.value, label: props.value, disabled: true }] : []),
        ...(catalog?.candidates ?? []).map(p => ({ value: p.name, label: p.name, disabled: !p.available || props.launchChanged })),
      ]} onChange={props.onChange} />
    <button type="button" data-action="refresh-codex-profiles" disabled={props.disabled} onClick={() => setRefresh(n => n + 1)}>{tr('botDefaults.codexProfileRefresh')}</button>
    </div>
    <p className={`bd-aux-note ${missing || (catalog && !['ok', 'empty'].includes(catalog.status)) ? 'bd-aux-err' : ''}`} role="status">
      {catalog ? tr(`botDefaults.codexProfileStatus.${catalog.status}`) : tr('botDefaults.codexProfileLoading')}
      {catalog?.error ? ` · ${errorDetail(catalog.error)}` : ''}
      {missing ? ` · ${tr('botDefaults.codexProfileMissing')}: ${props.value}` : ''}
    </p>
    {catalog && <p className="bd-aux-note" style={{ overflowWrap: 'anywhere' }}>Codex {catalog.version ?? '—'} · {catalog.format === 'files' ? tr('botDefaults.codexProfileFiles') : catalog.format === 'legacy' ? tr('botDefaults.codexProfileLegacy') : '—'} · {catalog.source ?? '—'}</p>}
    {catalog?.status === 'empty' && <p className="bd-aux-note">{tr('botDefaults.codexProfileEmptyHint', { source: catalog.source ?? '~/.codex' })}</p>}
    {props.launchChanged && <p className="bd-aux-note bd-aux-err">{tr('botDefaults.codexProfileSaveLaunch')}</p>}
    <p className="bd-aux-note">{tr('botDefaults.codexProfileHelp')}</p>
    <p className="bd-aux-note">{tr('botDefaults.codexProfileScope')}</p>
  </div>;
}
