/**
 * Minimal Lark image uploader callable from worker process.
 * Worker doesn't load bot-registry — it gets larkAppId/larkAppSecret/brand from
 * the daemon's init message (see worker-pool.ts forkWorker / worker.ts init).
 */
import { Client, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { type Brand, sdkDomain } from '../im/lark/lark-hosts.js';

let cached: { client: any; appId: string; brand: Brand } | null = null;

function getClient(appId: string, secret: string, brand: Brand) {
  // 缓存 key 含 brand：同 appId 不同 brand 不复用打错域的客户端。
  if (cached && cached.appId === appId && cached.brand === brand) return cached.client;
  cached = {
    appId,
    brand,
    // brand → 域名。Lark bot 截图上传必须打 larksuite.com，否则 image.create 失败。
    client: new Client({ appId, appSecret: secret, domain: sdkDomain(brand), loggerLevel: LoggerLevel.error }),
  };
  return cached.client;
}

export async function uploadImageBuffer(appId: string, secret: string, buf: Buffer, brand: Brand = 'feishu'): Promise<string> {
  const c = getClient(appId, secret, brand);
  const res = await c.im.v1.image.create({
    data: { image_type: 'message', image: buf },
  });
  const key = res?.image_key;
  if (!key) throw new Error(`upload failed: ${JSON.stringify(res)}`);
  return key;
}
