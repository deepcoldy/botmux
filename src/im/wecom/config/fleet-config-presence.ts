/**
 * "Is there a WeCom configuration on this host?" — the WeCom half of the CLI's
 * hasConfig(). A host configured only for WeCom has no bots.json and no
 * ~/.botmux/.env, and without this `botmux start` / `restart`, autostart and the
 * watchdog refuse to run on it.
 *
 * Stricter than fleet membership on purpose: a registered file only counts when
 * it parses as a WeCom configuration, so a stray or broken file does not make an
 * otherwise unconfigured host look configured.
 */
import { readFileSync } from 'node:fs';
import { parseWecomConfig } from './config.js';
import { readWecomConfigPaths, wecomRoot } from './discovery.js';

export function hasParsableWecomConfig(root = wecomRoot()): boolean {
  for (const file of readWecomConfigPaths(root)) {
    try {
      parseWecomConfig(JSON.parse(readFileSync(file, 'utf8')));
      return true;
    } catch {
      // Missing, unreadable or invalid: try the next registered file.
    }
  }
  return false;
}
