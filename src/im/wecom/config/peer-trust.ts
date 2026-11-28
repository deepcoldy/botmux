/**
 * Trust between the WeCom connections of one host: the same rule as the Feishu
 * 「信任同一 owner 的同机 Bot」. It is used for, and only for, starting a new
 * session in a peer's directory (`directory`) and the quota-limit hand-over
 * (`fallback`, then its `result` / `interrupt`); it carries no permission.
 *
 * Both ends judge with the same pure function at every step: the source before
 * it sends a request (standing in the target's place, with the target's
 * configuration file), the target when it accepts one, fetches a result or
 * interrupts. Nothing is remembered between steps, so a configuration change
 * — allowed users, a switch, a removed connection — takes effect at the next
 * step. The Dashboard lists hand-over targets with it too.
 *
 * User ids and conversation ids are compared as they are: the connections of
 * one enterprise see the same ids. The gateway has no enterprise identifier
 * (no corpid reaches it), so two connections of different enterprises whose
 * allowed users happen to share user ids are not told apart.
 */
import { readFileSync } from 'node:fs';
import { parseWecomConfig, type WecomConfig } from './config.js';
import { readWecomConfigPaths, wecomConfigId, wecomRoot } from './discovery.js';

export type WecomPeerOperation = 'directory' | 'fallback' | 'result' | 'interrupt';

/** What one connection contributes to the rule (allowed users after parseWecomConfig). */
export interface WecomPeerSide {
  allowedUsers: readonly string[];
  blockedUsers?: readonly string[];
  /** Unset = on. */
  trustSameOwnerBots?: boolean;
  /** Unset = on. */
  botToBotSameDir?: boolean;
}

/**
 * Whether the target connection accepts a request from the source connection.
 * `undefined` for either side means it is not a WeCom connection configured
 * (and readable) on this host. All of these must hold:
 *  1. the target has not switched trustSameOwnerBots off;
 *  2. both are connections of this host, and not the same one;
 *  3. both have allowed users, and every allowed user of the source is an
 *     allowed (and not blocked) user of the target — one user the target does
 *     not know is enough to refuse;
 *  4. for `directory`, the target has not switched botToBotSameDir off.
 * The requesting user's own access on the target (denied users, quota) is
 * checked by the target separately.
 */
export function wecomPeerAccepts(input: {
  target: WecomPeerSide | undefined;
  source: WecomPeerSide | undefined;
  sameConnection: boolean;
  operation: WecomPeerOperation;
}): boolean {
  const { target, source } = input;
  if (!target || !source || input.sameConnection || target.trustSameOwnerBots === false) {
    return false;
  }
  const known = new Set(target.allowedUsers.filter(user => !target.blockedUsers?.includes(user)));
  return source.allowedUsers.length > 0
    && known.size > 0
    && source.allowedUsers.every(user => known.has(user))
    && (input.operation !== 'directory' || target.botToBotSameDir !== false);
}

export function wecomPeerSide(config: WecomConfig): WecomPeerSide {
  return {
    allowedUsers: config.allowedUsers,
    blockedUsers: config.blockedUsers,
    trustSameOwnerBots: config.native?.trustSameOwnerBots,
    botToBotSameDir: config.native?.botToBotSameDir,
  };
}

/** The WeCom connections configured on this host whose configuration parses, by configuration id. */
export function readLocalWecomConnections(root = wecomRoot()): Array<{ id: string; config: WecomConfig }> {
  const connections: Array<{ id: string; config: WecomConfig }> = [];
  for (const file of readWecomConfigPaths(root)) {
    try {
      connections.push({ id: wecomConfigId(file), config: parseWecomConfig(JSON.parse(readFileSync(file, 'utf8'))) });
    } catch { /* missing or unreadable configuration: not a peer */ }
  }
  return connections;
}

/** One connection of this host by configuration id; undefined when it is not configured or does not parse. */
export function readLocalWecomConnection(id: string, root = wecomRoot()): WecomConfig | undefined {
  const file = readWecomConfigPaths(root).find(path => wecomConfigId(path) === id);
  if (!file) {
    return undefined;
  }
  try {
    return parseWecomConfig(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}
