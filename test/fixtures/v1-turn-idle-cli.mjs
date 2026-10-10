/**
 * FROZEN v1 snapshot of the `botmux turn-idle` client (pre-versioned CLI).
 *
 * Not a copy of a whole CLI — an executable stand-in that reproduces exactly the
 * two v1 behaviours the version-skew regression depends on:
 *
 *   1. Its dispatch table knows ONLY the bare `turn-idle` subcommand. Nothing
 *      versioned exists, and its default branch (upstream: try a plugin command,
 *      else print help) never issues a request.
 *   2. `turn-idle` IGNORES the payload's identity and re-reads the LIVE
 *      capability/marker at exec time (upstream: readManagedOriginCapability +
 *      resolveSessionContext/BOTMUX_TURN_ID), then POSTs
 *      `{sessionId, originCapability, originTurnId, originDispatchAttempt, seq, pid}`
 *      to /api/turn-idle.
 *
 * So a v2 plugin's report, routed into this binary, becomes a claim about
 * whatever dispatch is live NOW (turn B) even though the event was turn A's —
 * the "settle a busy CLI" bug. The versioned subcommand is what makes the skew
 * fail closed instead.
 *
 * Usage: node v1-turn-idle-cli.mjs <subcommand>   (payload on stdin)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RELAY_ORIGIN_CAPABILITY_BASENAME = '.botmux-origin-capability.json';
const CLI_COMMAND = process.argv[2];

/** v1's isolated transport: the per-dispatch token file the worker rotates. */
function readRelayClaim() {
  const relayDir = process.env.BOTMUX_SEND_RELAY;
  if (!relayDir) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return undefined;
    return {
      capability: typeof parsed.capability === 'string' ? parsed.capability : parsed.token,
      turnId: typeof parsed.turnId === 'string' ? parsed.turnId : undefined,
      dispatchAttempt: Number.isSafeInteger(parsed.dispatchAttempt) && parsed.dispatchAttempt > 0
        ? parsed.dispatchAttempt
        : undefined,
    };
  } catch {
    return undefined;
  }
}

function readStdin() {
  return new Promise((resolvePromise) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => resolvePromise(text));
    process.stdin.on('error', () => resolvePromise(text));
    setTimeout(() => resolvePromise(text), 2000).unref?.();
  });
}

/** v1 `postSessionScopedSignal('/api/turn-idle', {seq, pid})`: the identity is
 *  resolved HERE, at exec time, never carried from the event. */
async function postSessionScopedSignal(payload) {
  const sessionId = process.env.BOTMUX_SESSION_ID;
  const port = Number(process.env.BOTMUX_DAEMON_IPC_PORT);
  if (!sessionId || !Number.isSafeInteger(port) || port <= 0) return;
  const claim = readRelayClaim();
  const envAttempt = Number(process.env.BOTMUX_DISPATCH_ATTEMPT);
  const body = {
    sessionId,
    originCapability: claim?.capability,
    originTurnId: claim?.turnId ?? process.env.BOTMUX_TURN_ID,
    originDispatchAttempt: claim?.dispatchAttempt
      ?? (Number.isSafeInteger(envAttempt) && envAttempt > 0 ? envAttempt : undefined),
    ...payload,
  };
  try {
    await fetch(`http://127.0.0.1:${port}/api/turn-idle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    /* v1 is fail-open: an unreachable daemon is silent */
  }
}

async function cmdTurnIdleV1() {
  const payloadText = await readStdin();
  let seq;
  let pid;
  try {
    const parsed = JSON.parse(payloadText);
    if (parsed && Number.isSafeInteger(parsed.seq) && parsed.seq > 0) seq = parsed.seq;
    if (parsed && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) pid = parsed.pid;
  } catch {
    /* no payload / not JSON → report the live identity anyway (v1 behaviour) */
  }
  await postSessionScopedSignal({ seq, pid });
}

switch (CLI_COMMAND) {
  case 'turn-idle':
    await cmdTurnIdleV1();
    process.exit(0);
    break;
  default:
    // v1's real default branch: plugin lookup by that name → not found →
    // showHelp() (usage on stdout, no request, normal exit).
    process.stdout.write(`unknown command: ${CLI_COMMAND}\n`);
    process.exit(0);
}
