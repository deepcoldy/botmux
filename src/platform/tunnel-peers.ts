/**
 * Which loopback connections into the dashboard were opened by the platform
 * tunnel.
 *
 * The tunnel splices platform traffic onto a plain loopback TCP connection to
 * this process's dashboard server, so at the HTTP layer a request that came
 * through the platform is indistinguishable from one sent on this machine.
 * Headers the platform injects — `X-Botmux-Actor`, the union_id of the person
 * its Feishu SSO signed in — are therefore only as trustworthy as our ability
 * to tell those two apart: anyone holding the local dashboard token can send
 * the same header directly.
 *
 * The bridge knows the local port of every connection it opens. The dashboard
 * compares a request's peer address and port against that set. A local client
 * cannot occupy a live bridge's (address, port) pair, and a port is forgotten
 * the moment its bridge connection closes.
 */
const bridgedPorts = new Map<number, symbol>();

/** Record a bridge connection's local port; returns its removal. The removal
 *  only clears its own registration: once a closed bridge's port has been
 *  reused by a newer bridge, the old close must not unregister the new one. */
export function registerPlatformTunnelBridge(localPort: number | undefined): () => void {
  if (typeof localPort !== 'number' || !Number.isInteger(localPort) || localPort <= 0) return () => {};
  const registration = Symbol('platform-tunnel-bridge');
  bridgedPorts.set(localPort, registration);
  return () => {
    if (bridgedPorts.get(localPort) === registration) bridgedPorts.delete(localPort);
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1']);

/** True only when `socket` is the dashboard end of a live platform bridge. */
export function isPlatformTunnelPeer(
  socket: { remoteAddress?: string | null; remotePort?: number | null } | undefined,
): boolean {
  if (!socket?.remoteAddress || !LOOPBACK.has(socket.remoteAddress)) return false;
  return typeof socket.remotePort === 'number' && bridgedPorts.has(socket.remotePort);
}
