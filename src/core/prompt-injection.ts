import { getBot } from '../bot-registry.js';
import { config } from '../config.js';
import { resolvePairedBackendId } from './remote-cli-ids.js';
import type { LarkAttachment } from '../types.js';
import type { DaemonSession } from './types.js';

export type PromptInjection = 'default' | 'none';

export {
  isScratchSandbox,
  supportsZeroPromptInjection,
  type ZeroPromptSandboxValue,
} from './zero-prompt-support.js';
import { supportsZeroPromptInjection } from './zero-prompt-support.js';

export function sessionPromptInjection(ds: Pick<DaemonSession, 'session' | 'initConfig'>): PromptInjection {
  // Historical/adopted sessions predate this setting and retain their original
  // input contract. A live worker snapshot also covers an in-place upgrade.
  return ds.session.promptInjection ?? ds.initConfig?.promptInjection ?? 'default';
}

/**
 * 按 Bot 配置判断零注入能否成立。后端按新会话 spawn 时的**生效值**：覆盖值，否则 daemon
 * 默认后端，再按 CLI 配对（本地 CLI 落在远端后端上会回落到本地后端）——与 bot-config-store
 * 的写入校验、spawnCli 的强制校验同一口径，避免「写入接受、提示词构造却按未开启处理」。
 */
export function supportsZeroPromptInjectionForBot(
  cliId: string | undefined,
  cfg: NonNullable<Parameters<typeof supportsZeroPromptInjection>[1]>,
): boolean {
  return supportsZeroPromptInjection(cliId, {
    ...cfg,
    backendType: resolvePairedBackendId(cliId, cfg.backendType, config.daemon.backendType),
  });
}

export function zeroPromptInjectionForBot(larkAppId?: string, cliId?: string, frozen?: PromptInjection): boolean {
  if (frozen !== undefined) return frozen === 'none';
  if (!larkAppId) return false;
  try {
    const cfg = getBot(larkAppId).config;
    return cfg.promptInjection === 'none' && supportsZeroPromptInjectionForBot(cliId ?? cfg.cliId, cfg);
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
