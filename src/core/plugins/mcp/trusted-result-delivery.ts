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
import type { LinkRefMode } from '../../../services/link-ref-types.js';
import type {
  OutboundLinkRefPayload,
  ResolvedOutboundLinkRefs,
} from '../../../services/link-ref-resolver.js';

export const BOTMUX_HOST_DELIVERY_META_KEY = 'botmuxHostDelivery';

export const MAX_TRUSTED_DELIVERY_MARKDOWN_CHARS = 50_000;
export const MAX_TRUSTED_DELIVERY_FILES = 8;
export const MAX_TRUSTED_DELIVERY_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TRUSTED_DELIVERY_TOTAL_BYTES = 16 * 1024 * 1024;

export interface TrustedResultDeliveryFile {
  name: string;
  /** Host-owned in-memory snapshot. Never serialized back to the plugin/model. */
  data: Buffer;
  /** Validated source path, consumed only after durable host persistence. */
  sourcePath: string;
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

/** Resolve host-delivery Markdown before the callback that creates a durable
 * artifact. Enabled-mode failures deliberately propagate so callers cannot
 * persist or send a receipt containing an unresolved placeholder. */
export async function resolveTrustedResultDeliveryLinkRefs(input: {
  delivery: TrustedResultDelivery;
  mode: LinkRefMode;
  resolve: (payload: OutboundLinkRefPayload) => Promise<ResolvedOutboundLinkRefs>;
  persist?: (delivery: TrustedResultDelivery) => void | Promise<void>;
}): Promise<TrustedResultDelivery> {
  let delivery = input.delivery;
  if (input.mode === 'enabled' && delivery.markdown !== undefined) {
    const resolved = await input.resolve({ text: delivery.markdown });
    delivery = {
      ...delivery,
      markdown: resolved.text ?? delivery.markdown,
    };
  }
  await input.persist?.(delivery);
  return delivery;
}

export const TRUSTED_RESULT_DELIVERY_ACK_TIMEOUT_MS = 120_000;

/**
 * Wait for the daemon's authoritative delivery result. A definite daemon
 * rejection revokes the stored artifact. A local acknowledgement timeout does
 * not: the provider send may already have succeeded while its reply is late,
 * and revoking here would leave a visible entry card with a dead link.
 */
export async function awaitTrustedResultDeliveryAck<T>(
  response: Promise<T>,
  opts: {
    revoke: () => void;
    timeoutMs?: number;
  },
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? TRUSTED_RESULT_DELIVERY_ACK_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error('plugin_result_delivery_timeout');
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([response, timeout]);
  } catch (error) {
    if (error !== timeoutError) opts.revoke();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
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

export function trustedResultTerminalObservation(
  messageIds: string[],
): { messageId?: string; terminalCarrier: 'standard_reply_card' } {
  return {
    messageId: messageIds[0],
    terminalCarrier: 'standard_reply_card',
  };
}

/** Delete plugin-owned source files only after the host artifact is durable. */
export function consumeTrustedResultDeliverySources(delivery: TrustedResultDelivery): void {
  let cleanupError = false;
  for (const file of delivery.files ?? []) {
    try { unlinkSync(file.sourcePath); } catch (error: any) {
      if (error?.code !== 'ENOENT') cleanupError = true;
    }
  }
  if (cleanupError) throw new Error('host_delivery_source_cleanup_failed');
}

/**
 * Parse a plugin-requested delivery and pin every attachment to the plugin's
 * private outbound directory. The caller must invoke this only for a local
 * stdio MCP server; remote transports are intentionally ineligible.
 */
export function parseTrustedResultDelivery(
  value: unknown,
  pluginHome: string,
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
        files: opened.map(({ fd, path, name, size }) => {
          const data = readFileSync(fd);
          if (data.length !== size) throw new Error('host_delivery_file_changed_during_snapshot');
          return { name, data, sourcePath: path };
        }),
      } : {}),
      ...(responseKind ? { responseKind } : {}),
    };
  } finally {
    for (const file of opened) {
      try { closeSync(file.fd); } catch { /* already closed */ }
    }
  }
}
