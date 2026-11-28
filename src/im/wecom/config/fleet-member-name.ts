/**
 * Recognise a WeCom gateway's fleet member name (`wecomFleetMemberName`). Kept
 * dependency-free apart from the contract so modules on the daemon's startup path
 * (feedback maintenance) can tell a gateway row in fleet-state from a Feishu bot
 * daemon without loading the rest of the WeCom configuration code.
 */
import { wecomFleetMemberName } from '../contract/fleet-member.js';

const CONFIG_ID_PREFIX = /^[0-9a-f]{12}$/;

/** True when the contract maps a connection whose id starts with the name's
 *  last 12 hex digits to exactly this name. */
export function isWecomFleetMemberName(name: string): boolean {
  const idPrefix = name.slice(-12);
  return CONFIG_ID_PREFIX.test(idPrefix) && wecomFleetMemberName(idPrefix.padEnd(64, '0')) === name;
}
