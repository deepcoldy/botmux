import { captureDigest, createInputCaptureStore, type CapturedInput, type InputBinding, type CaptureSnapshot } from './store.js';
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
const valid = (s: unknown, max = 200): s is string => typeof s === 'string'
  && !!s.trim() && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s);
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
    || !session.ownerOpenId && session.scope === 'chat' && session.chatType === 'group' && session.anchor === session.chatId;
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
  return {
    register(sessionId: string, body: Record<string, unknown>) {
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
      const id = captureDigest([larkAppId, sessionId, body.pluginId, body.requestId]);
      return store.transact((state, snapshot) => {
        const prior = state.bindings.find(b => b.id === id);
        if (prior) {
          if (!matchesSession(prior, session) || prior.ownerOpenId !== actorOpenId || prior.providerRef !== body.providerRef || prior.anchor !== anchor
            || prior.inputThreadId !== body.inputThreadId
            || !!prior.captureAttachments !== !!body.captureAttachments) throw new Error('input_capture_identity_conflict');
          return prior;
        }
        if (state.bindings.some(b => b.active && b.chatId === session.chatId
          && b.ownerOpenId === actorOpenId && (b.anchor === anchor
            || typeof body.inputThreadId === 'string' && bindingThreads(snapshot, b).has(body.inputThreadId)))) throw new Error('input_capture_anchor_conflict');
        const binding: InputBinding = { id, revision: 1, active: true, larkAppId, sessionId,
          chatId: session.chatId, anchor, sourceAnchor: session.anchor, ownerOpenId: actorOpenId,
          pluginId: body.pluginId as string, requestId: body.requestId as string, providerRef: body.providerRef as string,
          createdAt: new Date().toISOString(), ...(body.captureAttachments === true ? { captureAttachments: true } : {}),
          ...(typeof body.inputThreadId === 'string' ? { inputThreadId: body.inputThreadId } : {}) };
        // Opt-in data needs a new journal version: old readers must not advertise
        // persisted attachment capability while running a text-only implementation.
        if (binding.inputThreadId) state.schemaVersion = 3;
        else if (binding.captureAttachments && state.schemaVersion < 2) state.schemaVersion = 2;
        state.bindings.push(binding); return binding;
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
      const owns = (b: InputBinding) => b.chatId === event.chatId && b.ownerOpenId === event.senderOpenId;
      const historical = state.inputs.find(i => i.messageId === event.messageId
        && owns(snapshot.bindingsById.get(i.bindingId)!));
      if (historical) {
        const binding = snapshot.bindingsById.get(historical.bindingId)!;
        const thread = historical.threadId ?? [...bindingThreads(snapshot, binding)][0];
        if (thread && thread !== event.threadId) throw new Error('input_capture_message_conflict');
        return thread && binding.anchor !== event.messageId ? binding.anchor : undefined;
      }
      const bindings = state.bindings.filter(b => b.active && owns(b) && b.anchor !== event.messageId
        && bindingThreads(snapshot, b).has(event.threadId));
      if (bindings.length > 1) throw new Error('input_capture_anchor_conflict');
      return bindings[0]?.anchor;
    },
    capture(event: { messageId: string; chatId: string; anchor: string; senderOpenId: string; threadId?: string;
      memberUnionId?: string; text: string; attachments?: CaptureAttachment[]; botSender: boolean }): boolean {
      if (event.botSender || !valid(event.messageId) || !valid(event.senderOpenId)
        || event.threadId !== undefined && (!validThread(event.threadId) || !event.anchor.startsWith('om_'))
        || typeof event.text !== 'string' || !event.text.trim() && !event.attachments?.length) return false;
      const snapshot = store.readIndexed(); const state = snapshot.state;
      const historical = state.inputs.find(row => {
        if (row.messageId !== event.messageId) return false;
        const b = snapshot.bindingsById.get(row.bindingId)!;
        return b.chatId === event.chatId && b.anchor === event.anchor && b.ownerOpenId === event.senderOpenId;
      });
      if (historical) {
        const threads = bindingThreads(snapshot, snapshot.bindingsById.get(historical.bindingId)!);
        if (historical.text !== event.text
          || event.threadId && threads.size && !threads.has(event.threadId)
          || JSON.stringify(parseCaptureAttachments(historical.attachments)) !== JSON.stringify(parseCaptureAttachments(event.attachments))) {
          throw new Error('input_capture_message_conflict');
        }
        void kick(); return true;
      }
      const binding = state.bindings.find(b => b.active && b.chatId === event.chatId
        && b.anchor === event.anchor && b.ownerOpenId === event.senderOpenId);
      if (!binding) return false;
      if (event.attachments?.length && !binding.captureAttachments) return false;
      const attachments = parseCaptureAttachments(event.attachments);
      // Once a binding owns a route, invalidated authority must not turn it into
      // an unrelated Worker prompt. Keep the binding for explicit reconciliation.
      const session = options.session(binding.sessionId);
      if (!matchesSession(binding, session) || !options.canTalk(session, event.senderOpenId, event.memberUnionId)) {
        throw new Error('input_capture_authority_changed');
      }
      if (Buffer.byteLength(event.text, 'utf8') > 64 * 1024) throw new Error('input_capture_text_too_large');
      store.transact((current, index) => {
        const active = current.bindings.find(b => b.id === binding.id);
        if (!active?.active || active.revision !== binding.revision) throw new Error('input_capture_revision_conflict');
        if (event.threadId) {
          const known = bindingThreads(index, active);
          if (known.size && !known.has(event.threadId) || current.bindings.some(b => b.id !== binding.id && b.active
            && b.chatId === event.chatId && b.ownerOpenId === event.senderOpenId && bindingThreads(index, b).has(event.threadId!))) {
            throw new Error('input_capture_anchor_conflict');
          }
        }
        const id = captureDigest([binding.id, event.messageId]);
        const prior = current.inputs.find(row => row.id === id);
        if (prior) {
          if (prior.senderOpenId !== event.senderOpenId || prior.text !== event.text
            || prior.threadId && event.threadId && prior.threadId !== event.threadId
            || JSON.stringify(parseCaptureAttachments(prior.attachments)) !== JSON.stringify(attachments)) throw new Error('input_capture_message_conflict');
          return;
        }
        if (event.threadId) current.schemaVersion = 3;
        current.inputs.push({ id, bindingId: binding.id,
          sequence: (index.inputCounts.get(binding.id) ?? 0) + 1,
          messageId: event.messageId, senderOpenId: event.senderOpenId, text: event.text,
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
