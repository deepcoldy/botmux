import type { WebSocket } from 'ws';

export const WS_HEARTBEAT_INTERVAL_MS = 60_000;

export interface WsHeartbeat {
  /** Track a server-side socket until it closes. */
  watch(ws: WebSocket): void;
  stop(): void;
}

/**
 * Reap server-side sockets whose peer vanished without a FIN (phone asleep,
 * network dropped). Bun <=1.4.3 did this implicitly: its ws server pinged at
 * ~104s and closed a silent peer at 120s. Bun 1.4.4's rewritten ws port, like
 * npm ws, has no idle timeout at all, so such a socket stays registered forever
 * and keeps whatever it pins (a tmux attach PTY, a host PTY, a web-terminal
 * gate) alive with it.
 *
 * Every interval each watched socket is pinged; one that sent nothing back
 * (pong or message) during the previous interval is terminate()d, which fires
 * its own 'close' handlers. A dead peer is therefore reaped within one to two
 * intervals.
 */
export function startWsHeartbeat(intervalMs = WS_HEARTBEAT_INTERVAL_MS): WsHeartbeat {
  const heardSinceLastTick = new Map<WebSocket, boolean>();
  const timer = setInterval(() => {
    for (const [ws, heard] of heardSinceLastTick) {
      if (!heard) {
        heardSinceLastTick.delete(ws);
        try { ws.terminate(); } catch { /* already gone */ }
        continue;
      }
      heardSinceLastTick.set(ws, false);
      try { ws.ping(); } catch { /* closing */ }
    }
  }, intervalMs);
  timer.unref?.();
  return {
    watch(ws) {
      heardSinceLastTick.set(ws, true);
      const markHeard = () => {
        if (heardSinceLastTick.has(ws)) heardSinceLastTick.set(ws, true);
      };
      ws.on('pong', markHeard);
      ws.on('message', markHeard);
      ws.once('close', () => heardSinceLastTick.delete(ws));
    },
    stop() {
      clearInterval(timer);
      heardSinceLastTick.clear();
    },
  };
}
