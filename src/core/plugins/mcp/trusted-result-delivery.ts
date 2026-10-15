import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const BOTMUX_HOST_DELIVERY_META_KEY = 'botmuxHostDelivery';

export const MAX_TRUSTED_DELIVERY_MARKDOWN_CHARS = 50_000;
export const MAX_TRUSTED_DELIVERY_FILES = 8;
export const MAX_TRUSTED_DELIVERY_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TRUSTED_DELIVERY_TOTAL_BYTES = 16 * 1024 * 1024;

export interface TrustedResultDeliveryFile {
  name: string;
  /** Host-owned in-memory snapshot. Never serialized back to the plugin/model. */
  data: Buffer;
}
export interface TrustedResultDelivery {
  schemaVersion: 1;
  deliveryId: string;
  markdown?: string;
  files?: TrustedResultDeliveryFile[];
  responseKind?: 'final' | 'auxiliary';
}

export interface TrustedResultDeliveryReceipt {
  delivered: true;
  deliveryId: string;
  fileCount: number;
}

/** A delivery effect failed after the complete envelope was validated. Only
 * acknowledged message ids cross this boundary; the original content, file
 * names, provider payload, and error details remain out of result storage. */
export class TrustedResultDeliveryEffectError extends Error {
  constructor(readonly messageIds: string[]) {
    super('plugin_result_delivery_effect_failed');
    this.name = 'TrustedResultDeliveryEffectError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertNoSymlinkPath(root: string, target: string): void {
  const rel = relative(root, target);
  if (!rel || rel === '.') return;
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('invalid_host_delivery_file_type');
  }
}

export interface TrustedResultDeliveryIpcFile {
  name: string;
  dataBase64: string;
}

export interface DecodedTrustedResultDeliveryIpcEnvelope {
  deliveryId: string;
  markdown?: string;
  files: Array<{ name: string; data: Buffer }>;
  responseKind: 'final' | 'auxiliary';
}

/** Serializes the complete host-delivery transaction, including the daemon's
 * final receipt. Queue progress is independent of whether the prior task
 * succeeds or rejects, so daemon rejection and IPC disconnect both release
 * the next task without permitting concurrent large IPC payloads. */
export class TrustedResultDeliverySerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

export function trustedResultDeliveryIpcFiles(
  delivery: TrustedResultDelivery,
): TrustedResultDeliveryIpcFile[] {
  return (delivery.files ?? []).map(file => ({
    name: file.name,
    dataBase64: file.data.toString('base64'),
  }));
}

interface IpcSender {
  connected?: boolean;
  send(message: unknown, callback: (error: Error | null) => void): boolean;
}

/** Wait for the IPC serialization callback instead of piling large base64
 * payloads into the channel. A false return means backpressure, not failure;
 * the callback is still the release boundary. */
export function sendTrustedDeliveryIpcWithBackpressure(
  sender: IpcSender,
  message: unknown,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (sender.connected === false) {
      rejectPromise(new Error('plugin_result_delivery_ipc_disconnected'));
      return;
    }
    let settled = false;
    const finish = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    try {
      sender.send(message, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Validate and decode the entire worker IPC payload before the daemon builds
 * a card, uploads a file, or calls scopedReply. This keeps malformed envelopes
 * at zero external side effects, including failures in the last attachment. */
export function decodeTrustedResultDeliveryIpcEnvelope(
  value: {
    deliveryId?: unknown;
    markdown?: unknown;
    files?: unknown;
    responseKind?: unknown;
  },
  validateMarkdown?: (markdown: string) => void,
): DecodedTrustedResultDeliveryIpcEnvelope {
  const deliveryId = typeof value.deliveryId === 'string' ? value.deliveryId.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(deliveryId)) {
    throw new Error('invalid_plugin_result_delivery_id');
  }
  const markdown = value.markdown;
  if (markdown !== undefined
    && (typeof markdown !== 'string' || markdown.length > MAX_TRUSTED_DELIVERY_MARKDOWN_CHARS)) {
    throw new Error('invalid_plugin_result_delivery_markdown');
  }
  const responseKind = value.responseKind;
  if (responseKind !== 'final' && responseKind !== 'auxiliary') {
    throw new Error('invalid_plugin_result_delivery_response_kind');
  }
  const rawFiles = value.files ?? [];
  if (!Array.isArray(rawFiles) || rawFiles.length > MAX_TRUSTED_DELIVERY_FILES) {
    throw new Error('invalid_plugin_result_delivery_files');
  }
  if (!(typeof markdown === 'string' && markdown.trim()) && rawFiles.length === 0) {
    throw new Error('empty_plugin_result_delivery');
  }
  let totalBytes = 0;
  const files = rawFiles.map((raw) => {
    if (!isRecord(raw)
      || typeof raw.name !== 'string'
      || raw.name.length < 1
      || raw.name.length > 180
      || raw.name === '.'
      || raw.name === '..'
      || !/^[A-Za-z0-9._-]+$/.test(raw.name)
      || typeof raw.dataBase64 !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.dataBase64)) {
      throw new Error('invalid_plugin_result_delivery_file');
    }
    const data = Buffer.from(raw.dataBase64, 'base64');
    if (data.toString('base64') !== raw.dataBase64) {
      throw new Error('invalid_plugin_result_delivery_base64');
    }
    if (data.byteLength > MAX_TRUSTED_DELIVERY_FILE_BYTES) {
      throw new Error('plugin_result_delivery_file_too_large');
    }
    totalBytes += data.byteLength;
    if (totalBytes > MAX_TRUSTED_DELIVERY_TOTAL_BYTES) {
      throw new Error('plugin_result_delivery_files_too_large');
    }
    return { name: raw.name, data };
  });
  // Run target-card validation only after the complete IPC envelope has been
  // decoded, but still before the caller can build/send a card or upload a file.
  if (typeof markdown === 'string' && markdown.trim()) validateMarkdown?.(markdown);
  return {
    deliveryId,
    ...(markdown !== undefined ? { markdown: markdown as string } : {}),
    files,
    responseKind,
  };
}

export async function deliverValidatedTrustedResultDelivery(
  value: Parameters<typeof decodeTrustedResultDeliveryIpcEnvelope>[0],
  effects: {
    validateMarkdown?(markdown: string): void;
    sendMarkdown(markdown: string): Promise<string>;
    sendFile(file: { name: string; data: Buffer }, index: number): Promise<string>;
  },
): Promise<string[]> {
  // Keep this as the first operation. In particular, do not build a card in a
  // callback argument before the complete envelope has passed validation.
  const envelope = decodeTrustedResultDeliveryIpcEnvelope(value, effects.validateMarkdown);
  const messageIds: string[] = [];
  try {
    if (envelope.markdown?.trim()) {
      messageIds.push(await effects.sendMarkdown(envelope.markdown));
    }
    for (let index = 0; index < envelope.files.length; index += 1) {
      messageIds.push(await effects.sendFile(envelope.files[index], index));
    }
  } catch {
    throw new TrustedResultDeliveryEffectError([...messageIds]);
  }
  return messageIds;
}

export function trustedResultTerminalObservation(
  delivery: TrustedResultDelivery,
  messageIds: string[],
): { messageId?: string; terminalCarrier: 'standard_reply_card' | 'non_patchable' } {
  const hasMarkdownCard = !!delivery.markdown?.trim();
  return {
    messageId: hasMarkdownCard ? messageIds[0] : messageIds.at(-1),
    terminalCarrier: hasMarkdownCard ? 'standard_reply_card' : 'non_patchable',
  };
}

/**
 * Parse a plugin-requested delivery and pin every attachment to the plugin's
 * private outbound directory. The caller must invoke this only for a local
 * stdio MCP server; remote transports are intentionally ineligible.
 */
export function parseTrustedResultDelivery(
  value: unknown,
  pluginHome: string,
  validateMarkdown?: (markdown: string) => void,
): TrustedResultDelivery {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('invalid_host_delivery_schema');
  }
  const deliveryId = typeof value.deliveryId === 'string' ? value.deliveryId.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(deliveryId)) {
    throw new Error('invalid_host_delivery_id');
  }
  const markdown = value.markdown;
  if (markdown !== undefined
    && (typeof markdown !== 'string' || markdown.length > MAX_TRUSTED_DELIVERY_MARKDOWN_CHARS)) {
    throw new Error('invalid_host_delivery_markdown');
  }
  const responseKind = value.responseKind;
  if (responseKind !== undefined && responseKind !== 'final' && responseKind !== 'auxiliary') {
    throw new Error('invalid_host_delivery_response_kind');
  }
  const rawFiles = value.files ?? [];
  if (!Array.isArray(rawFiles) || rawFiles.length > MAX_TRUSTED_DELIVERY_FILES) {
    throw new Error('invalid_host_delivery_files');
  }
  if (!markdown?.trim() && rawFiles.length === 0) throw new Error('empty_host_delivery');
  // Reject an oversized target card before resolving/opening attachments.
  // This keeps the source artifacts available for a smaller retry.
  if (typeof markdown === 'string' && markdown.trim()) validateMarkdown?.(markdown);

  const realPluginHome = realpathSync(pluginHome);
  const outboundPath = resolve(realPluginHome, 'outbound');
  if (lstatSync(outboundPath).isSymbolicLink()) throw new Error('invalid_host_delivery_outbound_root');
  const outboundRoot = realpathSync(outboundPath);
  if (!inside(realPluginHome, outboundRoot)) throw new Error('host_delivery_outbound_outside_plugin_home');
  let totalBytes = 0;
  const opened: Array<{ fd: number; path: string; name: string; size: number }> = [];
  try {
    for (const raw of rawFiles) {
      if (!isRecord(raw) || typeof raw.path !== 'string' || !raw.path.trim()) {
        throw new Error('invalid_host_delivery_file');
      }
      const requested = resolve(isAbsolute(raw.path) ? raw.path : resolve(outboundRoot, raw.path));
      if (lstatSync(requested).isSymbolicLink()) throw new Error('invalid_host_delivery_file_type');
      const filePath = realpathSync(requested);
      if (!inside(outboundRoot, filePath)) throw new Error('host_delivery_file_outside_plugin_home');
      assertNoSymlinkPath(outboundRoot, filePath);
      const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw new Error('invalid_host_delivery_file_type');
        if (stat.size > MAX_TRUSTED_DELIVERY_FILE_BYTES) throw new Error('host_delivery_file_too_large');
        totalBytes += stat.size;
        if (totalBytes > MAX_TRUSTED_DELIVERY_TOTAL_BYTES) throw new Error('host_delivery_files_too_large');
        const rawName = basename(filePath);
        const extension = extname(rawName).replace(/[^A-Za-z0-9.]/g, '');
        const safeBase = basename(rawName, extname(rawName))
          .slice(0, Math.max(1, 180 - extension.length))
          .replace(/[^A-Za-z0-9._-]/g, '_') || 'attachment';
        const safeName = `${safeBase}${extension}`;
        opened.push({ fd, path: filePath, name: safeName, size: stat.size });
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    }
    return {
      schemaVersion: 1,
      deliveryId,
      ...(markdown !== undefined ? { markdown } : {}),
      ...(opened.length ? {
        files: opened.map(({ fd, name, size }) => {
          const data = readFileSync(fd);
          if (data.length !== size) throw new Error('host_delivery_file_changed_during_snapshot');
          return { name, data };
        }),
      } : {}),
      ...(responseKind ? { responseKind } : {}),
    };
  } finally {
    // Consuming the envelope consumes every validated plugin artifact whether
    // downstream delivery succeeds or fails. The authoritative bytes now live
    // only in worker memory and cannot be rewritten by the same-UID plugin.
    let cleanupError: Error | undefined;
    for (const file of opened) {
      try { closeSync(file.fd); } catch { /* already closed */ }
      try {
        unlinkSync(file.path);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') cleanupError ??= new Error('host_delivery_source_cleanup_failed');
      }
    }
    if (cleanupError) throw cleanupError;
  }
}
