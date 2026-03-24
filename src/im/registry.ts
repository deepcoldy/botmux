import type { ImAdapter } from './types.js';
import type { BotConfig } from '../bot-registry.js';
import { LarkImAdapter } from './lark/adapter.js';
import { WeixinImAdapter } from './weixin/adapter.js';

export function createImAdapter(config: BotConfig): ImAdapter {
  switch (config.im) {
    case 'lark':
      return new LarkImAdapter(config.larkAppId, config.larkAppSecret);
    case 'weixin':
      return new WeixinImAdapter();
    default:
      throw new Error(`Unknown IM type: ${(config as any).im}`);
  }
}
