import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';

interface Connector {
  id: string;
  name: string;
  enabled: boolean;
  verify?: { type: 'token' | 'hmac-sha256' };
  target: {
    mode: 'dynamic' | 'fixed' | 'new-group';
    kind: 'turn' | 'workflow';
    botId: string;
    chatId?: string;
    allowChats?: string[];
    workflowId?: string;
  };
  promptEnvelope: { sourceName: string; instruction?: string };
}

interface BotOpt {
  larkAppId: string;
  botName: string;
}

interface GroupOpt {
  chatId: string;
  name: string;
  bots: string[];
}

interface CreateForm {
  name: string;
  botId: string;
  kind: 'turn' | 'workflow';
  workflowId: string;
  mode: 'dynamic' | 'fixed' | 'new-group';
  chatId: string;
  manualChat: boolean;
  manualChatId: string;
  allowChats: string[];
  dedup: string;
  instruction: string;
  verify: 'token' | 'hmac-sha256';
  secret: string;
}

interface CreatedConnector {
  name: string;
  mode: CreateForm['mode'];
  chatId?: string;
  url: string;
  secret?: string;
  isToken: boolean;
  isDynamic: boolean;
  exampleChat: string;
}

const emptyForm: CreateForm = {
  name: '',
  botId: '',
  kind: 'turn',
  workflowId: '',
  mode: 'dynamic',
  chatId: '',
  manualChat: false,
  manualChatId: '',
  allowChats: [],
  dedup: '',
  instruction: '',
  verify: 'token',
  secret: '',
};

async function jget(u: string): Promise<{ status: number; body: any }> {
  const r = await fetch(u);
  return { status: r.status, body: await r.json().catch(() => ({} as any)) };
}

async function jsend(method: string, u: string, b?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(u, {
    method,
    headers: { 'content-type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({} as any)) };
}

export function buildConnectorInstructionUpdateBody(
  connector: { name: string; promptEnvelope?: { sourceName?: string } },
  instruction: string,
): { promptEnvelope: { sourceName: string; instruction: string } } {
  return {
    promptEnvelope: {
      sourceName: connector.promptEnvelope?.sourceName || connector.name,
      instruction,
    },
  };
}

function webhookUrl(id: string): string {
  return `${location.origin}/webhook/${encodeURIComponent(id)}`;
}

function botGroups(groups: GroupOpt[], botId: string): GroupOpt[] {
  return groups.filter(g => g.bots.includes(botId));
}

function ConnectorsPage() {
  const tr = useT();
  const mountedRef = useRef(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [bots, setBots] = useState<BotOpt[]>([]);
  const [groups, setGroups] = useState<GroupOpt[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [createMsg, setCreateMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [created, setCreated] = useState<CreatedConnector | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editInstruction, setEditInstruction] = useState('');
  const [editMsg, setEditMsg] = useState<{ id: string; text: string; error?: boolean } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const groupsForBot = useMemo(() => botGroups(groups, form.botId), [groups, form.botId]);

  const groupName = useCallback((chatId: string): string => {
    const g = groups.find(x => x.chatId === chatId);
    return g?.name || chatId;
  }, [groups]);

  const normalizeFormForLoadedData = useCallback((nextBots: BotOpt[], nextGroups: GroupOpt[]) => {
    setForm(cur => {
      const botId = cur.botId && nextBots.some(b => b.larkAppId === cur.botId)
        ? cur.botId
        : (nextBots[0]?.larkAppId ?? '');
      const availableGroups = botGroups(nextGroups, botId);
      const chatId = cur.chatId && availableGroups.some(g => g.chatId === cur.chatId)
        ? cur.chatId
        : (availableGroups[0]?.chatId ?? '');
      const allowSet = new Set(availableGroups.map(g => g.chatId));
      return {
        ...cur,
        botId,
        chatId,
        allowChats: cur.allowChats.filter(id => allowSet.has(id)),
      };
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [bl, cl, gl] = await Promise.all([jget('/api/bots'), jget('/api/connectors'), jget('/api/groups')]);
      if (!mountedRef.current) return;
      const nextBots = (bl.body?.bots || []).map((b: any) => ({
        larkAppId: b.larkAppId,
        botName: b.botName || b.larkAppId,
      })) as BotOpt[];
      const nextGroups = (gl.body?.chats || []).map((c: any) => ({
        chatId: c.chatId,
        name: c.name || '',
        bots: (c.memberBots || []).filter((mb: any) => mb.inChat).map((mb: any) => mb.larkAppId),
      })) as GroupOpt[];
      setBots(nextBots);
      setGroups(nextGroups);
      setConnectors(Array.isArray(cl.body?.connectors) ? cl.body.connectors : []);
      normalizeFormForLoadedData(nextBots, nextGroups);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [normalizeFormForLoadedData]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, [load]);

  useEffect(() => {
    const valid = new Set(groupsForBot.map(g => g.chatId));
    setForm(cur => ({
      ...cur,
      chatId: cur.chatId && valid.has(cur.chatId) ? cur.chatId : (groupsForBot[0]?.chatId ?? ''),
      allowChats: cur.allowChats.filter(id => valid.has(id)),
    }));
  }, [groupsForBot]);

  function modeLabel(m: string): string {
    return m === 'fixed'
      ? tr('connectors.modeLabelFixed')
      : m === 'new-group'
        ? tr('connectors.modeLabelNewGroup')
        : tr('connectors.modeLabelDynamic');
  }

  function kindLabel(k: string): string {
    return k === 'workflow' ? tr('connectors.kindLabelWorkflow') : tr('connectors.kindLabelTurn');
  }

  function patchForm(patch: Partial<CreateForm>): void {
    setForm(cur => ({ ...cur, ...patch }));
  }

  function selectAllowChats(select: HTMLSelectElement): void {
    patchForm({ allowChats: Array.from(select.selectedOptions).map(o => o.value).filter(Boolean) });
  }

  async function createConnector(): Promise<void> {
    setCreateMsg(null);
    setCreated(null);
    const name = form.name.trim();
    const botId = form.botId;
    if (!name) { setCreateMsg({ text: tr('connectors.errName'), error: true }); return; }
    if (!botId) { setCreateMsg({ text: tr('connectors.errBot'), error: true }); return; }

    const body: any = {
      name,
      enabled: true,
      target: { kind: form.kind, mode: form.mode, botId },
      promptEnvelope: { sourceName: name },
      verify: { type: form.verify },
    };
    const instruction = form.instruction.trim();
    if (instruction) body.promptEnvelope.instruction = instruction;
    if (form.kind === 'workflow') {
      if (!form.workflowId.trim()) { setCreateMsg({ text: tr('connectors.errWf'), error: true }); return; }
      body.target.workflowId = form.workflowId.trim();
    }
    if (form.mode === 'fixed') {
      const chatId = form.manualChat ? form.manualChatId.trim() : form.chatId;
      if (!chatId) { setCreateMsg({ text: tr('connectors.errChat'), error: true }); return; }
      body.target.chatId = chatId;
    } else if (form.allowChats.length) {
      body.target.allowChats = form.allowChats;
    }
    if (form.mode === 'new-group') {
      const dedup = form.dedup.trim();
      body.lifecycleExtractors = dedup ? { dedupKey: dedup } : null;
    }
    if (form.secret.trim()) body.secret = form.secret.trim();

    setCreating(true);
    setCreateMsg({ text: tr('connectors.creating') });
    try {
      const r = await jsend('POST', '/api/connectors', body);
      if (!mountedRef.current) return;
      if (r.status === 201 && r.body?.ok) {
        const url = r.body.webhookUrl || webhookUrl(r.body.connector.id);
        const isToken = (r.body.connector?.verify?.type ?? 'token') === 'token';
        const isDynamic = form.mode === 'dynamic';
        const exampleChat = isDynamic ? (body.target.allowChats?.[0] || '<chatId>') : '';
        setCreateMsg(null);
        setCreated({
          name,
          mode: form.mode,
          chatId: body.target.chatId,
          url,
          secret: r.body.secret,
          isToken,
          isDynamic,
          exampleChat,
        });
        setForm(cur => ({
          ...cur,
          name: '',
          workflowId: '',
          manualChatId: '',
          dedup: '',
          secret: '',
          instruction: '',
          allowChats: [],
        }));
        await load();
      } else {
        const e = r.body?.error || r.status;
        setCreateMsg({ text: tr('connectors.createFailed', { error: String(e) }), error: true });
      }
    } finally {
      if (mountedRef.current) setCreating(false);
    }
  }

  async function saveInstruction(connector: Connector): Promise<void> {
    setEditMsg({ id: connector.id, text: tr('connectors.saving') });
    const r = await jsend(
      'PUT',
      `/api/connectors/${encodeURIComponent(connector.id)}`,
      buildConnectorInstructionUpdateBody(connector, editInstruction),
    );
    if (!mountedRef.current) return;
    if (r.status === 200 && r.body?.ok) {
      setEditingId(null);
      setEditInstruction('');
      setEditMsg(null);
      await load();
    } else {
      const e = r.body?.error || r.status;
      setEditMsg({ id: connector.id, text: tr('connectors.saveFailed', { error: String(e) }), error: true });
    }
  }

  async function toggleConnector(connector: Connector): Promise<void> {
    await jsend('PATCH', `/api/connectors/${encodeURIComponent(connector.id)}`, { enabled: !connector.enabled });
    if (!mountedRef.current) return;
    await load();
  }

  async function deleteConnector(connector: Connector): Promise<void> {
    if (!confirm(tr('connectors.delConfirm'))) return;
    await jsend('DELETE', `/api/connectors/${encodeURIComponent(connector.id)}`);
    if (!mountedRef.current) return;
    await load();
  }

  function copyConnectorUrl(connector: Connector): void {
    void navigator.clipboard?.writeText(webhookUrl(connector.id));
    setCopiedId(connector.id);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setCopiedId(null);
    }, 1200);
  }

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Webhook</p>
          <h1>Webhook</h1>
          <p>{tr('connectors.lede')}</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>{tr('connectors.createTitle')}</h2>
        <div className="cn-form" style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '10px 14px', alignItems: 'center', maxWidth: 680 }}>
          <label htmlFor="cn-name">{tr('connectors.fName')}</label>
          <input id="cn-name" value={form.name} onChange={e => patchForm({ name: e.currentTarget.value })} placeholder={tr('connectors.fNamePh')} />

          <label htmlFor="cn-bot">{tr('connectors.fBot')}</label>
          <select id="cn-bot" value={form.botId} onChange={e => patchForm({ botId: e.currentTarget.value })}>
            {bots.length ? bots.map(b => <option key={b.larkAppId} value={b.larkAppId}>{b.botName}</option>) : <option value="">{tr('connectors.noOnlineBots')}</option>}
          </select>

          <label htmlFor="cn-kind">{tr('connectors.fKind')}</label>
          <select id="cn-kind" value={form.kind} onChange={e => patchForm({ kind: e.currentTarget.value as CreateForm['kind'] })}>
            <option value="turn">{tr('connectors.kindTurn')}</option>
            <option value="workflow">{tr('connectors.kindWorkflow')}</option>
          </select>

          {form.kind === 'workflow' ? (
            <>
              <label htmlFor="cn-wf">{tr('connectors.fWf')}</label>
              <input id="cn-wf" value={form.workflowId} onChange={e => patchForm({ workflowId: e.currentTarget.value })} placeholder="workflowId" />
            </>
          ) : null}

          <label htmlFor="cn-mode">{tr('connectors.fMode')}</label>
          <select id="cn-mode" value={form.mode} onChange={e => patchForm({ mode: e.currentTarget.value as CreateForm['mode'] })}>
            <option value="dynamic">{tr('connectors.modeDynamic')}</option>
            <option value="fixed">{tr('connectors.modeFixed')}</option>
            <option value="new-group">{tr('connectors.modeNewGroup')}</option>
          </select>

          {form.mode === 'fixed' ? (
            <>
              <label>{tr('connectors.fFixedChat')}</label>
              <div>
                {form.manualChat ? (
                  <input
                    id="cn-chat"
                    value={form.manualChatId}
                    onChange={e => patchForm({ manualChatId: e.currentTarget.value })}
                    placeholder={tr('connectors.fChatManualPh')}
                    style={{ width: '100%', boxSizing: 'border-box', marginTop: 6 }}
                  />
                ) : (
                  <select id="cn-chat-sel" value={form.chatId} onChange={e => patchForm({ chatId: e.currentTarget.value })} style={{ width: '100%', boxSizing: 'border-box' }}>
                    {groupsForBot.length ? groupsForBot.map(g => <option key={g.chatId} value={g.chatId}>{g.name || g.chatId}</option>) : <option value="">{tr('connectors.noBotGroups')}</option>}
                  </select>
                )}
                <a
                  href="#"
                  onClick={e => { e.preventDefault(); patchForm({ manualChat: !form.manualChat }); }}
                  style={{ fontSize: 12, display: 'inline-block', marginTop: 4 }}
                >
                  {form.manualChat ? tr('connectors.chatListLink') : tr('connectors.chatManualLink')}
                </a>
              </div>
            </>
          ) : (
            <>
              <label>{tr('connectors.fAllow')}<span className="muted" style={{ fontWeight: 400 }}>{tr('connectors.optional')}</span></label>
              <div>
                <select multiple size={4} value={form.allowChats} onChange={e => selectAllowChats(e.currentTarget)} style={{ width: '100%', boxSizing: 'border-box' }}>
                  {groupsForBot.map(g => <option key={g.chatId} value={g.chatId}>{g.name || g.chatId}</option>)}
                </select>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{tr('connectors.allowHint')}</div>
              </div>
            </>
          )}

          {form.mode === 'dynamic' ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <div
                className="muted"
                style={{ fontSize: 12, lineHeight: 1.7, background: 'var(--bg-soft,#f6f7f9)', padding: '8px 10px', borderRadius: 6 }}
                dangerouslySetInnerHTML={{ __html: tr('connectors.dynamicHint') }}
              />
            </div>
          ) : null}

          {form.mode === 'new-group' ? (
            <>
              <label htmlFor="cn-dedup">{tr('connectors.fDedup')}<span className="muted" style={{ fontWeight: 400 }}>{tr('connectors.optional')}</span></label>
              <div>
                <input id="cn-dedup" value={form.dedup} onChange={e => patchForm({ dedup: e.currentTarget.value })} placeholder={tr('connectors.fDedupPh')} style={{ width: '100%', boxSizing: 'border-box' }} />
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }} dangerouslySetInnerHTML={{ __html: tr('connectors.dedupHint') }} />
              </div>
            </>
          ) : null}

          <label htmlFor="cn-instruction" style={{ alignSelf: 'start' }}>{tr('connectors.fInstruction')}<span className="muted" style={{ fontWeight: 400 }}>{tr('connectors.optional')}</span></label>
          <textarea
            id="cn-instruction"
            rows={3}
            value={form.instruction}
            onChange={e => patchForm({ instruction: e.currentTarget.value })}
            placeholder={tr('connectors.fInstructionPh')}
            style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 13 }}
          />

          <label htmlFor="cn-verify">{tr('connectors.fVerify')}</label>
          <select id="cn-verify" value={form.verify} onChange={e => patchForm({ verify: e.currentTarget.value as CreateForm['verify'] })}>
            <option value="token">{tr('connectors.verifyToken')}</option>
            <option value="hmac-sha256">{tr('connectors.verifyHmac')}</option>
          </select>

          <label htmlFor="cn-secret">{tr('connectors.fSecret')}</label>
          <input id="cn-secret" value={form.secret} onChange={e => patchForm({ secret: e.currentTarget.value })} placeholder={tr('connectors.fSecretPh')} />
        </div>
        <div style={{ marginTop: 14 }}>
          <button id="cn-create" type="button" className="primary" disabled={creating} onClick={() => void createConnector()}>{tr('connectors.btnCreate')}</button>
          {createMsg ? <span className={createMsg.error ? 'err' : 'muted'} style={{ marginLeft: 10, fontSize: 13 }}>{createMsg.text}</span> : null}
        </div>
        {created ? <CreatedPanel created={created} groupName={groupName} /> : null}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>
          {tr('connectors.listTitle')} <span className="muted" style={{ fontSize: 13 }}>{connectors.length ? tr('connectors.count', { count: connectors.length }) : ''}</span>
        </h2>
        {loading ? <div>{tr('connectors.loading')}</div> : (
          <ConnectorList
            connectors={connectors}
            bots={bots}
            copiedId={copiedId}
            editingId={editingId}
            editInstruction={editInstruction}
            editMsg={editMsg}
            groupName={groupName}
            modeLabel={modeLabel}
            kindLabel={kindLabel}
            onCopy={copyConnectorUrl}
            onEdit={connector => { setEditingId(connector.id); setEditInstruction(connector.promptEnvelope?.instruction || ''); setEditMsg(null); }}
            onCancelEdit={() => { setEditingId(null); setEditInstruction(''); setEditMsg(null); }}
            onEditInstruction={setEditInstruction}
            onSaveInstruction={connector => void saveInstruction(connector)}
            onToggle={connector => void toggleConnector(connector)}
            onDelete={connector => void deleteConnector(connector)}
          />
        )}
      </div>
    </section>
  );
}

function CreatedPanel(props: { created: CreatedConnector; groupName(chatId: string): string }) {
  const tr = useT();
  const c = props.created;
  const callUrl = c.isDynamic ? `${c.url}?chatId=${c.exampleChat}` : c.url;
  const dynamicGroupName = c.exampleChat !== '<chatId>' ? `（${props.groupName(c.exampleChat)}）` : '';

  return (
    <div style={{ marginTop: 12 }}>
      <div className="card" style={{ padding: '12px 14px', background: 'var(--bg-soft,#f6f7f9)' }}>
        <p className="ok" style={{ margin: '0 0 6px' }}>
          {tr('connectors.createdPrefix', { name: c.name })}
          {c.mode === 'fixed' && c.chatId ? (
            <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}> · {tr('connectors.createdDest', { name: props.groupName(c.chatId) })}</span>
          ) : null}
        </p>
        <p style={{ margin: '4px 0', fontSize: 13 }}><span className="muted">{tr('connectors.webhookUrl')}</span><code style={{ wordBreak: 'break-all' }}>{c.url}</code></p>
        {c.secret ? (
          <p style={{ margin: '4px 0', fontSize: 13 }}>
            <span className="muted">{c.isToken ? tr('connectors.tokenLabel') : tr('connectors.signLabel')}{tr('connectors.secretOnce')}</span><code>{c.secret}</code>
          </p>
        ) : null}
        {c.isToken && c.isDynamic ? (
          <>
            <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>{tr('connectors.usageDynamicLede', { gn: dynamicGroupName })}</p>
            <pre style={{ margin: '6px 0 0', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}><code>{`curl -X POST '${callUrl}' -H 'content-type: application/json' -d '{}'`}</code></pre>
            <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }} dangerouslySetInnerHTML={{ __html: tr('connectors.usageDynamicNote') }} />
          </>
        ) : c.isToken ? (
          <>
            <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>{tr('connectors.usageTokenLede')}</p>
            <pre style={{ margin: '6px 0 0', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}><code>{`curl -X POST '${callUrl}' -H 'content-type: application/json' -d '{}'`}</code></pre>
            <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }} dangerouslySetInnerHTML={{ __html: tr('connectors.usageTokenNote') }} />
          </>
        ) : (
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }} dangerouslySetInnerHTML={{ __html: tr('connectors.usageHmac') + (c.isDynamic ? tr('connectors.usageHmacDynamic') : '') }} />
        )}
      </div>
    </div>
  );
}

function ConnectorList(props: {
  connectors: Connector[];
  bots: BotOpt[];
  copiedId: string | null;
  editingId: string | null;
  editInstruction: string;
  editMsg: { id: string; text: string; error?: boolean } | null;
  groupName(chatId: string): string;
  modeLabel(mode: string): string;
  kindLabel(kind: string): string;
  onCopy(connector: Connector): void;
  onEdit(connector: Connector): void;
  onCancelEdit(): void;
  onEditInstruction(value: string): void;
  onSaveInstruction(connector: Connector): void;
  onToggle(connector: Connector): void;
  onDelete(connector: Connector): void;
}) {
  const tr = useT();
  if (!props.connectors.length) return <p className="muted">{tr('connectors.empty')}</p>;

  return (
    <>
      {props.connectors.map(c => {
        const bot = props.bots.find(b => b.larkAppId === c.target.botId);
        const url = webhookUrl(c.id);
        const isToken = (c.verify?.type ?? 'token') === 'token';
        const verifyBadge = isToken ? tr('connectors.badgeToken') : tr('connectors.badgeSign');
        const destLabel = c.target.mode === 'fixed' && c.target.chatId
          ? ` · ${tr('connectors.dest', { name: props.groupName(c.target.chatId) })}`
          : '';
        const editing = props.editingId === c.id;
        const editMsg = props.editMsg?.id === c.id ? props.editMsg : null;
        return (
          <div key={c.id} className="card" style={{ margin: '0 0 10px', padding: '12px 14px', background: 'var(--bg-soft,#f6f7f9)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 15 }}>{c.name}</b>
              <span className={c.enabled ? 'ok' : 'muted'} style={{ fontSize: 12 }}>{c.enabled ? tr('connectors.enabled') : tr('connectors.disabled')}</span>
              <span className="muted" style={{ fontSize: 12 }}>· {bot?.botName || c.target.botId} · {props.kindLabel(c.target.kind)} · {props.modeLabel(c.target.mode)}{destLabel} · {verifyBadge}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button className="ghost" type="button" style={{ fontSize: 12 }} onClick={() => props.onEdit(c)}>{tr('connectors.btnEdit')}</button>
                <button className="ghost" type="button" style={{ fontSize: 12 }} onClick={() => props.onToggle(c)}>{c.enabled ? tr('connectors.btnDisable') : tr('connectors.btnEnable')}</button>
                <button className="ghost" type="button" style={{ fontSize: 12 }} onClick={() => props.onDelete(c)}>{tr('connectors.btnDel')}</button>
              </span>
            </div>
            <div style={{ marginTop: 6, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="muted">{tr('connectors.webhookUrl')}</span>
              <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{url}{isToken ? '/<token>' : ''}</code>
              <button className="ghost" type="button" style={{ fontSize: 12 }} onClick={() => props.onCopy(c)}>{props.copiedId === c.id ? tr('connectors.copied') : tr('connectors.copy')}</button>
            </div>
            {isToken ? <div className="muted" style={{ fontSize: 12, marginTop: 4 }} dangerouslySetInnerHTML={{ __html: tr('connectors.tokenHint') }} /> : null}
            {c.target.mode === 'dynamic' ? <div className="muted" style={{ fontSize: 12, marginTop: 4 }} dangerouslySetInnerHTML={{ __html: tr('connectors.dynamicReqHint') }} /> : null}
            {c.promptEnvelope?.instruction ? <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{tr('connectors.instructionPrefix')}{c.promptEnvelope.instruction}</div> : null}
            {editing ? (
              <div className="cn-edit-box" style={{ marginTop: 8 }}>
                <textarea
                  className="cn-edit-instruction"
                  rows={3}
                  value={props.editInstruction}
                  onChange={e => props.onEditInstruction(e.currentTarget.value)}
                  style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 13 }}
                  placeholder={tr('connectors.fInstructionPh')}
                />
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <button className="primary" type="button" style={{ fontSize: 12 }} onClick={() => props.onSaveInstruction(c)}>{tr('connectors.btnSave')}</button>
                  <button className="ghost" type="button" style={{ fontSize: 12 }} onClick={props.onCancelEdit}>{tr('connectors.btnCancel')}</button>
                  {editMsg ? <span className={editMsg.error ? 'err' : 'muted'} style={{ fontSize: 12 }}>{editMsg.text}</span> : null}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function renderConnectorsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <ConnectorsPage />);
}
