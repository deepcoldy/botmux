import { extractFeishuCardMarkdownImageKeys } from '../im/lark/card-markdown-image-references.js';
import { createHash } from 'node:crypto';
import { ProtectedResultStore, type ProtectedResultContext, type ProtectedResultRecord } from './protected-result-store.js';

type ProtectedMessages = ProtectedResultRecord['messages'];
export interface ProtectedResultDeliveryReceipt { messageIds: string[]; messages: ProtectedMessages }
function receipt(messages: ProtectedMessages): ProtectedResultDeliveryReceipt {
  const ordered = [...messages].sort((a, b) => Number(b.kind === 'primary') - Number(a.kind === 'primary'));
  return { messageIds: ordered.map(message => message.messageId), messages: ordered };
}
export class ProtectedResultDeliveryError extends Error {
  constructor(readonly messages: ProtectedMessages) { super('protected_result_delivery_uncertain'); }
  get messageIds(): string[] { return this.messages.map(message => message.messageId); }
}

// Inspect the actual rendered payload, including nested Markdown components.
// Code spans in Markdown are deliberately handled by the shared Markdown parser.
function cardResources(card: string): Set<string> {
  const resources = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string') {
        if (['img_key', 'image_key', 'file_key'].includes(key)) resources.add(child);
        for (const resource of extractFeishuCardMarkdownImageKeys(child)) resources.add(resource);
      } else visit(child);
    }
  };
  visit(JSON.parse(card));
  return resources;
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
}): Promise<ProtectedResultDeliveryReceipt> {
  input.assertAuthority();
  // A versioned manifest frames every value and file boundary unambiguously.
  const payloadDigest = createHash('sha256').update(JSON.stringify({
    version: 2, markdown: input.markdown,
    files: input.files.map(file => ({ name: file.name, size: file.data.length,
      sha256: createHash('sha256').update(file.data).digest('hex') })),
  })).digest('hex');
  const begun = input.store.begin(input.context, input.deliveryId, payloadDigest);
  if (!begun.created) {
    if (begun.record.status !== 'delivered') throw new ProtectedResultDeliveryError(begun.record.messages);
    return receipt(begun.record.messages);
  }
  const uuid = (kind: string) => `prd_${createHash('sha256').update(JSON.stringify([
    input.context, input.deliveryId, kind,
  ])).digest('hex').slice(0, 46)}`;
  let writeAttempted = false;
  const messages: ProtectedMessages = [];
  try {
    const card = input.render(input.markdown || '查询结果文件见附件。');
    const inlineResources = cardResources(card);
    for (const resource of extractFeishuCardMarkdownImageKeys(input.markdown)) inlineResources.add(resource);
    if (inlineResources.size) {
      input.store.update(input.context, input.deliveryId, { resourceRegistrationPending: true });
      writeAttempted = true;
    }
    for (const resource of inlineResources) input.store.update(input.context, input.deliveryId, { resource });
    if (inlineResources.size) input.store.update(input.context, input.deliveryId, { resourceRegistrationPending: false });
    const keys: string[] = [];
    for (const file of input.files) {
      input.assertAuthority();
      // Persist intent before upload: an accepted upload with a lost key/ACK
      // must fence resource copies even outside the original chat after restart.
      input.store.update(input.context, input.deliveryId, { resourceRegistrationPending: true });
      writeAttempted = true;
      const resource = await input.upload(file.name, file.data);
      input.store.update(input.context, input.deliveryId, { resource, resourceRegistrationPending: false });
      input.assertAuthority();
      keys.push(resource);
    }
    for (const resource of keys) {
      input.assertAuthority();
      writeAttempted = true;
      const messageId = await input.send(JSON.stringify({ file_key: resource }), 'file', uuid(`file:${messages.length}`));
      messages.push({ messageId, kind: 'attachment' });
      input.store.update(input.context, input.deliveryId, { message: { messageId, kind: 'attachment' } });
    }
    // The card is the completion marker. A failed file never leaves a card
    // claiming all requested artifacts have arrived.
    input.assertAuthority();
    writeAttempted = true;
    const messageId = await input.send(card, 'interactive', uuid('primary'));
    messages.unshift({ messageId, kind: 'primary' });
    input.store.update(input.context, input.deliveryId, { message: { messageId, kind: 'primary' } });
    input.store.update(input.context, input.deliveryId, { status: 'delivered' });
    return receipt(messages);
  } catch {
    try { input.store.update(input.context, input.deliveryId, { status: writeAttempted ? 'unknown' : 'aborted' }); }
    catch { /* The durable pending fence remains closed after disk failure. */ }
    throw new ProtectedResultDeliveryError(messages);
  }
}
