import { runMemoryCommand } from '../lib/memory.mjs';

export default {
  async openviking(ctx, api) {
    const config = api.config.get();
    const appId = process.env.BOTMUX_LARK_APP_ID;
    const clientConfig = config?.bots?.[appId]?.clientConfig;
    if (!clientConfig) throw new Error('Configure this single-user Bot with setup-shared.mjs before enabling OpenViking.');
    const result = await runMemoryCommand(ctx.args, { config: clientConfig, cwd: process.cwd() });
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  },
};
