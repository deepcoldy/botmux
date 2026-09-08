/**
 * Process-level daemon loader harness.
 *
 * It deliberately runs in a real child process, loads one durable bots.json
 * slot through the production registry API, records the effective runtime
 * config, and optionally crashes once so FleetSupervisor must respawn it.
 * argv: <botIndex> <observationDir> [crash-once]
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBotConfigAtIndex } from '../../src/bot-registry.js';

const [rawIndex, observationDir, crashMode] = process.argv.slice(2);
const botIndex = Number(rawIndex);
const config = loadBotConfigAtIndex(botIndex);
const observationPath = join(observationDir, `bot-${botIndex}.ndjson`);
appendFileSync(observationPath, `${JSON.stringify({
  pid: process.pid,
  appId: config.larkAppId,
  quotaFallbackBot: config.quotaFallbackBot ?? null,
})}\n`);

const crashMarker = join(observationDir, `bot-${botIndex}.crashed`);
if (crashMode === 'crash-once' && !existsSync(crashMarker)) {
  writeFileSync(crashMarker, String(process.pid));
  process.exit(1);
}

process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1_000);
