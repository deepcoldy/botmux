import { basename, isAbsolute, join, resolve } from 'node:path';
import { assertSafeAppId } from '../adapters/cli/read-isolation.js';
import { config } from '../config.js';

/** Overrides the attachment root for one host process. The sandbox relay sets
 *  it when it runs `quoted` for a sandbox: downloads then land in a directory
 *  the sandbox cannot reach (the shared bucket is sandbox-writable), and only
 *  the bytes are handed back. */
export const ATTACHMENTS_ROOT_ENV = 'BOTMUX_ATTACHMENTS_ROOT';

export function attachmentsRoot(env: NodeJS.ProcessEnv = process.env, dataDir = config.session.dataDir): string {
  const override = env[ATTACHMENTS_ROOT_ENV]?.trim();
  return override && isAbsolute(override) ? resolve(override) : join(resolve(dataDir), 'attachments');
}

/** A Lark-supplied file name as one path segment inside the message directory:
 *  never a traversal (`../x`, `..`), never empty. */
export function safeAttachmentFileName(name: string | undefined, fallback: string): string {
  const base = basename((name ?? '').replace(/\0/g, ''));
  return base === '' || base === '.' || base === '..' ? fallback : base;
}

/** Per-bot attachment bucket shared by Lark downloads and Dashboard uploads. */
export function getAttachmentsDir(larkAppId: string, messageId: string): string {
  return join(attachmentsRoot(), assertSafeAppId(larkAppId), messageId);
}
