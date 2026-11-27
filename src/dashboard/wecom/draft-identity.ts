import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock } from '../../utils/file-lock.js';
import { wecomBotRoot } from '../../im/wecom/config/runtime.js';
import {
  runIdentityChallenge,
  type WecomDraftIdentifyOptions,
  type WecomDraftIdentity,
} from '../../im/wecom/protocol/identity-challenge.js';

/** Draft credentials never enter config, core, task execution, or a message send path. */
export async function pairDraftWecomIdentity(options: WecomDraftIdentifyOptions): Promise<WecomDraftIdentity> {
  if (!options.botId || !options.secret || options.botId.length > 4096 || options.secret.length > 4096
    || /[\s\x00-\x1f\x7f]/.test(options.botId + options.secret)) {
    throw new Error('wecom_identify_invalid_credentials');
  }
  const botRoot = wecomBotRoot(options.botId);
  mkdirSync(botRoot, { recursive: true, mode: 0o700 });
  return withFileLock(join(botRoot, 'instance'), () => runIdentityChallenge(options), { maxWaitMs: 100 });
}
