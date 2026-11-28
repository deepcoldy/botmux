import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import { ProxyAgent } from 'proxy-agent';
import { BytedcliBrokerError, type BytedcliChildResult } from './bytedcli-broker-process.js';
import type { BytedcliCredentialLease } from './bytedcli-broker-credentials.js';
import type { SkillApiDescriptor } from './bytedcli-skill-api.js';
import { bytedcliHostNetworkEnvironment } from './bytedcli-host-network.js';
export interface BytedcliHostApiInvocation {
  readonly requestRoot?: string; readonly home?: string; readonly cwd?: string;
  readonly descriptor: SkillApiDescriptor; readonly lease: BytedcliCredentialLease; readonly signal: AbortSignal;
  readonly outputLimitBytes: number; readonly onDispatch: () => void; readonly reserveOutput: (bytes: number) => boolean;
}
export type BytedcliHostApiRunner = (input: BytedcliHostApiInvocation) => Promise<BytedcliChildResult>;
/** Frozen daemon networking only. Never consult Agent/process env at dispatch.
 * Node HTTPS does not follow redirects. A fresh agent prevents shared cookies. */
export function createBytedcliHostApiRunner(network: Readonly<NodeJS.ProcessEnv>, stillCurrent: () => boolean, requestTransport: typeof httpsRequest = httpsRequest): BytedcliHostApiRunner {
  const env = bytedcliHostNetworkEnvironment(network);
  const proxy = env.https_proxy ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.HTTP_PROXY ?? '';
  const noProxy = (env.no_proxy ?? env.NO_PROXY ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const proxyUrl = proxy ? new URL(proxy) : undefined;
  if (proxyUrl && !['http:', 'https:'].includes(proxyUrl.protocol) || env.SSL_CERT_DIR) throw new BytedcliBrokerError('executor_unavailable');
  const ca = Object.freeze([...(env.SSL_CERT_FILE ? [readFileSync(env.SSL_CERT_FILE, 'utf8')] : rootCertificates),
    ...(env.NODE_EXTRA_CA_CERTS ? [readFileSync(env.NODE_EXTRA_CA_CERTS, 'utf8')] : [])]);
  const proxyFor = (url: string) => {
    const target = new URL(url); const host = target.hostname.toLowerCase();
    return noProxy.some(rule => rule === '*' || rule === host || rule === `${host}:${target.port || '443'}`
      || rule.startsWith('.') && host.endsWith(rule)) ? '' : proxy;
  };
  return async input => {
    if (!stillCurrent()) throw new BytedcliBrokerError('executor_unavailable');
    if (input.signal.aborted) throw new BytedcliBrokerError('cancelled');
    const { descriptor: api, lease } = input;
    if ((lease.realm ?? 'bytecloud') !== api.realm) throw new BytedcliBrokerError('actor_identity_unverified');
    const headers = { ...api.headers, ...(api.realm === 'gdpr' ? { cookie: `permission=true; gdpr=${lease.jwt}` } : { 'x-jwt-token': lease.jwt }) };
    const body = api.body === undefined ? undefined : JSON.stringify(api.body);
    const agent = new ProxyAgent({ getProxyForUrl: proxyFor, ca: [...ca], rejectUnauthorized: true });
    try {
      return await new Promise<BytedcliChildResult>((resolve, reject) => {
        const request = requestTransport(api.url, { method: api.method, headers, agent, ca: [...ca], rejectUnauthorized: true, signal: input.signal }, response => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            response.destroy(); reject(new BytedcliBrokerError('upstream_failed')); return;
          }
          const chunks: Buffer[] = []; let size = 0;
          const sse = api.id === 'skill-api.mindai.tasks.events';
          let sseTimer: ReturnType<typeof setTimeout> | undefined;
          const finishSse = (continued = false) => {
            if (!sse) return;
            if (sseTimer) clearTimeout(sseTimer);
            if (!stillCurrent()) { response.destroy(); reject(new BytedcliBrokerError('executor_unavailable')); return; }
            const received = Buffer.concat(chunks).toString('utf8');
            const boundary = [...received.matchAll(/\r?\n\r?\n/g)].at(-1);
            const events = continued ? (boundary ? received.slice(0,boundary.index!+boundary[0].length) : '') : received;
            response.destroy(); resolve({stdout:Buffer.from(JSON.stringify({status:'success',data:{events,continued}})+'\n'),stderr:Buffer.alloc(0),exitCode:0});
          };
          if (sse) sseTimer = setTimeout(()=>finishSse(true), 15000);
          response.once('close',()=>{if(sseTimer)clearTimeout(sseTimer);});
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > input.outputLimitBytes || !input.reserveOutput(chunk.length)) {
              response.destroy(new BytedcliBrokerError('output_limit')); return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.once('error', reject);
          response.once('end', () => {
            if (sse) {finishSse();return;}
            try {
              if (!stillCurrent()) throw new BytedcliBrokerError('executor_unavailable');
              const text = Buffer.concat(chunks).toString('utf8');
              const data = api.id === 'skill-api.mindai.tasks.events' ? { events: text } : JSON.parse(text);
              if (data?.success === false || data?.error || typeof data?.code === 'number' && ![0, 200].includes(data.code)) throw new BytedcliBrokerError('upstream_failed');
              resolve({ stdout: Buffer.from(JSON.stringify({ status: 'success', data }) + '\n'), stderr: Buffer.alloc(0), exitCode: 0 });
            } catch { reject(new BytedcliBrokerError('upstream_failed')); }
          });
        });
        request.once('error', reject);
        // Fence conservatively before the first possible byte leaves the host.
        input.onDispatch(); request.end(body);
      });
    } finally { agent.destroy(); }
  };
}
