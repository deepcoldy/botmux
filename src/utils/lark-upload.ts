/**
 * Minimal Lark image uploader callable from worker process.
 * Worker doesn't load bot-registry — it gets larkAppId/larkAppSecret/brand from
 * the daemon's init message (see worker-pool.ts forkWorker / worker.ts init).
 */
import { Client, LoggerLevel } from '@larksuiteoapi/node-sdk';
import * as Lark from '@larksuiteoapi/node-sdk';
import { type Brand, sdkDomain } from '../im/lark/lark-hosts.js';
import {
  createLarkUploadHttpPool,
  isLarkTransportError,
  type LarkUploadHttpPool,
} from './lark-http-pool.js';

/** Bound both tenant-token acquisition and image upload so a stalled Lark
 * request cannot occupy the worker's screenshot single-flight indefinitely. */
const UPLOAD_TIMEOUT_MS = 30_000;

let cachedPool: LarkUploadHttpPool | null | undefined;
let cached: { client: any; appId: string; brand: Brand } | null = null;

function getClient(appId: string, secret: string, brand: Brand) {
  // 缓存 key 含 brand：同 appId 不同 brand 不复用打错域的客户端。
  if (cached && cached.appId === appId && cached.brand === brand) return cached.client;
  if (cachedPool === undefined) {
    cachedPool = createLarkUploadHttpPool(
      Lark as unknown as { defaultHttpInstance?: any },
      { timeoutMs: UPLOAD_TIMEOUT_MS },
    );
  }
  cached = {
    appId,
    brand,
    // brand → 域名。Lark bot 截图上传必须打 larksuite.com，否则 image.create 失败。
    // cachedPool 为 null（SDK 改了导出形态）时回落共享实例。
    client: new Client({
      appId,
      appSecret: secret,
      domain: sdkDomain(brand),
      loggerLevel: LoggerLevel.error,
      ...(cachedPool ? { httpInstance: cachedPool.instance } : {}),
    }),
  };
  return cached.client;
}

export async function uploadImageBuffer(appId: string, secret: string, buf: Buffer, brand: Brand = 'feishu'): Promise<string> {
  const c = getClient(appId, secret, brand);
  try {
    const res = await c.im.v1.image.create({
      data: { image_type: 'message', image: buf },
    });
    const key = res?.image_key;
    if (!key) throw new Error(`upload failed: ${JSON.stringify(res)}`);
    return key;
  } catch (err) {
    // Drop the pool after a transport-level failure so a wedged keep-alive
    // socket is never reused by the next screenshot upload. See
    // lark-http-pool.ts for the production failure this guards against.
    if (isLarkTransportError(err)) {
      try {
        cachedPool?.httpAgent.destroy();
      } catch {
        // best effort
      }
      try {
        cachedPool?.httpsAgent.destroy();
      } catch {
        // best effort
      }
      cachedPool = undefined;
      cached = null;
    }
    throw err;
  }
}
