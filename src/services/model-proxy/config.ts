import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { readSecureHostFileSync } from '../../platform/secure-host-file.js';
import { invocationRequest } from '../constrained-invocation/contract.js';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const route = z.object({ bot: identifier, model: z.string().min(1).max(200),
  reasoningEffort: invocationRequest.shape.reasoningEffort,
  deadlineMs: z.number().int().min(100).max(300_000).default(120_000),
}).strict();
export const proxyConfigSchema = z.object({
  host: z.literal('127.0.0.1').default('127.0.0.1'), port: z.number().int().min(0).max(65535).default(8788),
  models: z.record(route).refine(m => Object.keys(m).length > 0 && Object.keys(m).every(k => k.length > 0 && k.length <= 200)),
  clients: z.array(z.object({ id: identifier, tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/), models: z.array(z.string()).min(1) }).strict()).min(1).max(100),
}).strict();
export type ProxyConfig = z.infer<typeof proxyConfigSchema>;
export interface ProxyClient { id: string; tokenHash: Buffer; models: string[] }
export function proxyClients(config: ProxyConfig, env: NodeJS.ProcessEnv): ProxyClient[] {
  const ids = new Set<string>(); const tokens = new Set<string>();
  return config.clients.map(c => {
    const token = env[c.tokenEnv];
    if (!token || token.length < 32 || /\s/.test(token)) throw new Error('model_proxy_token_requires_32_nonwhitespace_characters');
    if (ids.has(c.id) || tokens.has(token) || c.models.some(m => !Object.hasOwn(config.models, m))) throw new Error('invalid_model_proxy_client');
    ids.add(c.id); tokens.add(token);
    return { id: c.id, tokenHash: createHash('sha256').update(token).digest(), models: c.models };
  });
}
export function authenticate(clients: ProxyClient[], authorization: string | undefined): ProxyClient | undefined {
  if (!authorization?.startsWith('Bearer ') || authorization.length > 4096) return undefined;
  const hash = createHash('sha256').update(authorization.slice(7)).digest();
  return clients.find(client => timingSafeEqual(hash, client.tokenHash));
}
export function loadProxyConfig(path: string): ProxyConfig {
  const raw = readSecureHostFileSync(path);
  if (raw === null) throw new Error('model_proxy_config_missing');
  return proxyConfigSchema.parse(JSON.parse(raw));
}
