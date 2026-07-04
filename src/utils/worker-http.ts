import type { IncomingMessage } from 'node:http';

type EnvLike = Partial<Record<string, string | undefined>>;

export function getConfiguredWorkerHttpHost(env: EnvLike = process.env): string | undefined {
  const raw = env.BOTMUX_WORKER_HTTP_HOST ?? env.BOTMUX_WORKER_HOST;
  const host = raw?.trim();
  return host || undefined;
}

export function resolveWorkerHttpHost(env: EnvLike = process.env): string {
  // Default to all-interfaces (matches the historical hardcoded worker bind)
  // and only narrow when an explicit worker-host knob is set. Deliberately does
  // NOT inherit WEB_HOST: the daemon terminal reverse proxy always dials the
  // worker at 127.0.0.1, so binding the worker to a specific non-loopback
  // WEB_HOST IP would make every `/s/{sessionId}` terminal (and the direct
  // workflow terminal) unreachable. To confine the worker, set an explicit
  // BOTMUX_WORKER_HTTP_HOST instead.
  return getConfiguredWorkerHttpHost(env) ?? '0.0.0.0';
}

export function parseWorkerRequestUrl(req: Pick<IncomingMessage, 'url' | 'headers'>): URL | null {
  const host = typeof req.headers.host === 'string' && req.headers.host.trim()
    ? req.headers.host.trim()
    : 'localhost';
  try {
    return new URL(req.url ?? '/', `http://${host}`);
  } catch {
    return null;
  }
}
