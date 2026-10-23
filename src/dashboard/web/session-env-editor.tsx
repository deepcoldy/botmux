import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { parsePerBotEnvText, sanitizePerBotEnv, sessionEnvLock } from '../../core/per-bot-env.js';
import { ENV_NAME_RE, MAX_SESSION_ENV_LAYER_BYTES, type EnvOp, type SessionEnvRow } from '../../core/session-env.js';
import { confirm } from './confirm-modal.js';
import { sendJson } from './dashboard-api.js';
import { FieldTitle } from './dashboard-components.js';
import { ModalDialog } from './modal-dialog.js';
import { useT } from './react-hooks.js';

/**
 * 「会话环境变量」编辑器（core/session-env.ts）：全局层放在「设置」，Bot 层放在
 * 「Bot 配置 → 运行环境」，同一个组件。表格里的值都是服务端打码后的；👁 单独请求
 * 一个变量的原文（只有本机 owner 有权限，canReveal）。
 */

export type SessionEnvScope =
  | { kind: 'global' }
  | { kind: 'bot'; larkAppId: string; onPolicySaved?(policy: SessionEnvPolicy): void };

export interface SessionEnvPolicy { mode: 'inherit' | 'strict'; inherit?: string[] }

interface SessionInfo {
  sessionId: string;
  larkAppId: string;
  title: string;
  backendType: string;
  tmuxSocket?: string | null;
  stale: boolean | null;
  botName?: string;
}

interface TmuxServerView {
  socket: string | null;
  managed: boolean;
  found: boolean;
  vars: Array<{ key: string; value: string; masked?: boolean }>;
}

interface ScopeView {
  ok?: boolean;
  scope: 'global' | 'bot';
  rows: SessionEnvRow[];
  reserved: { keys: string[]; prefixes: string[] };
  redactedHostKeys: string[];
  conflicts: string[];
  canReveal?: boolean;
  sessions?: SessionInfo[];
  // bot scope
  inherit?: SessionEnvPolicy;
  notInheritedKeys?: string[];
  backendType?: string;
  overlayApplies?: boolean;
  identityLockedKeys?: string[];
  identityIgnoredKeys?: string[];
  // global scope
  tmuxServers?: TmuxServerView[];
}

const SHELL_WRAPPED_BACKENDS = new Set(['tmux', 'zellij', 'zmx']);

function scopeUrl(scope: SessionEnvScope): string {
  return scope.kind === 'global' ? '/api/session-env' : `/api/bots/${encodeURIComponent(scope.larkAppId)}/session-env`;
}

/** 一个值单元：打码值 + 👁（有权限时）切换原文。原文只留在本组件状态里。 */
function EnvValue(props: { value?: string; masked?: boolean; canReveal?: boolean; reveal(): Promise<string | undefined>; struck?: boolean }) {
  const tr = useT();
  const [raw, setRaw] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRaw(undefined); }, [props.value]);
  const shown = raw ?? props.value ?? '';
  return (
    <span className={`se-value${props.struck ? ' is-struck' : ''}`}>
      <code title={raw === undefined ? undefined : shown}>{shown || <em className="muted">{tr('sessionEnv.emptyValue')}</em>}</code>
      {props.masked && props.canReveal && (
        <button
          type="button"
          className="se-reveal"
          data-action="reveal-env"
          aria-label={raw === undefined ? tr('sessionEnv.reveal') : tr('sessionEnv.hide')}
          title={raw === undefined ? tr('sessionEnv.reveal') : tr('sessionEnv.hide')}
          disabled={busy}
          onClick={async () => {
            if (raw !== undefined) { setRaw(undefined); return; }
            setBusy(true);
            try { setRaw(await props.reveal()); } finally { setBusy(false); }
          }}
        >{raw === undefined ? '👁' : '🙈'}</button>
      )}
    </span>
  );
}

async function fetchReveal(url: string): Promise<string | undefined> {
  const res = await sendJson('GET', url);
  return res.ok && typeof res.body?.value === 'string' ? res.body.value : undefined;
}

function sourceLabel(tr: ReturnType<typeof useT>, row: Pick<SessionEnvRow, 'source' | 'state'>): string {
  if (row.source === 'host') return tr('sessionEnv.sourceHost');
  if (row.source === 'global') return tr(row.state === 'unset' ? 'sessionEnv.sourceGlobalUnset' : 'sessionEnv.sourceGlobalSet');
  return tr(row.state === 'unset' ? 'sessionEnv.sourceBotUnset' : 'sessionEnv.sourceBotSet');
}

type EditDraft = { op: 'set' | 'unset'; key: string; value: string; keyEditable: boolean };

function EditDialog(props: { draft: EditDraft | null; busy: boolean; identityLocked: readonly string[]; onCancel(): void; onSubmit(draft: EditDraft): void }) {
  const tr = useT();
  const [draft, setDraft] = useState<EditDraft | null>(props.draft);
  useEffect(() => { setDraft(props.draft); }, [props.draft]);
  const key = draft?.key.trim() ?? '';
  const lock = key ? sessionEnvLock(key) : null;
  const keyError = !key ? null
    : !ENV_NAME_RE.test(key) ? tr('sessionEnv.errorInvalidKey')
      : lock === 'reserved' || props.identityLocked.includes(key) ? tr('sessionEnv.errorReservedKey', { key })
        : draft?.op === 'unset' && lock === 'no-unset' ? tr('sessionEnv.errorUnsetForbidden', { key })
          : null;
  return (
    <ModalDialog open={!!props.draft} className="se-dialog" onRequestClose={props.onCancel} backdropClose={false}>
      {draft && (
        <form method="dialog" onSubmit={(event) => { event.preventDefault(); if (key && !keyError) props.onSubmit({ ...draft, key }); }}>
          <h3>{draft.op === 'set' ? tr('sessionEnv.setTitle') : tr('sessionEnv.unsetTitle')}</h3>
          <label className="se-field">
            <span>{tr('sessionEnv.keyLabel')}</span>
            <input
              data-input="session-env-key"
              value={draft.key}
              readOnly={!draft.keyEditable}
              autoComplete="off"
              spellCheck={false}
              placeholder="HTTPS_PROXY"
              onChange={e => setDraft({ ...draft, key: e.currentTarget.value })}
            />
          </label>
          {draft.op === 'set' && (
            <label className="se-field">
              <span>{tr('sessionEnv.valueLabel')}</span>
              <textarea
                data-input="session-env-value"
                rows={3}
                value={draft.value}
                autoComplete="off"
                spellCheck={false}
                onChange={e => setDraft({ ...draft, value: e.currentTarget.value })}
              />
            </label>
          )}
          {draft.op === 'unset' && <p className="muted">{tr('sessionEnv.unsetHint')}</p>}
          {keyError && <p className="is-error">{keyError}</p>}
          <div className="actions">
            <button type="button" onClick={props.onCancel} disabled={props.busy}>{tr('sessionEnv.cancel')}</button>
            <button type="submit" className="primary" data-action="submit-session-env" disabled={props.busy || !key || !!keyError}>{tr('sessionEnv.save')}</button>
          </div>
        </form>
      )}
    </ModalDialog>
  );
}

/** 批量粘贴：沿用 Bot env 编辑器认的格式（JSON / .env / export / env \ 启动脚本），全部当「设置」。 */
function PasteDialog(props: { open: boolean; busy: boolean; identityLocked: readonly string[]; onCancel(): void; onSubmit(ops: EnvOp[]): void }) {
  const tr = useT();
  const [text, setText] = useState('');
  useEffect(() => { if (!props.open) setText(''); }, [props.open]);
  const parsed = useMemo(() => text.trim() ? parsePerBotEnvText(text) : null, [text]);
  const sanitized = parsed?.ok ? sanitizePerBotEnv(parsed.env) : {};
  const blocked = parsed?.ok
    ? Object.keys(parsed.env).filter(k => sessionEnvLock(k) === 'reserved' || props.identityLocked.includes(k))
    : [];
  const error = parsed && !parsed.ok
    ? parsed.reason === 'invalid_json' ? tr('botDefaults.envParseInvalidJson')
      : parsed.line ? tr('botDefaults.envParseInvalidLine', { line: parsed.line }) : tr('botDefaults.envParseNoAssignment')
    : null;
  const savable = !!parsed?.ok && blocked.length === 0 && Object.keys(sanitized).length > 0;
  return (
    <ModalDialog open={props.open} className="se-dialog" onRequestClose={props.onCancel} backdropClose={false}>
      <form method="dialog" onSubmit={(event) => {
        event.preventDefault();
        if (savable) props.onSubmit(Object.entries(sanitized).map(([key, value]) => ({ op: 'set', key, value })));
      }}>
        <h3>{tr('sessionEnv.pasteTitle')}</h3>
        <textarea
          data-input="session-env-paste"
          rows={8}
          value={text}
          spellCheck={false}
          autoComplete="off"
          placeholder={tr('botDefaults.envPlaceholder')}
          onChange={e => setText(e.currentTarget.value)}
        />
        {error && <p className="is-error">{error}</p>}
        {parsed?.ok && (
          <p className="muted" data-env-preview="">
            {tr('sessionEnv.pastePreview', { count: Object.keys(sanitized).length, names: Object.keys(sanitized).join(', ') })}
          </p>
        )}
        {blocked.length > 0 && <p className="is-error">{tr('botDefaults.envReservedBlocked', { keys: blocked.join(', ') })}</p>}
        <div className="actions">
          <button type="button" onClick={props.onCancel} disabled={props.busy}>{tr('sessionEnv.cancel')}</button>
          <button type="submit" className="primary" data-action="submit-session-env-paste" disabled={props.busy || !savable}>{tr('sessionEnv.save')}</button>
        </div>
      </form>
    </ModalDialog>
  );
}

function opsErrorText(tr: ReturnType<typeof useT>, body: any): string {
  const key = typeof body?.key === 'string' ? body.key : '';
  switch (body?.error) {
    case 'reserved_key': return tr('sessionEnv.errorReservedKey', { key });
    case 'unset_forbidden': return tr('sessionEnv.errorUnsetForbidden', { key });
    case 'invalid_key': return tr('sessionEnv.errorInvalidKey');
    case 'invalid_value': return tr('sessionEnv.errorInvalidValue', { key });
    case 'layer_too_large': return tr('sessionEnv.errorLayerTooLarge', { max: MAX_SESSION_ENV_LAYER_BYTES });
    case 'owner_required': return tr('sessionEnv.errorOwnerRequired');
    case 'daemon_offline': return tr('sessionEnv.errorDaemonOffline');
    default: return String(body?.reason ?? body?.error ?? 'error');
  }
}

/** 继承方式（即原来的 envPolicy）：放在 Bot 层表格上方。 */
function InheritControl(props: { larkAppId: string; policy: SessionEnvPolicy; onSaved(policy: SessionEnvPolicy): void }) {
  const tr = useT();
  const [mode, setMode] = useState(props.policy.mode);
  const [names, setNames] = useState((props.policy.inherit ?? []).join(', '));
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setMode(props.policy.mode);
    setNames((props.policy.inherit ?? []).join(', '));
    setStatus(null);
  }, [props.larkAppId, props.policy]);
  const dirty = mode !== props.policy.mode || (mode === 'strict' && names !== (props.policy.inherit ?? []).join(', '));
  async function save() {
    const envPolicy: SessionEnvPolicy = { mode, ...(mode === 'strict' ? { inherit: names.split(/[\s,]+/).filter(Boolean) } : {}) };
    setBusy(true);
    try {
      const res = await sendJson('PUT', `/api/bots/${encodeURIComponent(props.larkAppId)}/env-policy`, { envPolicy });
      if (res.ok) { setStatus(tr('botDefaults.envPolicySaved')); props.onSaved(envPolicy); }
      else setStatus(tr('botDefaults.envPolicyInvalid'));
    } catch { setStatus(tr('botDefaults.envPolicyInvalid')); }
    finally { setBusy(false); }
  }
  return (
    <div className="se-inherit">
      <FieldTitle help={tr('botDefaults.envPolicyHelp')}>{tr('sessionEnv.inheritLabel')}</FieldTitle>
      <select data-input="envPolicyMode" value={mode} disabled={busy} onChange={e => setMode(e.currentTarget.value as 'inherit' | 'strict')}>
        <option value="inherit">{tr('botDefaults.envPolicyInherit')}</option>
        <option value="strict">{tr('botDefaults.envPolicyStrict')}</option>
      </select>
      {mode === 'strict' && (
        <input data-input="envPolicyNames" value={names} disabled={busy} placeholder="HTTPS_PROXY, NODE_EXTRA_CA_CERTS" onChange={e => setNames(e.currentTarget.value)} />
      )}
      {dirty && <button type="button" className="primary" data-action="save-env-policy" disabled={busy} onClick={() => void save()}>{tr('botDefaults.envPolicySave')}</button>}
      {status && <span className="muted" role="status">{status}</span>}
    </div>
  );
}

function StaleSessions(props: { sessions: SessionInfo[]; showBot: boolean; onOpen(s: SessionInfo): void }) {
  const tr = useT();
  const stale = props.sessions.filter(s => s.stale === true);
  if (!stale.length) return null;
  return (
    <details className="se-stale" data-session-env-stale="">
      <summary>{tr('sessionEnv.staleBanner', { count: stale.length })}</summary>
      <ul>
        {stale.map(s => (
          <li key={s.sessionId}>
            <span className="se-stale-title">{s.title}</span>
            {props.showBot && s.botName && <span className="muted"> · {s.botName}</span>}
            <span className="muted"> · {s.backendType}{s.tmuxSocket !== undefined ? ` (${s.tmuxSocket ?? 'default'})` : ''}</span>
            <button type="button" className="se-link" data-action="open-live-env" onClick={() => props.onOpen(s)}>{tr('sessionEnv.viewLive')}</button>
          </li>
        ))}
      </ul>
    </details>
  );
}

function TmuxServers(props: { servers: TmuxServerView[]; sessions: SessionInfo[]; canReveal: boolean; onChanged(): void }) {
  const tr = useT();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function remove(server: TmuxServerView, key: string) {
    const ok = await confirm({
      title: tr('sessionEnv.tmuxRemoveTitle'),
      message: tr(server.socket === null ? 'sessionEnv.tmuxRemoveConfirmDefault' : 'sessionEnv.tmuxRemoveConfirm', { key, server: server.socket ?? 'default' }),
      danger: true,
    });
    if (!ok) return;
    setBusyKey(`${server.socket}:${key}`);
    setError(null);
    try {
      const res = await sendJson('POST', '/api/session-env/tmux/remove', { socket: server.socket, key });
      if (!res.ok) setError(opsErrorText(tr, res.body));
      props.onChanged();
    } finally { setBusyKey(null); }
  }
  return (
    <div className="se-tmux" data-session-env-tmux="">
      <h4 className="bd-subsection-title">
        <FieldTitle help={tr('sessionEnv.tmuxHelp')}>{tr('sessionEnv.tmuxTitle')}</FieldTitle>
      </h4>
      {error && <p className="is-error">{error}</p>}
      {props.servers.map(server => {
        const running = props.sessions.filter(s => s.tmuxSocket !== undefined && (s.tmuxSocket ?? null) === server.socket).length;
        return (
          <details key={server.socket ?? 'default'} className="se-tmux-server" open={server.managed}>
            <summary>
              <code>{server.socket === null ? 'tmux' : `tmux -L ${server.socket}`}</code>
              {' '}{server.socket === null ? tr('sessionEnv.tmuxDefaultServer') : tr('sessionEnv.tmuxManagedSocket')}
              {server.managed && <span className="se-badge is-managed">{tr('sessionEnv.tmuxManagedBadge')}</span>}
              <span className="muted"> · {server.found ? tr('sessionEnv.tmuxVarCount', { count: server.vars.length, sessions: running }) : tr('sessionEnv.tmuxNotRunning')}</span>
            </summary>
            {server.found && (
              <table className="se-table">
                <tbody>
                  {server.vars.map(v => (
                    <tr key={v.key}>
                      <td><code>{v.key}</code></td>
                      <td>
                        <EnvValue
                          value={v.value}
                          masked={v.masked}
                          canReveal={props.canReveal}
                          reveal={() => fetchReveal(`/api/session-env/reveal?source=tmux&socket=${encodeURIComponent(server.socket ?? 'default')}&key=${encodeURIComponent(v.key)}`)}
                        />
                      </td>
                      <td className="se-actions">
                        {props.canReveal && (
                          <button type="button" className="se-link is-danger" data-action="tmux-remove-env" disabled={busyKey !== null} onClick={() => void remove(server, v.key)}>
                            {tr('sessionEnv.tmuxRemove')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </details>
        );
      })}
    </div>
  );
}

export function SessionEnvEditor(props: { scope: SessionEnvScope }): React.JSX.Element {
  const tr = useT();
  const { scope } = props;
  const url = scopeUrl(scope);
  const [view, setView] = useState<ScopeView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; ok?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [pasting, setPasting] = useState(false);
  const [live, setLive] = useState<SessionInfo | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await sendJson('GET', url);
      if (res.ok) { setView(res.body as ScopeView); setLoadError(null); }
      else setLoadError(opsErrorText(tr, res.body));
    } catch (e: any) { setLoadError(e?.message ?? String(e)); }
  }, [url, tr]);

  useEffect(() => { setView(null); setStatus(null); setDraft(null); void load(); }, [load]);

  async function apply(ops: EnvOp[]): Promise<boolean> {
    setBusy(true);
    setStatus(null);
    try {
      const res = await sendJson('PUT', url, { ops });
      if (!res.ok) { setStatus({ text: `✗ ${opsErrorText(tr, res.body)}` }); return false; }
      setView(res.body as ScopeView);
      setStatus({ text: `✓ ${tr('sessionEnv.saved')}`, ok: true });
      return true;
    } catch (e: any) {
      setStatus({ text: `✗ ${e?.message ?? String(e)}` });
      return false;
    } finally { setBusy(false); }
  }

  const layer = scope.kind;
  const canReveal = view?.canReveal === true;
  const revealUrl = (key: string) => `${url}/reveal?key=${encodeURIComponent(key)}`;
  const rows = useMemo(() => {
    const needle = filter.trim().toUpperCase();
    return (view?.rows ?? []).filter(r => (!needle || r.key.toUpperCase().includes(needle)) && (!onlyChanged || r.state !== 'inherited'));
  }, [view, filter, onlyChanged]);

  if (loadError) return <p className="is-error" data-session-env-error="">{loadError}</p>;
  if (!view) return <p className="muted">{tr('sessionEnv.loading')}</p>;

  const shellWrapped = scope.kind === 'global' || SHELL_WRAPPED_BACKENDS.has(view.backendType ?? '');
  return (
    <div className="se-editor" data-session-env={layer}>
      {scope.kind === 'bot' && view.inherit && (
        <InheritControl
          larkAppId={scope.larkAppId}
          policy={view.inherit}
          onSaved={(policy) => { scope.onPolicySaved?.(policy); void load(); }}
        />
      )}
      <p className="muted se-intro">{tr(scope.kind === 'global' ? 'sessionEnv.introGlobal' : 'sessionEnv.introBot')}</p>
      {view.overlayApplies === false && <p className="is-warning">{tr('sessionEnv.remoteBackendNote', { backend: view.backendType ?? '' })}</p>}
      {!!view.identityIgnoredKeys?.length && (
        <p className="is-warning">{tr('sessionEnv.identityIgnored', { keys: view.identityIgnoredKeys.join(', ') })}</p>
      )}
      {view.conflicts.length > 0 && <p className="is-warning">{tr('sessionEnv.conflicts', { keys: view.conflicts.join(', ') })}</p>}
      <StaleSessions sessions={view.sessions ?? []} showBot={scope.kind === 'global'} onOpen={setLive} />

      <div className="se-toolbar">
        <input
          type="search"
          data-input="session-env-filter"
          placeholder={tr('sessionEnv.filterPlaceholder')}
          value={filter}
          onChange={e => setFilter(e.currentTarget.value)}
        />
        <label className="se-only-changed">
          <input type="checkbox" checked={onlyChanged} onChange={e => setOnlyChanged(e.currentTarget.checked)} />
          <span>{tr('sessionEnv.onlyChanged')}</span>
        </label>
        <span className="se-toolbar-spacer" />
        <button type="button" data-action="add-session-env" disabled={busy} onClick={() => setDraft({ op: 'set', key: '', value: '', keyEditable: true })}>{tr('sessionEnv.add')}</button>
        <button type="button" data-action="unset-session-env" disabled={busy} onClick={() => setDraft({ op: 'unset', key: '', value: '', keyEditable: true })}>{tr('sessionEnv.removeByName')}</button>
        <button type="button" data-action="paste-session-env" disabled={busy} onClick={() => setPasting(true)}>{tr('sessionEnv.paste')}</button>
      </div>
      {status && <p className={status.ok ? 'is-ok' : 'is-error'} role="status">{status.text}</p>}

      <table className="se-table" data-session-env-table="">
        <thead>
          <tr>
            <th>{tr('sessionEnv.colKey')}</th>
            <th>{tr('sessionEnv.colValue')}</th>
            <th>{tr('sessionEnv.colSource')}</th>
            <th className="se-actions">{tr('sessionEnv.colActions')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const ownEntry = row.entry;
            const lowerText = row.lower ? `${sourceLabel(tr, row.lower)}${row.lower.value !== undefined ? `: ${row.lower.value}` : ''}` : '';
            return (
              <tr key={row.key} data-env-row={row.key} data-env-source={row.source} data-env-state={row.state}>
                <td><code>{row.key}</code></td>
                <td>
                  <EnvValue
                    value={row.value}
                    masked={row.masked}
                    canReveal={canReveal}
                    struck={row.state === 'unset'}
                    reveal={() => fetchReveal(revealUrl(row.key))}
                  />
                  {row.state === 'unset' && <span className="se-note">{tr('sessionEnv.removedNote')}</span>}
                  {lowerText && row.state === 'set' && <span className="se-note" title={lowerText}>{tr('sessionEnv.overrides', { lower: lowerText })}</span>}
                </td>
                <td><span className={`se-badge is-${row.source}${row.state === 'unset' ? ' is-unset' : ''}`}>{sourceLabel(tr, row)}</span></td>
                <td className="se-actions"><div className="se-actions-inner">
                  {ownEntry === 'set' && (
                    <button type="button" className="se-link" data-action="edit-session-env" disabled={busy}
                      onClick={() => setDraft({ op: 'set', key: row.key, value: row.masked ? '' : row.value ?? '', keyEditable: false })}>
                      {tr('sessionEnv.edit')}
                    </button>
                  )}
                  {ownEntry && (
                    <button type="button" className="se-link" data-action="reset-session-env" disabled={busy}
                      onClick={() => void apply([{ op: 'reset', key: row.key }])}>
                      {tr('sessionEnv.restore')}
                    </button>
                  )}
                  {!ownEntry && row.state !== 'unset' && (
                    <button type="button" className="se-link" data-action="override-session-env" disabled={busy}
                      onClick={() => setDraft({ op: 'set', key: row.key, value: row.masked ? '' : row.value ?? '', keyEditable: false })}>
                      {tr('sessionEnv.override')}
                    </button>
                  )}
                  {!ownEntry && row.state === 'unset' && (
                    <button type="button" className="se-link" data-action="override-session-env" disabled={busy}
                      onClick={() => setDraft({ op: 'set', key: row.key, value: '', keyEditable: false })}>
                      {tr('sessionEnv.setHere')}
                    </button>
                  )}
                  {ownEntry !== 'unset' && row.state !== 'unset' && row.lock !== 'no-unset' && (
                    <button type="button" className="se-link is-danger" data-action="remove-session-env" disabled={busy}
                      onClick={() => void apply([{ op: 'unset', key: row.key }])}>
                      {tr('sessionEnv.remove')}
                    </button>
                  )}
                </div></td>
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={4} className="muted">{tr('sessionEnv.noRows')}</td></tr>}
        </tbody>
      </table>

      <details className="se-locked" data-session-env-reserved="">
        <summary>🔒 {tr('sessionEnv.reservedTitle', { count: view.reserved.keys.length + view.reserved.prefixes.length + (view.identityLockedKeys?.length ?? 0) })}</summary>
        <p className="muted">{tr('sessionEnv.reservedHelp')}</p>
        <ul className="bd-env-chips">
          {view.reserved.prefixes.map(p => <li key={`p:${p}`} className="bd-env-chip"><code>{p}*</code></li>)}
          {view.reserved.keys.map(k => <li key={k} className="bd-env-chip"><code>{k}</code></li>)}
        </ul>
        {!!view.identityLockedKeys?.length && (
          <>
            <p className="muted">{tr('sessionEnv.identityLockedHelp')}</p>
            <ul className="bd-env-chips">
              {view.identityLockedKeys.map(k => <li key={k} className="bd-env-chip"><code>{k}</code></li>)}
            </ul>
          </>
        )}
      </details>
      {view.redactedHostKeys.length > 0 && (
        <details className="se-locked" data-session-env-redacted="">
          <summary>🔒 {tr('sessionEnv.redactedTitle', { count: view.redactedHostKeys.length })}</summary>
          <p className="muted">{tr('sessionEnv.redactedHelp')}</p>
          <ul className="bd-env-chips">{view.redactedHostKeys.map(k => <li key={k} className="bd-env-chip"><code>{k}</code></li>)}</ul>
        </details>
      )}
      {!!view.notInheritedKeys?.length && (
        <details className="se-locked">
          <summary>{tr('sessionEnv.notInheritedTitle', { count: view.notInheritedKeys.length })}</summary>
          <ul className="bd-env-chips">{view.notInheritedKeys.map(k => <li key={k} className="bd-env-chip"><code>{k}</code></li>)}</ul>
        </details>
      )}
      {shellWrapped && <p className="muted se-intro">ⓘ {tr('sessionEnv.shellNote')}</p>}
      <p className="muted se-intro">ⓘ {tr('sessionEnv.cliConfigNote')}</p>
      {!canReveal && <p className="muted se-intro">{tr('sessionEnv.revealOwnerOnly')}</p>}

      {scope.kind === 'global' && view.tmuxServers && (
        <TmuxServers servers={view.tmuxServers} sessions={view.sessions ?? []} canReveal={canReveal} onChanged={() => void load()} />
      )}

      <EditDialog
        draft={draft}
        busy={busy}
        identityLocked={view.identityLockedKeys ?? []}
        onCancel={() => setDraft(null)}
        onSubmit={async (d) => {
          const ok = await apply([d.op === 'set' ? { op: 'set', key: d.key, value: d.value } : { op: 'unset', key: d.key }]);
          if (ok) setDraft(null);
        }}
      />
      <PasteDialog
        open={pasting}
        busy={busy}
        identityLocked={view.identityLockedKeys ?? []}
        onCancel={() => setPasting(false)}
        onSubmit={async (ops) => { if (await apply(ops)) setPasting(false); }}
      />
      <SessionEnvLiveModal
        open={!!live}
        larkAppId={live?.larkAppId ?? ''}
        sessionId={live?.sessionId ?? ''}
        title={live?.title}
        onClose={() => setLive(null)}
      />
    </div>
  );
}

// ─── 运行中会话的实际环境 ────────────────────────────────────────────────────

interface LiveRow { key: string; value: string; masked?: boolean; source: string; drift?: 'unset' | 'changed' }
interface LiveView {
  ok: boolean;
  error?: string;
  pid?: number;
  backendType?: string;
  tmuxSocket?: string | null;
  stale?: boolean | null;
  rows?: LiveRow[];
  missingSetKeys?: string[];
  canReveal?: boolean;
}

const LIVE_SOURCE_KEYS: Record<string, string> = {
  reserved: 'sessionEnv.liveSourceReserved',
  bot: 'sessionEnv.sourceBotSet',
  global: 'sessionEnv.sourceGlobalSet',
  host: 'sessionEnv.sourceHost',
  'tmux-server': 'sessionEnv.liveSourceTmux',
  other: 'sessionEnv.liveSourceOther',
};

export function SessionEnvLiveModal(props: { open: boolean; larkAppId: string; sessionId: string; title?: string; onClose(): void }): React.JSX.Element {
  const tr = useT();
  const [view, setView] = useState<LiveView | null>(null);
  const [filter, setFilter] = useState('');
  const base = `/api/bots/${encodeURIComponent(props.larkAppId)}/sessions/${encodeURIComponent(props.sessionId)}/env`;
  useEffect(() => {
    if (!props.open) { setView(null); setFilter(''); return; }
    let cancelled = false;
    void sendJson('GET', base).then(res => { if (!cancelled) setView({ ...(res.body as LiveView), ok: res.ok }); })
      .catch((e: any) => { if (!cancelled) setView({ ok: false, error: e?.message ?? String(e) }); });
    return () => { cancelled = true; };
  }, [props.open, base]);
  const needle = filter.trim().toUpperCase();
  const rows = (view?.rows ?? []).filter(r => !needle || r.key.toUpperCase().includes(needle));
  return (
    <ModalDialog open={props.open} className="se-dialog se-live" onRequestClose={props.onClose}>
      <div className="se-live-head">
        <h3>{tr('sessionEnv.liveTitle')}{props.title ? ` · ${props.title}` : ''}</h3>
        <button type="button" onClick={props.onClose}>{tr('sessionEnv.close')}</button>
      </div>
      {!view && <p className="muted">{tr('sessionEnv.loading')}</p>}
      {view && !view.ok && <p className="is-warning" data-live-env-error={view.error ?? ''}>{tr(`sessionEnv.liveError.${view.error ?? 'unknown'}`)}</p>}
      {view?.ok && (
        <>
          <p className="muted">
            {tr('sessionEnv.liveMeta', { backend: view.backendType ?? '', pid: view.pid ?? '' })}
            {view.tmuxSocket !== undefined && ` · ${view.tmuxSocket === null ? 'tmux' : `tmux -L ${view.tmuxSocket}`}`}
          </p>
          {view.stale === true && <p className="is-warning" data-live-env-stale="">{tr('sessionEnv.liveStale')}</p>}
          {view.stale === null && <p className="muted" data-live-env-unrecorded="">{tr('sessionEnv.liveUnrecorded')}</p>}
          {!!view.missingSetKeys?.length && <p className="is-warning">{tr('sessionEnv.liveMissing', { keys: view.missingSetKeys.join(', ') })}</p>}
          <input type="search" placeholder={tr('sessionEnv.filterPlaceholder')} value={filter} onChange={e => setFilter(e.currentTarget.value)} />
          <table className="se-table" data-live-env-table="">
            <thead>
              <tr><th>{tr('sessionEnv.colKey')}</th><th>{tr('sessionEnv.colValue')}</th><th>{tr('sessionEnv.colSource')}</th></tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.key} data-env-row={row.key} data-env-source={row.source}>
                  <td><code>{row.source === 'reserved' ? '🔒 ' : ''}{row.key}</code></td>
                  <td>
                    <EnvValue value={row.value} masked={row.masked} canReveal={view.canReveal === true}
                      reveal={() => fetchReveal(`${base}/reveal?key=${encodeURIComponent(row.key)}`)} />
                    {row.drift && <span className="se-note is-warning">{tr(row.drift === 'unset' ? 'sessionEnv.liveDriftUnset' : 'sessionEnv.liveDriftChanged')}</span>}
                  </td>
                  <td><span className={`se-badge is-${row.source}`}>{tr(LIVE_SOURCE_KEYS[row.source] ?? 'sessionEnv.liveSourceOther')}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">ⓘ {tr('sessionEnv.liveSourceNote')}</p>
        </>
      )}
    </ModalDialog>
  );
}
