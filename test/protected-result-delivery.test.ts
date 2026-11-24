import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import { ProtectedResultStore, PROTECTED_RESULT_PLACEHOLDER, type ProtectedResultContext } from '../src/services/protected-result-store.js';
import { deliverProtectedResult, protectedResultProfileAvailable } from '../src/services/protected-result-delivery.js';

const roots: string[] = [];
const secret = 'SYNTHETIC_PROTECTED_RESULT_9381';
const context: ProtectedResultContext = { appId: 'cli_writer', pluginId: 'synthetic-plugin',
  sessionId: 'session_one', turnId: 'om_turn', ownerUnionId: 'on_owner', chatId: 'oc_chat', rootMessageId: 'om_root' };
function raw(id = 'om_primary', chat = context.chatId, type = 'interactive') {
  return { message_id: id, chat_id: chat, msg_type: type, create_time: '1700000000000',
    body: { content: JSON.stringify({ text: secret, file_key: 'file_sensitive', file_name: `${secret}.xlsx` }) },
    sender: { id: 'cli_writer', sender_type: 'app' }, card_json: { business: secret } };
}
function fixture(options: ConstructorParameters<typeof ProtectedResultStore>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'protected-result-')); roots.push(root);
  const store = new ProtectedResultStore(root, options);
  const writes: string[] = [];
  const input = { store, context, deliveryId: 'delivery_abcdefgh', markdown: secret,
    files: [{ name: 'synthetic.xlsx', data: Buffer.from('synthetic-file-bytes') }],
    assertAuthority: vi.fn(), upload: vi.fn(async () => 'file_sensitive'),
    send: vi.fn(async (_body: string, type: string) => { writes.push(type); return type === 'file' ? 'om_attachment' : 'om_primary'; }),
    render: (markdown: string) => JSON.stringify({ body: markdown }),
  };
  return { root, store, writes, input };
}
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('protected plugin result delivery', () => {
  it('only advertises protection for an explicitly isolated managed local session', () => {
    const input = { enabled: true, withholdCredentials: true, managedBinding: true, sandboxMode: 'oncall', platform: 'linux' as const };
    expect(protectedResultProfileAvailable(input)).toBe(true);
    expect(protectedResultProfileAvailable({ ...input, platform: 'darwin' })).toBe(true);
    for (const change of [{ enabled: false }, { withholdCredentials: false }, { managedBinding: false },
      { sandboxMode: 'off' }, { sandboxMode: 'scratch' }, { platform: 'win32' as const }]) {
      expect(protectedResultProfileAvailable({ ...input, ...change })).toBe(false);
    }
  });
  it('fences before the first visible write, delivers one set, and leaves ordinary history readable', async () => {
    const f = fixture();
    f.input.send.mockImplementation(async (_body, type) => {
      expect(f.store.redactMessage(raw('om_not_yet_recorded')).body.content).toContain(PROTECTED_RESULT_PLACEHOLDER);
      expect(f.store.status(context, f.input.deliveryId).status).toBe('pending');
      f.writes.push(type);
      return type === 'file' ? 'om_attachment' : 'om_primary';
    });
    expect(await deliverProtectedResult(f.input)).toEqual(['om_primary', 'om_attachment']);
    expect(f.writes).toEqual(['file', 'interactive']);
    expect(f.store.redactMessage(raw()).body.content).toContain(PROTECTED_RESULT_PLACEHOLDER);
    expect(JSON.stringify(f.store.redactMessage(raw()))).not.toContain(secret);
    for (const deleted of [true, false]) {
      expect(f.store.redactMessage({ ...raw(), deleted }).deleted).toBe(deleted);
    }
    expect(f.store.redactMessage(raw()).deleted).toBeUndefined();
    const ordinary = { message_id: 'om_ordinary', chat_id: context.chatId, msg_type: 'text', body: { content: '{"text":"ordinary"}' } };
    expect(f.store.redactMessage(ordinary)).toBe(ordinary);
    expect(f.store.redactMessage({ ...ordinary, chat_id: 'oc_other' })).toEqual({ ...ordinary, chat_id: 'oc_other' });
    expect(() => f.store.assertResourceReadable('om_attachment', 'file_sensitive')).toThrow(/read_denied/);
    expect(JSON.stringify(f.store.status(context, f.input.deliveryId))).not.toContain(secret);
    expect(f.store.status({ ...context, ownerUnionId: 'on_other' }, f.input.deliveryId).status).toBe('not_found');
    expect(f.store.status({ ...context, appId: 'cli_other' }, f.input.deliveryId).status).toBe('not_found');
    expect(f.store.status({ ...context, sessionId: 'session_other' }, f.input.deliveryId).status).toBe('not_found');
    expect(await deliverProtectedResult(f.input)).toEqual(['om_primary', 'om_attachment']);
    expect(f.input.send).toHaveBeenCalledTimes(2);
    expect(await deliverProtectedResult({ ...f.input, context: { ...context, turnId: 'om_retry_turn' } })).toEqual(['om_primary', 'om_attachment']);
    expect(f.input.send).toHaveBeenCalledTimes(2);
    expect(f.store.statusForCaller(context, context.pluginId, f.input.deliveryId).status).toBe('delivered');
    expect(f.store.completedFinal(context.appId, context.sessionId, 'om_retry_turn')).toEqual(['om_primary', 'om_attachment']);
  });
  it('keeps uncertain writes fenced through timeout, process reconstruction and late failures', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const f = fixture();
    f.input.send.mockRejectedValueOnce(new Error('provider accepted, ACK lost'));
    await expect(deliverProtectedResult(f.input)).rejects.toThrow('protected_result_delivery_uncertain');
    vi.advanceTimersByTime(35 * 24 * 60 * 60_000);
    const restarted = new ProtectedResultStore(f.root);
    expect(restarted.status(context, f.input.deliveryId).status).toBe('unknown');
    expect(restarted.redactMessage(raw('om_unknown')).body.content).toContain(PROTECTED_RESULT_PLACEHOLDER);
    await expect(deliverProtectedResult({ ...f.input, store: restarted })).rejects.toThrow(/uncertain/);
    expect(f.input.send).toHaveBeenCalledTimes(1);
  });
  it('does not publish after manual authority replacement during upload', async () => {
    const f = fixture(); let allowed = true;
    f.input.assertAuthority.mockImplementation(() => { if (!allowed) throw new Error('authority replaced'); });
    f.input.upload.mockImplementation(async () => { allowed = false; return 'file_sensitive'; });
    await expect(deliverProtectedResult(f.input)).rejects.toThrow(/uncertain/);
    expect(f.input.send).not.toHaveBeenCalled();
    expect(f.store.status(context, f.input.deliveryId).status).toBe('aborted');
    expect(f.store.redactMessage({ message_id: 'om_safe', chat_id: context.chatId, msg_type: 'text', body: { content: 'safe' } }).body.content).toBe('safe');
  });
  it('retains the read fence when the provider succeeds but committing provenance fails', async () => {
    let writes = 0;
    const f = fixture({ persist(path, content) {
      writes += 1;
      if (writes >= 3) throw new Error('disk unavailable');
      atomicWriteFileSync(path, content, { mode: 0o600, durable: true, followTargetSymlink: false });
    } });
    await expect(deliverProtectedResult(f.input)).rejects.toThrow(/uncertain/);
    expect(f.input.send).toHaveBeenCalledTimes(1);
    const restarted = new ProtectedResultStore(f.root);
    expect(restarted.status(context, f.input.deliveryId).status).toBe('pending');
    expect(restarted.redactMessage(raw('om_provider_accepted')).body.content).toContain(PROTECTED_RESULT_PLACEHOLDER);
  });
  it('protects copied resource keys and refuses opaque forwarded trees without provenance', async () => {
    const f = fixture(); await deliverProtectedResult(f.input);
    expect(JSON.stringify(f.store.redactMessage(raw('om_copy', 'oc_other', 'file')))).not.toContain('file_sensitive');
    expect(JSON.stringify(f.store.redactMessage(raw('om_forward', 'oc_other', 'merge_forward')))).not.toContain(secret);
  });
  it('fails closed on a corrupted index and rejects a reused id with a different payload', async () => {
    const f = fixture(); await deliverProtectedResult(f.input);
    await expect(deliverProtectedResult({ ...f.input, markdown: 'different' })).rejects.toThrow(/conflict/);
    const index = readdirSync(join(f.root, 'protected-results-v1')).find(path => path.endsWith('.json'))!;
    writeFileSync(join(f.root, 'protected-results-v1', index), '{broken', { mode: 0o600 });
    expect(() => f.store.redactMessage(raw())).toThrow();
    expect(f.input.send).toHaveBeenCalledTimes(2);
  });
  it('preserves explicit opt-in provenance after a clean restart without storing result bodies', async () => {
    const f = fixture(); const hash = createHash('sha256').update('payload').digest('hex');
    f.store.begin(context, 'receipt_abcdefgh', hash);
    f.store.update(context, 'receipt_abcdefgh', { message: { messageId: 'om_primary', kind: 'primary' } });
    f.store.update(context, 'receipt_abcdefgh', { status: 'delivered' });
    f.store.update(context, 'receipt_abcdefgh', { status: 'unknown' });
    const restarted = new ProtectedResultStore(f.root);
    expect(restarted.status(context, 'receipt_abcdefgh').status).toBe('delivered');
    expect(() => restarted.update(context, 'receipt_abcdefgh', { message: { messageId: 'om_late', kind: 'attachment' } })).toThrow(/already_complete/);
  });
});
