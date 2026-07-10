import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CreateActionButton, DropdownMenu, FieldTitle, LoadingState, dropdownLabel } from './dashboard-components.js';
import { jget, jsend } from './dashboard-api.js';
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

function ConnectorDropdown<T extends string>(props: {
  id: string;
  label: string;
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange(value: T): void;
}): JSX.Element {
  return (
    <DropdownMenu
      id={props.id}
      className="connector-form-menu"
      ariaLabel={props.label}
      value={props.value}
      label={dropdownLabel(props.options, props.value)}
      options={props.options}
      onChange={props.onChange}
    />
  );
}

function botGroups(groups: GroupOpt[], botId: string): GroupOpt[] {
  return groups.filter(g => g.bots.includes(botId));
}

function ConnectorsPage() {
  const tr = useT();
  const mountedRef = useRef(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const createDialogRef = useRef<HTMLDialogElement | null>(null);
  const [bots, setBots] = useState<BotOpt[]>([]);
  const [groups, setGroups] = useState<GroupOpt[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [createMsg, setCreateMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [created, setCreated] = useState<CreatedConnector | null>(null);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editInstruction, setEditInstruction] = useState('');
  const [editMsg, setEditMsg] = useState<{ id: string; text: string; error?: boolean } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const groupsForBot = useMemo(() => botGroups(groups, form.botId), [groups, form.botId]);
  const botOptions = useMemo(
    () => bots.length
      ? bots.map(bot => ({ value: bot.larkAppId, label: bot.botName }))
      : [{ value: '', label: tr('connectors.noOnlineBots') }],
    [bots, tr],
  );
  const kindOptions = useMemo(() => [
    { value: 'turn' as const, label: tr('connectors.kindTurn') },
    { value: 'workflow' as const, label: tr('connectors.kindWorkflow') },
  ], [tr]);
  const modeOptions = useMemo(() => [
    { value: 'dynamic' as const, label: tr('connectors.modeDynamic') },
    { value: 'fixed' as const, label: tr('connectors.modeFixed') },
    { value: 'new-group' as const, label: tr('connectors.modeNewGroup') },
  ], [tr]);
  const fixedGroupOptions = useMemo(
    () => groupsForBot.length
      ? groupsForBot.map(group => ({ value: group.chatId, label: group.name || group.chatId }))
      : [{ value: '', label: tr('connectors.noBotGroups') }],
    [groupsForBot, tr],
  );
  const verifyOptions = useMemo(() => [
    { value: 'token' as const, label: tr('connectors.verifyToken') },
    { value: 'hmac-sha256' as const, label: tr('connectors.verifyHmac') },
  ], [tr]);

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

  useEffect(() => {
    const dialog = createDialogRef.current;
    if (!dialog) return;
    if (createOpen) {
      if (!dialog.open) {
        try { dialog.showModal(); } catch { /* dialog already opening */ }
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [createOpen]);

  useEffect(() => () => {
    const dialog = createDialogRef.current;
    if (dialog?.open) dialog.close();
  }, []);

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

  function openCreateModal(): void {
    setCreateMsg(null);
    setCreated(null);
    setCreateOpen(true);
  }

  function closeCreateModal(): void {
    if (creating) return;
    setCreateOpen(false);
    setCreateMsg(null);
    setCreated(null);
  }

  function toggleAllowChat(chatId: string): void {
    setForm(cur => {
      const next = cur.allowChats.includes(chatId)
        ? cur.allowChats.filter(id => id !== chatId)
        : [...cur.allowChats, chatId];
      return { ...cur, allowChats: next };
    });
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
    setEditMsg({ id: connector.id, text: tr(connector.enabled ? 'connectors.disabling' : 'connectors.enabling') });
    const r = await jsend('PATCH', `/api/connectors/${encodeURIComponent(connector.id)}`, { enabled: !connector.enabled });
    if (!mountedRef.current) return;
    if (r.status === 200 && r.body?.ok) {
      setEditMsg(null);
      await load();
    } else {
      const e = r.body?.error || r.status;
      setEditMsg({ id: connector.id, text: tr('connectors.toggleFailed', { error: String(e) }), error: true });
    }
  }

  async function deleteConnector(connector: Connector): Promise<void> {
    if (!confirm(tr('connectors.delConfirm'))) return;
    setEditMsg({ id: connector.id, text: tr('connectors.deleting') });
    const r = await jsend('DELETE', `/api/connectors/${encodeURIComponent(connector.id)}`);
    if (!mountedRef.current) return;
    if (r.status === 200 && r.body?.ok) {
      setEditMsg(null);
      await load();
    } else {
      const e = r.body?.error || r.status;
      setEditMsg({ id: connector.id, text: tr('connectors.deleteFailed', { error: String(e) }), error: true });
    }
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
    <section className="page connectors-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.connectors')}</p>
          <h1>{tr('nav.connectors')}</h1>
        </div>
        <div className="page-heading-actions">
          <CreateActionButton className="page-primary-action connector-create-trigger" onClick={openCreateModal}>
            {tr('connectors.createTitle')}
          </CreateActionButton>
        </div>
      </div>

      <dialog
        ref={createDialogRef}
        className="connector-create-modal"
        onCancel={event => {
          event.preventDefault();
          closeCreateModal();
        }}
        onClose={closeCreateModal}
        onClick={event => {
          if (event.target === event.currentTarget) closeCreateModal();
        }}
      >
        <article className="connector-modal-card">
          <header className="connector-modal-header">
            <h3>{tr('connectors.createTitle')}</h3>
            <button
              type="button"
              className="connector-modal-close"
              aria-label={tr('connectors.close')}
              title={tr('connectors.close')}
              disabled={creating}
              onClick={closeCreateModal}
            >
              <span aria-hidden="true">&times;</span>
            </button>
          </header>
          <div className="connector-modal-body">
          {created ? <CreatedPanel created={created} groupName={groupName} /> : (
            <>
            <div className="cn-form">
          <label className="cn-field" htmlFor="cn-name">
            <FieldTitle>{tr('connectors.fName')}</FieldTitle>
            <input id="cn-name" value={form.name} onChange={e => patchForm({ name: e.currentTarget.value })} placeholder={tr('connectors.fNamePh')} />
          </label>

          <div className="cn-field">
            <FieldTitle>{tr('connectors.fBot')}</FieldTitle>
            <ConnectorDropdown
              id="cn-bot"
              label={tr('connectors.fBot')}
              value={form.botId}
              options={botOptions}
              onChange={botId => patchForm({ botId })}
            />
          </div>

          <div className="cn-field">
            <FieldTitle>{tr('connectors.fKind')}</FieldTitle>
            <ConnectorDropdown
              id="cn-kind"
              label={tr('connectors.fKind')}
              value={form.kind}
              options={kindOptions}
              onChange={kind => patchForm({ kind })}
            />
          </div>

          {form.kind === 'workflow' ? (
            <label className="cn-field" htmlFor="cn-wf">
              <FieldTitle>{tr('connectors.fWf')}</FieldTitle>
              <input id="cn-wf" value={form.workflowId} onChange={e => patchForm({ workflowId: e.currentTarget.value })} placeholder="workflowId" />
            </label>
          ) : null}

          <div className="cn-field">
            <FieldTitle>{tr('connectors.fMode')}</FieldTitle>
            <ConnectorDropdown
              id="cn-mode"
              label={tr('connectors.fMode')}
              value={form.mode}
              options={modeOptions}
              onChange={mode => patchForm({ mode })}
            />
          </div>

          {form.mode === 'fixed' ? (
            <div className="cn-field cn-field-wide">
              <FieldTitle>{tr('connectors.fFixedChat')}</FieldTitle>
              <div className="connector-chat-control">
                {form.manualChat ? (
                  <input
                    id="cn-chat"
                    value={form.manualChatId}
                    onChange={e => patchForm({ manualChatId: e.currentTarget.value })}
                    placeholder={tr('connectors.fChatManualPh')}
                  />
                ) : (
                  <ConnectorDropdown
                    id="cn-chat-sel"
                    label={tr('connectors.fFixedChat')}
                    value={form.chatId}
                    options={fixedGroupOptions}
                    onChange={chatId => patchForm({ chatId })}
                  />
                )}
                <button
                  type="button"
                  className="ghost connector-inline-link"
                  onClick={() => patchForm({ manualChat: !form.manualChat })}
                >
                  {form.manualChat ? tr('connectors.chatListLink') : tr('connectors.chatManualLink')}
                </button>
              </div>
            </div>
          ) : (
            <div className="cn-field cn-field-wide">
              <FieldTitle help={tr('connectors.allowHint')}>
                {tr('connectors.fAllow')}<span className="muted cn-optional">{tr('connectors.optional')}</span>
              </FieldTitle>
              <div className="connector-allow-picker" role="group" aria-label={tr('connectors.fAllow')}>
                <button
                  type="button"
                  className={`connector-allow-chip${form.allowChats.length === 0 ? ' selected' : ''}`}
                  aria-pressed={form.allowChats.length === 0}
                  onClick={() => patchForm({ allowChats: [] })}
                >
                  {tr('connectors.allowAll')}
                </button>
                {groupsForBot.map(group => {
                  const label = group.name || group.chatId;
                  const selected = form.allowChats.includes(group.chatId);
                  return (
                    <button
                      type="button"
                      className={`connector-allow-chip${selected ? ' selected' : ''}`}
                      aria-pressed={selected}
                      title={label}
                      key={group.chatId}
                      onClick={() => toggleAllowChat(group.chatId)}
                    >
                      <span className="connector-allow-dot" aria-hidden="true" />
                      <span className="connector-allow-name">{label}</span>
                    </button>
                  );
                })}
                {!groupsForBot.length ? <span className="muted connector-allow-empty">{tr('connectors.noBotGroups')}</span> : null}
              </div>
            </div>
          )}

          {form.mode === 'dynamic' ? (
            <div className="cn-field-wide">
              <div
                className="muted connector-form-hint"
                dangerouslySetInnerHTML={{ __html: tr('connectors.dynamicHint') }}
              />
            </div>
          ) : null}

          {form.mode === 'new-group' ? (
            <label className="cn-field cn-field-wide" htmlFor="cn-dedup">
              <FieldTitle help={<span dangerouslySetInnerHTML={{ __html: tr('connectors.dedupHint') }} />}>
                {tr('connectors.fDedup')}<span className="muted cn-optional">{tr('connectors.optional')}</span>
              </FieldTitle>
                <input id="cn-dedup" value={form.dedup} onChange={e => patchForm({ dedup: e.currentTarget.value })} placeholder={tr('connectors.fDedupPh')} />
            </label>
          ) : null}

          <label className="cn-field cn-field-wide" htmlFor="cn-instruction">
            <FieldTitle help={tr('connectors.fInstructionPh')}>
              {tr('connectors.fInstruction')}<span className="muted cn-optional">{tr('connectors.optional')}</span>
            </FieldTitle>
            <textarea
              id="cn-instruction"
              rows={3}
              value={form.instruction}
              onChange={e => patchForm({ instruction: e.currentTarget.value })}
              placeholder={tr('connectors.fInstructionPh')}
            />
          </label>

          <div className="cn-field">
            <FieldTitle>{tr('connectors.fVerify')}</FieldTitle>
            <ConnectorDropdown
              id="cn-verify"
              label={tr('connectors.fVerify')}
              value={form.verify}
              options={verifyOptions}
              onChange={verify => patchForm({ verify })}
            />
          </div>

          <label className="cn-field" htmlFor="cn-secret">
            <FieldTitle>{tr('connectors.fSecret')}</FieldTitle>
            <input id="cn-secret" value={form.secret} onChange={e => patchForm({ secret: e.currentTarget.value })} placeholder={tr('connectors.fSecretPh')} />
          </label>
            </div>
            {createMsg ? <p className={`connector-create-message${createMsg.error ? ' err' : ''}`}>{createMsg.text}</p> : null}
            </>
          )}
          </div>
          <footer className="connector-modal-actions">
            <button type="button" disabled={creating} onClick={closeCreateModal}>
              {tr('connectors.cancel')}
            </button>
            {created ? (
              <button type="button" className="primary" onClick={closeCreateModal}>{tr('connectors.close')}</button>
            ) : (
              <button id="cn-create" type="button" className="primary" disabled={creating} onClick={() => void createConnector()}>
                {tr('connectors.btnCreate')}
              </button>
            )}
          </footer>
        </article>
      </dialog>

      <section className="overview-block connector-section connector-list-section">
        <div className="card connector-list-card">
        {loading ? <LoadingState className="connector-list-loading" label={tr('connectors.loading')} compact /> : (
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
    </section>
  );
}

function CreatedPanel(props: { created: CreatedConnector; groupName(chatId: string): string }) {
  const tr = useT();
  const c = props.created;
  const callUrl = c.isDynamic ? `${c.url}?chatId=${c.exampleChat}` : c.url;
  const dynamicGroupName = c.exampleChat !== '<chatId>' ? `（${props.groupName(c.exampleChat)}）` : '';

  return (
    <div className="connector-created-wrap">
      <div className="card connector-created-card">
        <p className="connector-created-title ok">
          {tr('connectors.createdPrefix', { name: c.name })}
          {c.mode === 'fixed' && c.chatId ? (
            <span className="muted"> · {tr('connectors.createdDest', { name: props.groupName(c.chatId) })}</span>
          ) : null}
        </p>
        <p className="connector-created-line"><span className="muted">{tr('connectors.webhookUrl')}</span><code>{c.url}</code></p>
        {c.secret ? (
          <p className="connector-created-line">
            <span className="muted">{c.isToken ? tr('connectors.tokenLabel') : tr('connectors.signLabel')}{tr('connectors.secretOnce')}</span><code>{c.secret}</code>
          </p>
        ) : null}
        {c.isToken && c.isDynamic ? (
          <>
            <p className="muted connector-created-help">{tr('connectors.usageDynamicLede', { gn: dynamicGroupName })}</p>
            <pre><code>{`curl -X POST '${callUrl}' -H 'content-type: application/json' -d '{}'`}</code></pre>
            <p className="muted connector-created-help" dangerouslySetInnerHTML={{ __html: tr('connectors.usageDynamicNote') }} />
          </>
        ) : c.isToken ? (
          <>
            <p className="muted connector-created-help">{tr('connectors.usageTokenLede')}</p>
            <pre><code>{`curl -X POST '${callUrl}' -H 'content-type: application/json' -d '{}'`}</code></pre>
            <p className="muted connector-created-help" dangerouslySetInnerHTML={{ __html: tr('connectors.usageTokenNote') }} />
          </>
        ) : (
          <p className="muted connector-created-help" dangerouslySetInnerHTML={{ __html: tr('connectors.usageHmac') + (c.isDynamic ? tr('connectors.usageHmacDynamic') : '') }} />
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
  if (!props.connectors.length) return <p className="muted connector-list-empty">{tr('connectors.empty')}</p>;

  return (
    <>
      {props.connectors.map(c => {
        const bot = props.bots.find(b => b.larkAppId === c.target.botId);
        const url = webhookUrl(c.id);
        const isToken = (c.verify?.type ?? 'token') === 'token';
        const verifyBadge = isToken ? tr('connectors.badgeToken') : tr('connectors.badgeSign');
        const destLabel = c.target.mode === 'fixed' && c.target.chatId ? tr('connectors.dest', { name: props.groupName(c.target.chatId) }) : '';
        const editing = props.editingId === c.id;
        const editMsg = props.editMsg?.id === c.id ? props.editMsg : null;
        const copied = props.copiedId === c.id;
        return (
          <div key={c.id} className="card connector-item-card">
            <div className="connector-item-head">
              <div className="connector-item-main">
                <div className="connector-item-title">
                  <b>{c.name}</b>
                  <span className={c.enabled ? 'connector-status-pill ok' : 'connector-status-pill muted'}>{c.enabled ? tr('connectors.enabled') : tr('connectors.disabled')}</span>
                </div>
                <div className="connector-item-meta">
                  <span>{bot?.botName || c.target.botId}</span>
                  <span>{props.kindLabel(c.target.kind)}</span>
                  <span>{props.modeLabel(c.target.mode)}</span>
                  {destLabel ? <span>{destLabel}</span> : null}
                  <span>{verifyBadge}</span>
                </div>
              </div>
              <button className={`ghost connector-copy-button${copied ? ' copied' : ''}`} type="button" onClick={() => props.onCopy(c)}>{copied ? tr('connectors.copied') : tr('connectors.copy')}</button>
            </div>
            <div className="connector-url-row">
              <span className="muted">{tr('connectors.webhookUrl')}</span>
              <code>{url}{isToken ? '/<token>' : ''}</code>
            </div>
            {isToken ? <div className="muted connector-item-note" dangerouslySetInnerHTML={{ __html: tr('connectors.tokenHint') }} /> : null}
            {c.target.mode === 'dynamic' ? <div className="muted connector-item-note" dangerouslySetInnerHTML={{ __html: tr('connectors.dynamicReqHint') }} /> : null}
            {c.promptEnvelope?.instruction ? <div className="muted connector-item-note">{tr('connectors.instructionPrefix')}{c.promptEnvelope.instruction}</div> : null}
            {!editing && editMsg ? <div className={editMsg.error ? 'err connector-item-note' : 'muted connector-item-note'}>{editMsg.text}</div> : null}
            {!editing ? (
              <div className="connector-item-actions">
                <button className="ghost" type="button" onClick={() => props.onEdit(c)}>{tr('connectors.btnEdit')}</button>
                <button className="ghost" type="button" onClick={() => props.onToggle(c)}>{c.enabled ? tr('connectors.btnDisable') : tr('connectors.btnEnable')}</button>
                <button className="ghost" type="button" onClick={() => props.onDelete(c)}>{tr('connectors.btnDel')}</button>
              </div>
            ) : null}
            {editing ? (
              <div className="cn-edit-box">
                <textarea
                  className="cn-edit-instruction"
                  rows={3}
                  value={props.editInstruction}
                  onChange={e => props.onEditInstruction(e.currentTarget.value)}
                  placeholder={tr('connectors.fInstructionPh')}
                />
                <div className="connector-edit-actions">
                  <button className="ghost" type="button" onClick={props.onCancelEdit}>{tr('connectors.btnCancel')}</button>
                  <button className="primary" type="button" onClick={() => props.onSaveInstruction(c)}>{tr('connectors.btnSave')}</button>
                  {editMsg ? <span className={editMsg.error ? 'err' : 'muted'}>{editMsg.text}</span> : null}
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
