import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface ChatManagerClaim {
  schemaVersion: 1;
  larkAppId: string;
  chatId: string;
  enabled: boolean;
  originalName: string;
  managedName: string;
}

function key(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function root(): string {
  return join(config.session.dataDir, 'chat-managers');
}

function claimPath(app: string, chat: string): string {
  return join(root(), `${key(`${app}\0${chat}`)}.json`);
}

export function readManagerClaim(app: string, chat: string): ChatManagerClaim | undefined {
  try {
    const claim = JSON.parse(readFileSync(claimPath(app, chat), 'utf8'));
    if (claim?.schemaVersion !== 1 || claim.larkAppId !== app || claim.chatId !== chat
      || typeof claim.enabled !== 'boolean' || typeof claim.originalName !== 'string'
      || typeof claim.managedName !== 'string') throw new Error('invalid_local_claim');
    return claim;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function writeManagerClaim(claim: ChatManagerClaim): void {
  mkdirSync(root(), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(claimPath(claim.larkAppId, claim.chatId), JSON.stringify(claim), {
    mode: 0o600, durable: true, followTargetSymlink: false,
  });
}

/** Shared by bots on this host. Remote hosts still arbitrate through Lark. */
export function managerLockPath(chat: string): string {
  mkdirSync(root(), { recursive: true, mode: 0o700 });
  return join(root(), `chat-${key(chat)}`);
}

export function parseManagerDescription(description: string): { humanText: string; appId?: string } {
  const lines = description.split('\n');
  const markers = lines.map((line, index) => ({ index, match: /^\[botmux:manager=([A-Za-z0-9_-]+)\]$/.exec(line) }))
    .filter(item => item.match);
  if (markers.length > 1) throw new Error('ambiguous_manager_marker');
  const marker = markers[0];
  if (!marker) return { humanText: description };
  return { humanText: lines.filter((_, i) => i !== marker.index).join('\n'), appId: marker.match![1] };
}
