/**
 * Standalone end-to-end verification for the host-overload alert. Imports the
 * REAL src/ modules (not dist), reads the REAL current host load/mem, runs the
 * REAL evaluateOverload decision, and — if we force an overload reading — sends
 * the REAL formatted Feishu DM through the same sendUserMessage path the daemon
 * watcher uses. Does NOT touch live dist/ and does NOT restart any daemon.
 *
 * Usage: tsx scripts/verify-overload-alert.ts <ownerOpenId>
 */
import { loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { sendUserMessage, resolveAllowedUsersWithMap } from '../src/im/lark/client.js';
import {
  evaluateOverload,
  buildOverloadAlertCard,
  initialOverloadCardState,
  DEFAULT_OVERLOAD_THRESHOLDS,
  INITIAL_OVERLOAD_STATE,
  type OverloadThresholds,
} from '../src/core/host-overload-alert.js';
import { registerOverloadNonce } from '../src/im/lark/overload-nonce.js';
import { loadavg, cpus, totalmem, freemem } from 'node:os';
import { randomUUID } from 'node:crypto';

async function main() {
  const wantAppId = process.argv[2]; // bot whose OWN owner (allowedUsers) gets the DM — mirrors daemon
  if (!wantAppId) {
    console.error('usage: tsx scripts/verify-overload-alert.ts <larkAppId>');
    process.exit(2);
  }

  const cfgs = loadBotConfigs();
  if (cfgs.length === 0) { console.error('no bots configured'); process.exit(1); }
  const cfg = cfgs.find(c => c.larkAppId === wantAppId);
  if (!cfg) { console.error(`bot ${wantAppId} not found`); process.exit(1); }
  registerBot(cfg);
  console.log(`[verify] using bot ${cfg.larkAppId} (${cfg.displayName ?? cfg.name ?? ''})`);

  // Resolve THIS bot's owner exactly like the daemon does (union_id/email → this
  // app's open_id). This is the same path resolvePrimaryOwnerOpenId relies on.
  const { resolved } = await resolveAllowedUsersWithMap(cfg.larkAppId, cfg.allowedUsers ?? []);
  const ownerOpenId = resolved.find(u => u.startsWith('ou_'));
  if (!ownerOpenId) { console.error('[verify] no resolvable owner open_id'); process.exit(1); }
  console.log(`[verify] resolved owner=${ownerOpenId}`);

  const cpuCount = Math.max(1, cpus().length || 1);
  const thresholds: OverloadThresholds = { cpuCount, ...DEFAULT_OVERLOAD_THRESHOLDS };

  // 1) Real current reading — show what the watcher would see right now.
  const realReading = {
    load15: loadavg()[2] ?? 0,
    memTotalBytes: totalmem(),
    memFreeBytes: freemem(),
  };
  console.log(`[verify] REAL host: load15=${realReading.load15.toFixed(2)} cpu=${cpuCount} `
    + `perCpu=${(realReading.load15 / cpuCount).toFixed(2)} `
    + `memUsed=${(((realReading.memTotalBytes - realReading.memFreeBytes) / realReading.memTotalBytes) * 100).toFixed(0)}%`);
  const realEval = evaluateOverload(INITIAL_OVERLOAD_STATE, realReading, thresholds, Date.now());
  console.log(`[verify] REAL eval → overloaded=${realEval.nextState.overloaded} action=${realEval.action?.kind ?? 'none'}`);

  // 2) Decide what to render: if the real reading already trips overload, use
  //    that real alert. Otherwise synthesize a representative overload reading
  //    so the owner can SEE the exact card the watcher emits.
  const evalToSend = realEval.action
    ? realEval
    : evaluateOverload(
        INITIAL_OVERLOAD_STATE,
        { load15: cpuCount * 2.3, memTotalBytes: realReading.memTotalBytes, memFreeBytes: realReading.memFreeBytes },
        thresholds,
        Date.now(),
      );
  if (!evalToSend.action) { console.error('[verify] no action to send — unexpected'); process.exit(1); }

  const synthetic = !realEval.action;
  // Send the INTERACTIVE card (what the daemon watcher now emits). NOTE: this
  // standalone script's nonce store is separate from the running daemon's, so a
  // button click on THIS card resolves against the daemon — which only knows the
  // nonce after a rebuild+restart ships the watcher that registered it. So this
  // proves the card RENDERS correctly; live button clicks need the daemon build.
  const nonce = randomUUID();
  registerOverloadNonce(nonce); // for symmetry / local demonstration only
  // Demo counts so the buttons show「(N)」— the live watcher computes these via
  // countHostOverload(); here we just show representative numbers.
  const st = initialOverloadCardState(evalToSend.action, { stopped: 2, idle: 5 }, nonce);
  const cardObj = JSON.parse(buildOverloadAlertCard(st));
  if (synthetic) cardObj.elements.unshift({ tag: 'note', elements: [{ tag: 'lark_md', content: '【验证/演示 — 非真实告警，按钮需 daemon 重启后才生效】' }] });
  const mid = await sendUserMessage(cfg.larkAppId, ownerOpenId, JSON.stringify(cardObj), 'interactive');
  console.log(`[verify] interactive card sent message_id=${mid} synthetic=${synthetic} nonce=${nonce}`);
}

main().catch((e) => { console.error('[verify] failed:', e?.message ?? e); process.exit(1); });
