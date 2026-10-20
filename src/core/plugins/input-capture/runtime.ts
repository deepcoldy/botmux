import { captureDigest, createInputCaptureStore, type CapturedInput, type InputBinding, type CaptureSnapshot, type CaptureJournal } from './store.js';
import { parseInputCaptureConditions } from './conditions.js';
import { parseCaptureAttachments, type CaptureAttachment } from './attachments.js';

export interface CaptureSession {
  sessionId: string; larkAppId: string; chatId: string; anchor: string;
  ownerOpenId: string; active: boolean; scope?: string; chatType?: string;
}
export interface InputCaptureOptions {
  larkAppId: string;
  store: ReturnType<typeof createInputCaptureStore>;
  session(id: string): CaptureSession | undefined;
  pluginEnabled(pluginId: string): boolean;
  canTalk(session: CaptureSession, actor: string, memberUnionId?: string): boolean;
  deliver(binding: InputBinding, input: CapturedInput): Promise<void>;
  warn?(): void;
}

export const INPUT_CAPTURE_TERMINAL_REJECTION_CODES = [
  'input_capture_authority_changed',
  'input_capture_text_too_large',
  'input_capture_revision_conflict',
  'input_capture_anchor_conflict',
  'input_capture_message_conflict',
] as const;

export type InputCaptureTerminalRejectionCode =
  typeof INPUT_CAPTURE_TERMINAL_REJECTION_CODES[number];

/**
 * A deterministic capture rejection. Retrying the same durable Lark event
 * cannot make these conditions succeed, so primary consumers must settle the
 * Inbox row instead of blocking the whole chat partition forever.
 */
export class InputCaptureTerminalRejection extends Error {
  readonly code: InputCaptureTerminalRejectionCode;

  constructor(code: InputCaptureTerminalRejectionCode) {
    super(code);
    this.name = 'InputCaptureTerminalRejection';
    this.code = code;
  }
}

export function isInputCaptureTerminalRejection(
  error: unknown,
): error is InputCaptureTerminalRejection {
  return error instanceof InputCaptureTerminalRejection;
}

function terminalCaptureRejection(
  code: InputCaptureTerminalRejectionCode,
): InputCaptureTerminalRejection {
  return new InputCaptureTerminalRejection(code);
}
const valid = (s: unknown, max = 200): s is string => typeof s === 'string'
  && !!s.trim() && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s);
const selects = (binding: InputBinding, actor: string) => binding.actorSelector === 'authorized_humans' || binding.ownerOpenId === actor;
const overlaps = (a: InputBinding, b: InputBinding) => a.actorSelector === 'authorized_humans' || b.actorSelector === 'authorized_humans' || a.ownerOpenId === b.ownerOpenId;
const validThread = (s: unknown): s is string => typeof s === 'string' && /^omt_[A-Za-z0-9_-]{1,196}$/.test(s);
function bindingThreads(snapshot: CaptureSnapshot, binding: InputBinding): Set<string> {
  return snapshot.threadsByBinding.get(binding.id)!;
}

export function createInputCaptureRuntime(options: InputCaptureOptions) {
  const { store, larkAppId } = options;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  // A group-wide session has no personal owner. A binding still selects one
  // explicit actor, whose current native talk permission is checked separately.
  const matchesOwner = (session: CaptureSession, actor: string) => session.ownerOpenId === actor
    || session.scope === 'chat' && session.chatType === 'group' && session.anchor === session.chatId;
  const matchesSession = (binding: InputBinding, session: CaptureSession | undefined): session is CaptureSession =>
    !!session && session.active && session.larkAppId === binding.larkAppId
      && session.sessionId === binding.sessionId && session.chatId === binding.chatId
      && session.anchor === binding.sourceAnchor && matchesOwner(session, binding.ownerOpenId);
  async function flush() {
    // Preserve source order per binding. Offline / rejected inputs remain pending.
    const snapshot = store.readIndexed(); const journal = snapshot.state; const blocked = new Set<string>();
    for (const input of journal.inputs) {
      if (stopped) return;
      if (input.delivery !== 'pending' || blocked.has(input.bindingId)) continue;
      const binding = snapshot.bindingsById.get(input.bindingId)!;
      if (!options.pluginEnabled(binding.pluginId)) { blocked.add(binding.id); continue; }
      try {
        // Previously accepted input is delivered even after capture revocation.
        // Its snapshot is historical evidence, never a current execution grant.
        await options.deliver(binding, input);
        store.transact(state => {
          const current = state.inputs.find(row => row.id === input.id);
          if (!current || JSON.stringify({ ...current, delivery: 'pending', acknowledgedAt: undefined })
            !== JSON.stringify({ ...input, acknowledgedAt: undefined })) throw new Error('input_capture_input_changed');
          current.delivery = 'acknowledged'; current.acknowledgedAt = new Date().toISOString();
        });
      } catch { blocked.add(binding.id); options.warn?.(); }
    }
  }
  const kick = () => {
    if (stopped) return Promise.resolve();
    if (!running) running = flush().catch(() => options.warn?.()).finally(() => { running = undefined; });
    return running;
  };
  function prepareBinding(sessionId: string, body: Record<string, unknown>): InputBinding {
      if (!valid(body.pluginId, 100) || !valid(body.requestId, 128) || !valid(body.providerRef, 1000)
        || body.actorOpenId !== undefined && (typeof body.actorOpenId !== 'string' || !/^ou_[A-Za-z0-9_-]+$/.test(body.actorOpenId))
        || body.inputThreadId !== undefined && !validThread(body.inputThreadId)
        || body.captureAttachments !== undefined && typeof body.captureAttachments !== 'boolean'
        || body.inputAnchor !== undefined && (typeof body.inputAnchor !== 'string' || !/^om_[A-Za-z0-9_-]+$/.test(body.inputAnchor))) throw new Error('invalid_input_capture_request');
      const session = options.session(sessionId);
      const actorOpenId = (body.actorOpenId ?? session?.ownerOpenId) as string;
      if (!session || session.sessionId !== sessionId || !session.active || session.larkAppId !== larkAppId || !/^ou_[A-Za-z0-9_-]+$/.test(actorOpenId) || !matchesOwner(session, actorOpenId)
        || !/^oc_[A-Za-z0-9_-]+$/.test(session.chatId) || !/^(?:om_|oc_)[A-Za-z0-9_-]+$/.test(session.anchor)
        || !options.canTalk(session, actorOpenId)) throw new Error('input_capture_session_unavailable');
      if (!options.pluginEnabled(body.pluginId)) throw new Error('input_capture_plugin_unavailable');
      const anchor = (body.inputAnchor ?? session.anchor) as string;
      if (body.inputThreadId !== undefined && !anchor.startsWith('om_')) throw new Error('invalid_input_capture_request');
      if (body.actorSelector !== undefined && (body.actorSelector !== 'authorized_humans'
        || session.scope !== 'chat' || session.chatType !== 'group' || anchor !== session.chatId)) throw new Error('invalid_input_capture_selector');
      const id = captureDigest([larkAppId, sessionId, body.pluginId, body.requestId]);
      return { id, revision: 1, active: true, larkAppId, sessionId,
        chatId: session.chatId, anchor, sourceAnchor: session.anchor, ownerOpenId: actorOpenId,
        pluginId: body.pluginId as string, requestId: body.requestId as string, providerRef: body.providerRef as string,
        createdAt: new Date().toISOString(), ...(body.captureAttachments === true ? { captureAttachments: true } : {}),
        ...(typeof body.inputThreadId === 'string' ? { inputThreadId: body.inputThreadId } : {}),
        ...(body.actorSelector === 'authorized_humans' ? { actorSelector: 'authorized_humans' as const } : {}),
        requestHash: captureDigest([sessionId, body.pluginId, body.requestId, body.providerRef, actorOpenId,
          anchor, body.inputThreadId ?? null, !!body.captureAttachments, body.actorSelector ?? 'actor']) };
  }
  function installBinding(state: CaptureJournal, snapshot: CaptureSnapshot, binding: InputBinding) {
    if (state.closures?.some(c => c.id === binding.id)) throw new Error('input_capture_registration_closed');
    const prior = state.bindings.find(b => b.id === binding.id);
    if (prior) {
      if (['ownerOpenId','providerRef','anchor','inputThreadId','actorSelector','sourceAnchor'].some(k =>
        prior[k as keyof InputBinding] !== binding[k as keyof InputBinding])
        || !!prior.captureAttachments !== !!binding.captureAttachments) throw new Error('input_capture_identity_conflict');
      return prior;
    }
    if (state.bindings.some(b => b.active && b.chatId === binding.chatId && overlaps(b, binding)
      && (b.anchor === binding.anchor || binding.inputThreadId && bindingThreads(snapshot,b)?.has(binding.inputThreadId)))) {
      throw new Error('input_capture_anchor_conflict');
    }
    if (binding.actorSelector) state.schemaVersion = 4;
    else if (binding.inputThreadId && state.schemaVersion < 3) state.schemaVersion = 3;
    else if (binding.captureAttachments && state.schemaVersion < 2) state.schemaVersion = 2;
    state.bindings.push(binding); return binding;
  }
  function registrationKey(sessionId: string, body: Record<string, unknown>) {
    if (!valid(sessionId) || !valid(body.pluginId,100) || !valid(body.requestId,128)) throw new Error('invalid_input_capture_registration');
    return {id:captureDigest([larkAppId,sessionId,body.pluginId,body.requestId]),sessionId,
      pluginId:body.pluginId as string,requestId:body.requestId as string};
  }
  return {
    managesChat(chatId: string) {
      return store.read().bindings.some(b=>b.active && b.chatId===chatId && b.anchor===chatId && b.actorSelector==='authorized_humans');
    },
    capabilities() { return { schemaVersion: 4, registrationLookup: true, atomicHandover: true, closureFence: true, authorizedHumans: true }; },
    register(sessionId: string, body: Record<string, unknown>) {
      const binding = prepareBinding(sessionId,body);
      return store.transact((state,snapshot) => installBinding(state,snapshot,binding));
    },
    inspectRegistration(sessionId: string, body: Record<string, unknown>) {
      const key = registrationKey(sessionId,body), snapshot = store.readIndexed();
      const closed = snapshot.state.closures?.find(c => c.id === key.id);
      if (closed) return { state:'closed', closure:closed, binding:snapshot.bindingsById.get(key.id) };
      const binding = snapshot.bindingsById.get(key.id);
      return binding ? {state:binding.active?'active':'closed',binding,
        throughSequence:snapshot.inputCounts.get(binding.id) ?? 0} : {state:'absent'};
    },
    reconcile(sessionId: string, body: Record<string, unknown>) {
      if (!valid(body.intentKey,128) || !Array.isArray(body.expected) || !Array.isArray(body.close)
        || !Array.isArray(body.open) || body.expected.length > 64 || body.close.length > 64 || body.open.length > 64) {
        throw new Error('invalid_input_capture_reconcile');
      }
      const intentKey = body.intentKey, requestHash = captureDigest([sessionId,body.expected,body.close,body.open]);
      if (body.requestHash !== requestHash) throw new Error('input_capture_request_hash_conflict');
      const replay = store.read().intents?.find(i => i.intentKey === intentKey);
      if (replay) {
        if (replay.requestHash !== requestHash) throw new Error('input_capture_identity_conflict');
        return replay.result;
      }
      const expected = body.expected.map(row => {
        if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.throughSequence) || row.throughSequence < 0
          || row.expectedRevision !== null && (!Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1)) throw new Error('invalid_input_capture_reconcile');
        return {...registrationKey(row.sessionId ?? sessionId,row),expectedRevision:row.expectedRevision,throughSequence:row.throughSequence};
      });
      const closes = body.close.map(row => registrationKey(row.sessionId ?? sessionId,row));
      const opens = body.open.map(row => prepareBinding(row.sessionId ?? sessionId,row));
      if (new Set(expected.map(e=>e.id)).size !== expected.length
        || new Set(closes.map(e=>e.id)).size !== closes.length || new Set(opens.map(e=>e.id)).size !== opens.length
        || [...closes,...opens].some(e=>!expected.some(c=>c.id===e.id)) || closes.some(c=>opens.some(o=>o.id===c.id))) {
        throw new Error('invalid_input_capture_reconcile');
      }
      return store.transact((state,snapshot) => {
        const replay = state.intents?.find(i=>i.intentKey===intentKey);
        if (replay) {
          if (replay.requestHash !== requestHash) throw new Error('input_capture_identity_conflict');
          return replay.result;
        }
        for (const e of expected) {
          const binding = snapshot.bindingsById.get(e.id), closed = state.closures?.find(c=>c.id===e.id);
          if ((closed?.revision ?? binding?.revision ?? null) !== e.expectedRevision) throw new Error('input_capture_revision_conflict');
          if ((snapshot.inputCounts.get(e.id) ?? 0) !== e.throughSequence) throw new Error('input_capture_inputs_conflict');
        }
        state.schemaVersion=4; state.closures ??=[]; state.intents ??=[];
        const boundaries=closes.map(key=>{
          const prior=state.closures!.find(c=>c.id===key.id);
          if(prior)return prior;
          const binding=snapshot.bindingsById.get(key.id);
          if(binding?.active){binding.active=false;binding.revision++;}
          const closed={...key,revision:binding?.revision ?? 1,throughSequence:snapshot.inputCounts.get(key.id) ?? 0,
            intentKey,closedAt:new Date().toISOString()};
          state.closures!.push(closed);return closed;
        });
        const bindings=opens.map(binding=>installBinding(state,snapshot,binding));
        const result={state:'committed',bindings,closedBoundaries:boundaries};
        state.intents.push({intentKey,requestHash,result:structuredClone(result)});return result;
      });
    },
    inspect(sessionId: string, bindingId: string, page: { after?: unknown; through?: unknown } = {}) {
      const state = store.read(); const binding = state.bindings.find(b => b.id === bindingId && b.sessionId === sessionId);
      if (!binding) return undefined;
      const inputs = state.inputs.filter(row => row.bindingId === bindingId);
      // Preserve the original unpaged response for existing host integrations.
      if (page.after === undefined && page.through === undefined) return { binding, inputs };
      const after = page.after, through = page.through === undefined ? inputs.length : page.through;
      if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0
        || typeof through !== 'number' || !Number.isSafeInteger(through) || through < after || through > inputs.length) {
        throw new Error('invalid_input_capture_page');
      }
      const selected: CapturedInput[] = []; let bytes = 2;
      for (let index = after; index < through && selected.length < 64; index++) {
        const input = inputs[index], size = Buffer.byteLength(JSON.stringify(input)) + 1;
        // One accepted input may exceed the page budget after JSON escaping;
        // retain it in full rather than returning an empty non-progressing page.
        if (selected.length && bytes + size > 128 * 1024) break;
        selected.push(input); bytes += size;
      }
      const last = selected.at(-1)?.sequence ?? after;
      return { binding, inputs: selected, throughSequence: through, nextSequence: last < through ? last : null };
    },
    revoke(sessionId: string, bindingId: string, expectedRevision: number) {
      return store.transact((state, snapshot) => {
        const binding = state.bindings.find(b => b.id === bindingId && b.sessionId === sessionId);
        if (!binding || binding.revision !== expectedRevision) throw new Error('input_capture_revision_conflict');
        if (binding.active) { binding.active = false; binding.revision++; }
        return binding;
      });
    },
    revokeSet(sessionId: string, value: unknown) {
      const conditions = parseInputCaptureConditions(value);
      return store.transact((state, snapshot) => {
        // Check every stream before changing any of them. A new input does not
        // increment the binding revision, so both preconditions are necessary.
        const entries = conditions.map(condition => {
          const binding = state.bindings.find(b => b.id === condition.bindingId && b.sessionId === sessionId);
          if (!binding || binding.revision !== condition.expectedRevision) throw new Error('input_capture_revision_conflict');
          const inputCount = snapshot.inputCounts.get(binding.id) ?? 0;
          if (inputCount !== condition.expectedInputCount) throw new Error('input_capture_inputs_conflict');
          return { binding, inputCount };
        });
        for (const { binding } of entries) {
          if (binding.active) { binding.active = false; binding.revision++; }
        }
        return { bindings: entries };
      });
    },
    resolveThreadAnchor(event: { messageId: string; chatId: string; senderOpenId: string; threadId: string }): string | undefined {
      if (!validThread(event.threadId)) return undefined;
      const snapshot = store.readIndexed(); const state = snapshot.state;
      const owns = (b: InputBinding) => b.chatId === event.chatId && selects(b, event.senderOpenId);
      const historical = state.inputs.find(i => i.messageId === event.messageId
        && owns(snapshot.bindingsById.get(i.bindingId)!));
      if (historical) {
        const binding = snapshot.bindingsById.get(historical.bindingId)!;
        const thread = historical.threadId ?? [...bindingThreads(snapshot, binding)][0];
        if (thread && thread !== event.threadId) {
          throw terminalCaptureRejection('input_capture_message_conflict');
        }
        return thread && binding.anchor !== event.messageId ? binding.anchor : undefined;
      }
      const bindings = state.bindings.filter(b => b.active && owns(b) && b.anchor !== event.messageId
        && bindingThreads(snapshot, b).has(event.threadId));
      if (bindings.length > 1) throw terminalCaptureRejection('input_capture_anchor_conflict');
      return bindings[0]?.anchor;
    },
    capture(event: { messageId: string; chatId: string; anchor: string; senderOpenId: string; threadId?: string;
      memberUnionId?: string; parentId?: string; contentVersion?: string; text: string; attachments?: CaptureAttachment[]; botSender: boolean }): boolean {
      if (event.contentVersion !== undefined && !/^[0-9]{1,20}$/.test(event.contentVersion)) throw new Error('invalid_input_capture_content_version');
      if (event.botSender || !valid(event.messageId) || !valid(event.senderOpenId)
        || event.threadId !== undefined && (!validThread(event.threadId) || !event.anchor.startsWith('om_'))
        || typeof event.text !== 'string' || !event.text.trim() && !event.attachments?.length) return false;
      const snapshot = store.readIndexed(); const state = snapshot.state;
      const historical = state.inputs.find(row => {
        if (row.messageId !== event.messageId || row.contentVersion !== event.contentVersion) return false;
        const b = snapshot.bindingsById.get(row.bindingId)!;
        return b.chatId === event.chatId && (b.anchor === event.anchor || b.actorSelector === 'authorized_humans' && b.anchor === event.chatId) && selects(b, event.senderOpenId);
      });
      if (historical) {
        const threads = bindingThreads(snapshot, snapshot.bindingsById.get(historical.bindingId)!);
        if (historical.senderOpenId !== event.senderOpenId || historical.text !== event.text
          || event.threadId && threads.size && !threads.has(event.threadId)
          || JSON.stringify(parseCaptureAttachments(historical.attachments)) !== JSON.stringify(parseCaptureAttachments(event.attachments))) {
          throw terminalCaptureRejection('input_capture_message_conflict');
        }
        void kick(); return true;
      }
      const binding = [...state.bindings].sort((a,b)=>Number(a.anchor===a.chatId)-Number(b.anchor===b.chatId)).find(b => b.active && b.chatId === event.chatId
        && (b.anchor === event.anchor || b.actorSelector === 'authorized_humans' && b.anchor === event.chatId) && selects(b, event.senderOpenId));
      if (!binding) return false;
      if (event.attachments?.length && !binding.captureAttachments) return false;
      const attachments = parseCaptureAttachments(event.attachments);
      // Once a binding owns a route, invalidated authority must not turn it into
      // an unrelated Worker prompt. Keep the binding for explicit reconciliation.
      const session = options.session(binding.sessionId);
      if (!matchesSession(binding, session) || !options.canTalk(session, event.senderOpenId, event.memberUnionId)) {
        throw terminalCaptureRejection('input_capture_authority_changed');
      }
      if (Buffer.byteLength(event.text, 'utf8') > 64 * 1024) {
        throw terminalCaptureRejection('input_capture_text_too_large');
      }
      store.transact((current, index) => {
        const active = current.bindings.find(b => b.id === binding.id);
        if (!active?.active || active.revision !== binding.revision) {
          throw terminalCaptureRejection('input_capture_revision_conflict');
        }
        if (event.threadId && active.anchor !== active.chatId) {
          const known = bindingThreads(index, active);
          if (known.size && !known.has(event.threadId) || current.bindings.some(b => b.id !== binding.id && b.active
            && b.chatId === event.chatId && selects(b, event.senderOpenId) && bindingThreads(index, b).has(event.threadId!))) {
            throw terminalCaptureRejection('input_capture_anchor_conflict');
          }
        }
        const id = captureDigest(event.contentVersion === undefined ? [binding.id, event.messageId] : [binding.id, event.messageId, event.contentVersion]);
        const prior = current.inputs.find(row => row.id === id);
        if (prior) {
          if (prior.senderOpenId !== event.senderOpenId || prior.text !== event.text
            || prior.threadId && event.threadId && prior.threadId !== event.threadId
            || JSON.stringify(parseCaptureAttachments(prior.attachments)) !== JSON.stringify(attachments)) {
            throw terminalCaptureRejection('input_capture_message_conflict');
          }
          return;
        }
        if (event.threadId && current.schemaVersion < 3) current.schemaVersion = 3;
        current.inputs.push({ id, bindingId: binding.id,
          sequence: (index.inputCounts.get(binding.id) ?? 0) + 1,
          messageId: event.messageId, senderOpenId: event.senderOpenId, text: event.text,
          anchor:event.anchor, ...(event.contentVersion?{contentVersion:event.contentVersion}:{}), ...(event.parentId?{parentId:event.parentId}:{}), ...(event.memberUnionId?{memberUnionId:event.memberUnionId}:{}),
          ...(event.threadId ? { threadId: event.threadId } : {}),
          ...(attachments.length ? { attachments } : {}),
          receivedAt: new Date().toISOString(), delivery: 'pending' });
      });
      void kick(); return true;
    },
    start() {
      if (timer || stopped) return;
      void kick(); timer = setInterval(() => { void kick(); }, 5000); timer.unref();
    },
    drain: kick,
    stop() { stopped = true; clearInterval(timer); return running ?? Promise.resolve(); },
  };
}
export type InputCaptureRuntime = ReturnType<typeof createInputCaptureRuntime>;
const runtimes = new Map<string, InputCaptureRuntime>();
export function setInputCaptureRuntime(appId: string, runtime: InputCaptureRuntime): void { runtimes.set(appId, runtime); }
export function getInputCaptureRuntime(appId: string): InputCaptureRuntime | undefined { return runtimes.get(appId); }

export function stopInputCaptureRuntimes(): Promise<void> {
  return Promise.all([...runtimes.values()].map(runtime => runtime.stop())).then(() => {});
}
