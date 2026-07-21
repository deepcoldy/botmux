import { join, resolve } from 'node:path';
import { assertSafeAppId } from '../adapters/cli/read-isolation.js';
import { config } from '../config.js';

/** Per-bot attachment bucket shared by Lark downloads and Dashboard uploads. */
export function getAttachmentsDir(larkAppId: string, messageId: string): string {
  return join(resolve(config.session.dataDir), 'attachments', assertSafeAppId(larkAppId), messageId);
}
