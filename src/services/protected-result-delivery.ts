import { createHash } from 'node:crypto';
import { ProtectedResultStore, type ProtectedResultContext } from './protected-result-store.js';

export class ProtectedResultDeliveryError extends Error {
  constructor(readonly messageIds: string[]) { super('protected_result_delivery_uncertain'); }
}
export function protectedResultProfileAvailable(input: {
  enabled: boolean; withholdCredentials: boolean; sandboxMode?: string;
  managedBinding: boolean; platform: NodeJS.Platform;
}): boolean {
  return input.enabled && input.withholdCredentials && input.managedBinding
    && input.sandboxMode === 'oncall'
    && ['darwin', 'linux'].includes(input.platform);
}

/** One trusted entry point owns direct sensitive delivery, provenance and
 * read fences. Snapshot/validate every file before calling this function. */
export async function deliverProtectedResult(input: {
  store: ProtectedResultStore;
  context: ProtectedResultContext;
  deliveryId: string;
  markdown: string;
  files: Array<{ name: string; data: Buffer }>;
  assertAuthority: () => void;
  upload: (name: string, data: Buffer) => Promise<string>;
  send: (content: string, type: 'interactive' | 'file', uuid: string) => Promise<string>;
  render: (markdown: string) => string;
}): Promise<string[]> {
  input.assertAuthority();
  const payloadDigest = createHash('sha256').update(input.markdown);
  for (const file of input.files) payloadDigest.update(`\0${file.name}\0`).update(file.data);
  const begun = input.store.begin(input.context, input.deliveryId, payloadDigest.digest('hex'));
  if (!begun.created) {
    if (begun.record.status !== 'delivered') throw new ProtectedResultDeliveryError(begun.record.messages.map(message => message.messageId));
    return [...begun.record.messages].sort((a, b) => Number(b.kind === 'primary') - Number(a.kind === 'primary'))
      .map(message => message.messageId);
  }
  const uuid = (kind: string) => `prd_${createHash('sha256').update(JSON.stringify([
    input.context, input.deliveryId, kind,
  ])).digest('hex').slice(0, 46)}`;
  let writeAttempted = false;
  const messages: string[] = [];
  try {
    const keys: string[] = [];
    for (const file of input.files) {
      input.assertAuthority();
      const resource = await input.upload(file.name, file.data);
      input.store.update(input.context, input.deliveryId, { resource });
      input.assertAuthority();
      keys.push(resource);
    }
    for (const resource of keys) {
      input.assertAuthority();
      writeAttempted = true;
      const messageId = await input.send(JSON.stringify({ file_key: resource }), 'file', uuid(`file:${messages.length}`));
      messages.push(messageId);
      input.store.update(input.context, input.deliveryId, { message: { messageId, kind: 'attachment' } });
    }
    // The card is the completion marker. A failed file never leaves a card
    // claiming all requested artifacts have arrived.
    input.assertAuthority();
    const card = input.render(input.markdown || '查询结果文件见附件。');
    writeAttempted = true;
    const messageId = await input.send(card, 'interactive', uuid('primary'));
    messages.unshift(messageId);
    input.store.update(input.context, input.deliveryId, { message: { messageId, kind: 'primary' } });
    input.store.update(input.context, input.deliveryId, { status: 'delivered' });
    return messages;
  } catch {
    try { input.store.update(input.context, input.deliveryId, { status: writeAttempted ? 'unknown' : 'aborted' }); }
    catch { /* The durable pending fence remains closed after disk failure. */ }
    throw new ProtectedResultDeliveryError(messages);
  }
}
