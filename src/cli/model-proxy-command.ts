import { loadProxyConfig, proxyClients } from '../services/model-proxy/config.js';
import { startModelProxy } from '../services/model-proxy/server.js';
import { ipcInvocationBackend } from '../services/model-proxy/backend.js';
import { resolveBotmuxDataDir } from '../core/data-dir.js';

export const MODEL_PROXY_USAGE = `botmux model-proxy serve --config <path>
Start the authenticated loopback Chat Completions adapter.
Config must be a private (0600) host file. See docs/model-proxy.md.`;
export async function cmdModelProxy(args: string[]): Promise<number> {
  if (args.includes('--help') || args[0] === 'help') { console.log(MODEL_PROXY_USAGE); return 0; }
  try {
    if (args.length !== 3 || args[0] !== 'serve' || args[1] !== '--config') throw new Error(MODEL_PROXY_USAGE);
    const config = loadProxyConfig(args[2]);
    const clients = proxyClients(config, process.env);
    const dataDir = resolveBotmuxDataDir();
    // Check configured identity admission before advertising a working endpoint.
    for (const bot of new Set(Object.values(config.models).map(r => r.bot))) {
      if (!(await ipcInvocationBackend(bot, dataDir).capabilities()).supported) throw new Error('inference_profile_unsupported');
    }
    const proxy = await startModelProxy({ config, clients, backend: bot => ipcInvocationBackend(bot, dataDir) });
    console.log(JSON.stringify({ listening: `http://127.0.0.1:${proxy.port}/v1`, protocol: 'chat-completions-v1' }));
    await new Promise<void>(resolve => {
      const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); void proxy.close().then(resolve); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
    return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : 'model_proxy_failed'); return 1; }
}
