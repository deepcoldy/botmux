import { getBot } from '../bot-registry.js';
import type { LarkAttachment } from '../types.js';
import { supportsTranscriptReplyDelivery } from '../services/structured-bridge-clis.js';

export type PromptInjection = 'default' | 'none';

/** Reuse the final-reply capability, rather than maintaining a second CLI
 * allowlist. Remote backends have their own prompt/decorate contracts. */
export function supportsZeroPromptInjection(cliId: string | undefined, opts?: {
  backendType?: string; codexRpcInput?: boolean;
}): boolean {
  return supportsTranscriptReplyDelivery(cliId)
    && (!opts?.backendType || ['pty', 'tmux', 'herdr', 'zellij', 'zmx'].includes(opts.backendType));
}

export function zeroPromptInjectionForBot(larkAppId?: string, cliId?: string): boolean {
  if (!larkAppId) return false;
  try {
    const cfg = getBot(larkAppId).config;
    return cfg.promptInjection === 'none' && supportsZeroPromptInjection(cliId ?? cfg.cliId, cfg);
  } catch {
    return false;
  }
}

/** Attachment names and paths are input data, not instructions. Deliberately
 * bypass customizable prompt fragments, even for the attachment label. */
export function buildZeroPromptInput(content: string, attachments?: LarkAttachment[]): string {
  if (!attachments?.length) return content;
  return [content, ...attachments.map(a => `[${a.type}] ${a.name}: ${a.path}`)].join('\n\n');
}
